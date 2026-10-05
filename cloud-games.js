window.initCloudGames = function initCloudGames() {
  const cloudContainer = document.getElementById("cloud-games");

  if (!cloudContainer) return;

  // Use games from gamelayout.js (window.G_DATA)
  if (typeof window.G_DATA !== "undefined" && Array.isArray(window.G_DATA)) {
    renderCloudGames(window.G_DATA);
  } else {
    cloudContainer.innerHTML = "<p class='muted'>Failed to load game data.</p>";
  }

  // Render cloud games from G_DATA
  function renderCloudGames(games) {
    cloudContainer.innerHTML = "";
    
    games.forEach((game) => {
      // Games without a RaccoonGame key can't actually be launched.
      if (!game.key) return;

      const card = document.createElement("div");
      card.className = "cloud-game-card";
      card.innerHTML = `
        <img src="${game.img}" alt="${game.n}" class="cloud-game-image" loading="lazy">
        <div class="cloud-game-info">
          <h3 class="cloud-game-title">${game.n}</h3>
          <p class="cloud-game-dev">${game.tags ? game.tags.join(', ') : ''}</p>
        </div>
      `;
      
      card.addEventListener("click", (e) => launchCloudGame(game, card));
      cloudContainer.appendChild(card);
    });
  }

  // Launch cloud game via API
  async function launchCloudGame(game, card) {
    try {
      // Check if a game is already streaming
      const streamContainer = document.getElementById("game-stream-container");
      if (streamContainer && streamContainer.style.display === "flex") {
        console.log("Game already streaming, ignoring new request");
        return;
      }

      // Show loading indicator
      card.style.opacity = "0.5";
      card.style.pointerEvents = "none";

      // Show streaming container
      const gameVideo = document.getElementById("game-canvas");

      if (streamContainer && gameVideo) {
        streamContainer.classList.add("active");

        // Prevent body scroll
        document.body.style.overflow = "hidden";

        let closed = false;
        const closeGame = () => {
          if (closed) return;
          closed = true;
          if (document.pointerLockElement) {
            document.exitPointerLock();
          }
          if (document.fullscreenElement) {
            (document.exitFullscreen ? document.exitFullscreen() : Promise.resolve()).catch(() => {});
          }
          if (window.gameStreamClient) {
            window.gameStreamClient.stopStreaming();
          }
          streamContainer.classList.remove("active");
          // Restore body scroll
          document.body.style.overflow = "";
          
          document.removeEventListener('keydown', escapeHandler);
        };

        // Setup escape key to close
        const escapeHandler = (e) => {
          if (e.key === 'Escape') {
            closeGame();
          }
        };
        document.addEventListener('keydown', escapeHandler);

        // Setup control buttons
        const fullscreenBtn = document.getElementById('fullscreen-btn');
        const newtabBtn = document.getElementById('newtab-btn');
        const exitBtn = document.getElementById('exit-btn');

        // Clone buttons to remove old event listeners
        const newFullscreenBtn = fullscreenBtn.cloneNode(true);
        const newNewtabBtn = newtabBtn.cloneNode(true);
        const newExitBtn = exitBtn.cloneNode(true);
        
        fullscreenBtn.parentNode.replaceChild(newFullscreenBtn, fullscreenBtn);
        newtabBtn.parentNode.replaceChild(newNewtabBtn, newtabBtn);
        exitBtn.parentNode.replaceChild(newExitBtn, exitBtn);

        if (newFullscreenBtn) {
          newFullscreenBtn.addEventListener('click', () => {
            const requestFs = streamContainer.requestFullscreen
              || streamContainer.webkitRequestFullscreen
              || streamContainer.msRequestFullscreen;
            if (requestFs) {
              requestFs.call(streamContainer).catch(() => {});
            }
          });
        }

        if (newNewtabBtn) {
          newNewtabBtn.addEventListener('click', () => {
            const newTab = window.open('about:blank', '_blank');
            if (newTab) {
              newTab.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                  <title>${game.name}</title>
                  <style>
                    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
                    video { width: 100%; height: 100%; object-fit: contain; }
                  </style>
                </head>
                <body>
                  <video id="game-canvas" autoplay playsinline muted></video>
                  <script>
                    const video = document.getElementById('game-canvas');
                    // Clone the video stream from the parent window
                    const parentVideo = window.opener.document.getElementById('game-canvas');
                    if (parentVideo && parentVideo.srcObject) {
                      video.srcObject = parentVideo.srcObject.clone();
                      video.play().catch(() => {});
                    }
                  </script>
                </body>
                </html>
              `);
            }
          });
        }

        if (newExitBtn) {
          newExitBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeGame();
          });
        }

        // Adjust video to account for control bar height
        gameVideo.style.top = '48px';
        gameVideo.style.height = 'calc(100% - 48px)';

        // Start streaming - game.key is RaccoonGame's own game_key,
        // required to launch this specific title on their servers.
        if (window.gameStreamClient) {
          window.gameStreamClient.startStreaming(game.key, game.n, gameVideo);
        }
      }

      // Reset card state
      card.style.opacity = "1";
      card.style.pointerEvents = "auto";

    } catch (error) {
      console.error("Error launching cloud game:", error);
      alert("Failed to launch game. Please try again.");
      
      // Hide stream container on error
      const streamContainer = document.getElementById("game-stream-container");
      if (streamContainer) {
        streamContainer.classList.remove("active");
      }
      
      // Reset card state on error
      card.style.opacity = "1";
      card.style.pointerEvents = "auto";
    }
  }
}

// Initialize on DOMContentLoaded for direct page loads
document.addEventListener("DOMContentLoaded", window.initCloudGames);

// Also initialize immediately for dynamic navigation
window.initCloudGames();