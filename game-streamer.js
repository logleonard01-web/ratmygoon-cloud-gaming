// ==========================================
// CLOUD GAME SIGNALING SERVER
// ==========================================
//
// This replaces the old Playwright/screenshot-streaming approach with a
// direct connection to RaccoonGame's own cloud-gaming infrastructure:
//
//   1. Spin up a disposable RaccoonGame account via their public API
//      (using mtempmail.com for the verification code) - no browser
//      automation involved.
//   2. Ask RaccoonGame's API to launch the requested game. This hands back
//      a WebRTC signaling endpoint + ICE servers for that specific session.
//   3. Relay WebRTC signaling between our client and RaccoonGame's own
//      signaling server. The client's browser then opens a real
//      RTCPeerConnection straight to RaccoonGame's game servers - real
//      video/audio tracks and a real low-latency input data channel,
//      instead of us faking mouse events into a headless browser.
//
// (Approach informed by the x8rr/stratus-api project, which reverse-engineered
// RaccoonGame's client protocol. Per its license: "This website uses Stratus
// API to provide some of its services" should be displayed somewhere visible
// on any site using this integration.)

const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const RACCOON_HOST = "https://www.raccoongame.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SESSION_SECONDS = 20 * 60;
const QUEUE_POLL_INTERVAL_MS = 3_000;
const RACCOON_PING_INTERVAL_MS = 30_000;
const POOL_TARGET = 20;

const activeSessions = new Map();
const accountPool = [];
let poolFillInterval = null;

// ------------------------------------------
// Small HTTP helpers
// ------------------------------------------

async function fetchWithTimeout(url, opts = {}, ms = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function randomToken(length = 12) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
    let out = "";
    for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

function generateDeviceSn() {
    return crypto.randomUUID().replace(/-/g, "");
}

// RaccoonGame's own web client decrypts certain API fields with a fixed
// AES-256-CBC key/IV. This is required to read their session payloads -
// it isn't a secret of ours, just part of talking to their API.
function decryptRaccoonPayload(base64Result) {
    const key = Buffer.from("fd39e724f7c1e4b3d34bc7c72b5349c3", "utf8");
    const iv = Buffer.from("dd39e4a3337fe25a", "utf8");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const json = decipher.update(base64Result, "base64", "utf8") + decipher.final("utf8");
    return JSON.parse(json);
}

// ------------------------------------------
// Disposable account creation (mtempmail.com + RaccoonGame)
// ------------------------------------------

const MTEMPMAIL_API_KEY = "pub_nRn1hUwpdmZvxQNVWDfoXgKyF7dIm9nRIIIt1qDw";
const MTEMPMAIL_BASE = "https://mtempmail.com/api";

async function createTempMailbox() {
    const res = await fetchWithTimeout(`${MTEMPMAIL_BASE}/emails/${MTEMPMAIL_API_KEY}`, {
        method: "POST",
    });
    const data = await res.json();
    if (!data.status || !data.data?.email) {
        throw new Error("Failed to create temporary mailbox: " + JSON.stringify(data));
    }
    console.log("Created temp mailbox:", data.data.email);
    return data.data.email;
}

async function getMailVerificationCode(mailAddress, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const listRes = await fetchWithTimeout(`${MTEMPMAIL_BASE}/messages/${MTEMPMAIL_API_KEY}/${encodeURIComponent(mailAddress)}`);
            const list = await listRes.json();
                        
            if (list.status && list.messages && list.messages.length > 0) {
                const first = list.messages[0];
                const plain = (first.content || first.subject || "").replace(/<[^>]*>/g, "");
                // Handle special characters around the code like 【 867044 】
                const match = plain.match(/\d{6}/);
                if (match) {
                    return match[0];
                }
            }
        } catch (error) {
            console.log(`[mail] Error on check ${i + 1}:`, error.message);
            // keep retrying until maxAttempts is exhausted
        }
    }
    throw new Error("Timed out waiting for the verification email");
}

function deviceFields(sn) {
    return {
        sn,
        model: "Chrome/128.0.0.0",
        version_code: "1",
        version_name: "1.0.0",
        device_name: "Web Client",
        os: "web",
    };
}

