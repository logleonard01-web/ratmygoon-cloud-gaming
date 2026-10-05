require("dotenv").config();
const express = require('express');
const path = require('path')
const fs = require('fs');
const app = express();
const port = process.env.PORT;
const { spawn } = require("child_process");
const http = require("node:http");
const server = http.createServer(app);
app.use(express.json());
// Run standalone WISP server as child process
const wispProcess = spawn("npx", ["wisp-js-server", "-H", "127.0.0.1", "-P", "5001", "-L", "INFO"], {
  stdio: "inherit",
  shell: true
});
wispProcess.on("error", (error) => {
  console.error("[WISP] Failed to start standalone server:", error);
});

wispProcess.on("exit", (code, signal) => {
  console.log(`[WISP] Standalone server exited with code ${code}, signal ${signal}`);
});

console.log("[WISP] Standalone server starting on 127.0.0.1:5001");

// Wait a moment for the WISP server to start
setTimeout(() => {
  console.log("[WISP] Standalone server should be ready now");
}, 2000);
async function readGames() {
    const filePath = path.join(__dirname, "cloud-games.json");
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
    throw new Error("Invalid games config format");
  }
  return parsed;
}
app.get("/api/games", async (_req, res) => {
  try {
    const games = await readGames();
    res.status(200).json({ games });
  } catch (_error) {
    res.status(500).json({ error: "Unable to load games catalog." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId, image } = req.body;
    
    if (!message) {
      res.status(400).json({ error: "Message is required." });
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const model = process.env.OPENROUTER_MODEL || "gpt-3.5-turbo";

    const messages = [
      { role: "system", content: "You are a helpful AI assistant. If an image is provided, analyze it and answer questions about it. Use markdown formatting for your responses including headers, code blocks, lists, and other markdown elements when appropriate." }
    ];

    if (image) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: message },
          { type: "image_url", image_url: { url: image } }
        ]
      });
    } else {
      messages.push({ role: "user", content: message });
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages
      })
    });

    const data = await response.json();
    
    if (data.error) {
      res.status(500).json({ error: data.error.message || "Failed to get response" });
      return;
    }

    const assistantMessage = data.choices?.[0]?.message?.content || "No response received";
    
    res.status(200).json({ response: assistantMessage });
  } catch (error) {
    console.error("Error in chat API:", error);
    res.status(500).json({ error: "Failed to process chat request." });
  }
});
try {
  const { setupGameStreamingServer } = require("./game-streamer");
  setupGameStreamingServer(server);
  console.log("Cloud gaming server initialized");
} catch (error) {
  console.warn("Cloud gaming server setup failed:", error.message);
}

app.post("/api/cloud-game", async (req, res) => {
  try {
    const { gameId, gameUrl, gameName } = req.body || {};
    
    if (!gameId || !gameUrl) {
      res.status(400).json({ error: "Game ID and URL are required." });
      return;
    }

    // Import cloud.js functionality
    const { launchCloudGame } = require("./cloud-game.js");
    
    // Get the game URL
    const result = await launchCloudGame(gameId, gameUrl, gameName);
    
    if (result.success) {
      res.status(200).json({ 
        success: true, 
        gameUrl: result.gameUrl,
        message: "Game URL ready"
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || "Failed to prepare game" 
      });
    }
  } catch (error) {
    console.error("Error preparing cloud game:", error);
    res.status(500).json({ error: "Failed to prepare game." });
  }
});
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.get('/games', (req, res) => {
  res.sendFile(__dirname + '/games.html');
});
app.get('/ai', (req, res) => {
  res.sendFile(__dirname + '/ai.html');
});
app.use('/', express.static(path.join(__dirname, '')));
app.use('/scramjet', express.static(path.join(__dirname, 'scramjet')));
app.use('/controller', express.static(path.join(__dirname, 'controller')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});