async function createTempAccount() {
    const accountPassword = randomToken();
    const sn = generateDeviceSn();
    const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };

    // Create a temporary mailbox using mtempmail.com
    const mailAddress = await createTempMailbox();

    await fetchWithTimeout(`${RACCOON_HOST}/users/sendEmail`, {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({ email: mailAddress, type: "register", ...deviceFields(sn) }),
    });

    const code = await getMailVerificationCode(mailAddress);

    await fetchWithTimeout(`${RACCOON_HOST}/users/emailRegister`, {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({
            email: mailAddress,
            code,
            password: accountPassword,
            phone: "1",
            country: "Brazil",
            ...deviceFields(sn),
        }),
    });

    const loginRes = await fetchWithTimeout(`${RACCOON_HOST}/users/emailLogin`, {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({ email: mailAddress, password: accountPassword, ...deviceFields(sn) }),
    });
    const loginData = await loginRes.json();
    if (loginData.status !== 200) throw new Error("RaccoonGame account login failed");

    let userToken = loginData.data?.user_token || "";
    const setCookie = loginRes.headers.get("set-cookie");
    const cookieMatch = setCookie ? setCookie.match(/as_user_token=([^;]+)/) : null;
    if (cookieMatch) userToken = cookieMatch[1];
    if (!userToken) throw new Error("RaccoonGame did not return a session token");

    return { sn, token: userToken };
}

// ------------------------------------------
// Account pool management
// ------------------------------------------

async function fillPool() {
    while (accountPool.length < POOL_TARGET) {
        try {
            console.log(`[pool] filling account (${accountPool.length}/${POOL_TARGET})`);
            const account = await createTempAccount();
            accountPool.push(account);
            console.log(`[pool] ready (${accountPool.length}/${POOL_TARGET})`);
        } catch (error) {
            console.error(`[pool] fill error — ${error.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

function getAccountFromPool() {
    if (accountPool.length > 0) {
        const account = accountPool.shift();
        console.log(`[pool] served account (${accountPool.length} remaining)`);
        return account;
    }
    console.log(`[pool] miss — creating account on demand`);
    return null;
}

function returnAccountToPool(account) {
    if (accountPool.length < POOL_TARGET) {
        accountPool.push(account);
        console.log(`[pool] returned account (${accountPool.length}/${POOL_TARGET})`);
    }
}

function startPoolFiller() {
    fillPool();
    poolFillInterval = setInterval(fillPool, 60_000);
}

// ------------------------------------------
// RaccoonGame game-session API
// ------------------------------------------

function raccoonHeaders(token) {
    return {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: `as_user_token=${token}`,
        origin: RACCOON_HOST,
        referer: `${RACCOON_HOST}/`,
        "x-requested-with": "XMLHttpRequest",
    };
}

function sessionFields(sn, token) {
    return { ...deviceFields(sn), user_token: token };
}

async function requestGameLaunch(sn, token, gameKey) {
    const headers = raccoonHeaders(token);
    const fields = sessionFields(sn, token);

    // RaccoonGame wants a cost-check call before actually launching.
    await fetchWithTimeout(`${RACCOON_HOST}/userGame/checkCost`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ ...fields, game_key: gameKey }),
    });

    const playRes = await fetchWithTimeout(`${RACCOON_HOST}/jyapi/playGame`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ ...fields, game_key: gameKey, model_name: fields.model }),
    });
    const playData = await playRes.json();

    if (playData.status === 201 || (playData.status === 200 && playData.data?.play_queue_id)) {
        return {
            queued: true,
            queueId: playData.data?.play_queue_id,
            queuePos: playData.data?.queue_pos ?? 1,
        };
    }
    if (playData.status === 200 && playData.data?.result) {
        return { queued: false, serverData: decryptRaccoonPayload(playData.data.result) };
    }
    throw new Error(`Unexpected response starting the game (status ${playData.status})`);
}

async function pollGameQueue(sn, token, queueId) {
    const res = await fetchWithTimeout(`${RACCOON_HOST}/jyapi/playQueue`, {
        method: "POST",
        headers: raccoonHeaders(token),
        body: new URLSearchParams({ ...sessionFields(sn, token), play_queue_id: queueId }),
    });
    const data = await res.json();
    if (data.status !== 200 && data.status !== 201) throw new Error("Queue check was rejected");
    return data.data?.queue_pos ?? 1;
}

async function claimGameSlot(sn, token, gameKey, queueId) {
    const res = await fetchWithTimeout(`${RACCOON_HOST}/jyapi/playGame`, {
        method: "POST",
        headers: raccoonHeaders(token),
        body: new URLSearchParams({
            ...sessionFields(sn, token),
            game_key: gameKey,
            model_name: "Chrome/128.0.0.0",
            play_queue_id: queueId,
        }),
    });
    const data = await res.json();
    if (data.status === 200 && data.data?.result) return decryptRaccoonPayload(data.data.result);
    throw new Error("Failed to claim the queued game slot");
}

// RaccoonGame expects a periodic "cost" heartbeat while a session is
// actually playing, or it will consider the session abandoned and tear it
// down server-side after a short timeout.
async function sendCostHeartbeat(session) {
    if (!session.scId) return;
    try {
        await fetchWithTimeout(`${RACCOON_HOST}/userGame/cost`, {
            method: "POST",
            headers: raccoonHeaders(session.token),
            body: new URLSearchParams({
                ...sessionFields(session.sn, session.token),
                sc_id: String(session.scId),
                game_type: "1",
            }),
        });
    } catch (_) {
        // best-effort; a missed beat or two shouldn't kill the session
    }
}

async function releaseGameSlot(session) {
    if (!session.scId) return;
    try {
        await fetchWithTimeout(`${RACCOON_HOST}/jyapi/stopGame`, {
            method: "POST",
            headers: raccoonHeaders(session.token),
            body: new URLSearchParams({
                ...sessionFields(session.sn, session.token),
                sc_id: String(session.scId),
                game_type: "1",
            }),
        });
    } catch (_) {
        // best-effort cleanup
    }
}

// ------------------------------------------
// Per-client session: owns the RaccoonGame account, the game-launch flow,
// and the signaling relay between our client and RaccoonGame's own
// signaling server. Actual video/audio/input flows browser-to-browser
// over WebRTC once negotiated - this class only brokers the handshake.
// ------------------------------------------

class CloudGameSession {
    constructor(id, clientWs) {
        this.id = id;
        this.clientWs = clientWs;
        this.sn = "";
        this.token = "";
        this.gameKey = "";
        this.scId = null;
        this.bsScId = null;
        this.glKey = null;
        this.playConfig = null;
        this.messageServer = null;
        this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
        this.raccoonWs = null;
        this.raccoonPingInterval = null;
        this.costInterval = null;
        this.sessionTimeout = null;
        this.stopped = false;
    }

    sendToClient(payload) {
        if (this.clientWs.readyState === WebSocket.OPEN) {
            this.clientWs.send(JSON.stringify(payload));
        }
    }

    pushStatus(status, message) {
        this.sendToClient({ type: "status", status, message });
    }

    async start(gameKey) {
        if (!gameKey) {
            this.pushStatus("error", "Missing game key");
            this.stop("missing_game_key");
            return;
        }
        this.gameKey = gameKey;

        try {
            this.pushStatus("creating_account", "Setting up your play session...");
            let account = getAccountFromPool();
            if (!account) {
                account = await createTempAccount();
            }
            if (this.stopped) return;
            this.sn = account.sn;
            this.token = account.token;

            this.pushStatus("requesting_game", "Requesting a game server...");
            let launch = await requestGameLaunch(this.sn, this.token, gameKey);
            if (this.stopped) return;

            if (launch.queued) {
                this.pushStatus("queue", `Queue position ${launch.queuePos}`);
                while (!this.stopped) {
                    await new Promise((r) => setTimeout(r, QUEUE_POLL_INTERVAL_MS));
                    if (this.stopped) return;
                    const pos = await pollGameQueue(this.sn, this.token, launch.queueId);
                    if (pos === 0) break;
                    this.pushStatus("queue", `Queue position ${pos}`);
                }
                if (this.stopped) return;
                launch = { serverData: await claimGameSlot(this.sn, this.token, gameKey, launch.queueId) };
            }

            this.applyServerData(launch.serverData);
            this.pushStatus("connecting", "Connecting to the game server...");
            this.connectToRaccoonSignaling();
            this.costInterval = setInterval(() => sendCostHeartbeat(this), 25_000);

            this.sessionTimeout = setTimeout(
                () => this.stop("session_time_limit"),
                MAX_SESSION_SECONDS * 1000,
            );
        } catch (error) {
            this.pushStatus("error", error.message);
            this.stop("start_error");
        }
    }

    applyServerData(data) {
        this.scId = data.sc_id || data.play_id;
        this.bsScId = data.bs_sc_id || this.scId;
        this.messageServer = data.message_server;
        this.glKey = data.gl_key;
        this.playConfig = data.play_config;
        this.iceServers = [
            { urls: "stun:stun.l.google.com:19302" },
            ...(data.turns || []).map((t) => ({
                urls: t.turn_url,
                username: t.turn_user,
                credential: t.turn_password,
            })),
        ];
    }

    connectToRaccoonSignaling() {
        const raccoonWs = new WebSocket(this.messageServer.url);
        this.raccoonWs = raccoonWs;

        raccoonWs.on("open", () => {
            raccoonWs.send(JSON.stringify({
                id: "register",
                type: "webUA",
                uid: this.sn,
                token: decodeURIComponent(this.messageServer.token),
            }));
            this.raccoonPingInterval = setInterval(() => {
                raccoonWs.send(JSON.stringify({
                    id: "ping",
                    uid: this.sn,
                    type: "webUA",
                    status: "gaming",
                    sc_id: this.bsScId,
                }));
            }, RACCOON_PING_INTERVAL_MS);
        });

        raccoonWs.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch (_) {
                return;
            }

            if (msg.id === "register_ack" && msg.code === 200) {
                raccoonWs.send(JSON.stringify({
                    id: "start_game",
                    from: this.sn,
                    to: this.glKey,
                    game_args: "",
                    gp_num: 0,
                    play_config: this.playConfig,
                    simpleHandler: null,
                    body: {
                        force_soft_dec: 0,
                        session_id: this.bsScId,
                        sn_user_id: this.sn,
                        game_name: null,
                        joystick_num: 2,
                    },
                }));
                return;
            }

            if (msg.id === "start_game" && msg.from === this.glKey && msg.body?.code === 200) {
                this.sendToClient({ type: "game_ready", ice_servers: this.iceServers });
                return;
            }

            if (msg.id === "rtc_sdp" && msg.body) {
                const body = msg.body;
                if (body.type === "answer") {
                    this.sendToClient({ type: "rtc_answer", sdp: body });
                } else if (body.type === "candidate" && body.sdp) {
                    this.sendToClient({ type: "rtc_candidate", candidate: body.sdp });
                }
            }
        });

        raccoonWs.on("close", () => clearInterval(this.raccoonPingInterval));
        raccoonWs.on("error", () => {
            console.error(`[${this.id}] RaccoonGame signaling socket error`);
        });
    }

    forwardOffer(sdp) {
        if (this.raccoonWs?.readyState === WebSocket.OPEN) {
            this.raccoonWs.send(JSON.stringify({
                id: "rtc_sdp",
                from: this.sn,
                to: this.glKey,
                body: { sdp, type: "offer" },
            }));
        }
    }

    forwardCandidate(candidate) {
        if (this.raccoonWs?.readyState === WebSocket.OPEN) {
            this.raccoonWs.send(JSON.stringify({
                id: "rtc_sdp",
                from: this.sn,
                to: this.glKey,
                body: { type: "candidate", sdp: candidate },
            }));
        }
    }

    stop(reason = "stopped") {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.sessionTimeout);
        clearInterval(this.raccoonPingInterval);
        clearInterval(this.costInterval);
        try {
            this.raccoonWs?.close();
        } catch (_) {}
        releaseGameSlot(this).catch(() => {});
        activeSessions.delete(this.id);
        console.log(`[${this.id}] session ended - ${reason}`);
    }
}

// ------------------------------------------
// Entry point: one WebSocket per client. The client sends start_game with a
// game_key, then rtc_offer/rtc_candidate once it starts its own
// RTCPeerConnection; we relay those to RaccoonGame's signaling server and
// relay their replies back untouched.
// ------------------------------------------

function setupGameStreamingServer(_server) {
    startPoolFiller();
    
    const wss = new WebSocketServer({ port: 3001, clientTracking: true });

    wss.on("connection", (ws) => {
        const sessionId = crypto.randomUUID();
        let session = null;
        console.log(`[${sessionId}] client connected`);

        try {
            ws.send(JSON.stringify({ type: "connected", sessionId }));
        } catch (_) {}

        ws.on("message", async (raw) => {
            let data;
            try {
                data = JSON.parse(raw);
            } catch (_) {
                return;
            }

            switch (data.type) {
                case "start_game":
                    session = new CloudGameSession(sessionId, ws);
                    activeSessions.set(sessionId, session);
                    session.start(data.gameKey || data.game_key).catch(() => {});
                    break;
                case "rtc_offer":
                    session?.forwardOffer(data.sdp);
                    break;
                case "rtc_candidate":
                    session?.forwardCandidate(data.candidate);
                    break;
                case "stop":
                    session?.stop("client_stop");
                    break;
                default:
                    break;
            }
        });

        ws.on("close", () => session?.stop("client_disconnected"));
        ws.on("error", () => session?.stop("ws_error"));

        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
            else clearInterval(pingInterval);
        }, 30_000);
    });

    wss.on("error", (error) => {
        console.error("Cloud game signaling server error:", error);
    });

    console.log("Cloud game signaling server listening on port 3001");
}

module.exports = { setupGameStreamingServer };