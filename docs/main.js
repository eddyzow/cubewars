// main.js

// Determine build environment.
// Auto-detected from the hostname: localhost/127.0.0.1 means we're running
// against a local server, anything else is production. Override by hand only
// if you need to point a local page at the live backend.
const build =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "dev"
    : "prod";

// Initialize socket connection. In dev the server also serves this page, so
// connecting to the page's own origin is correct.
const socket =
  build === "dev"
    ? io()
    : io("https://cubewars-826c3a3278db.herokuapp.com");

if (build === "prod") {
  $("#dev-warning").remove();
}

let mm = 0;
let mmInterval;
let mmStartTime;
let pg = 0;
let app;
let preloadLayer, gameLayer;
let pressedKeys = {}; // Tracks current key states
let sendingInputs = false;
window.addEventListener("blur", function () {
  pressedKeys = {};
  $("#joinBtn").text(JSON.stringify(pressedKeys));
});
const rankColors = {
  IRON: ["rgb(70, 70, 70)", "rgb(148, 148, 148)"],
  BRONZE: ["rgb(139, 91, 50)", "rgb(185, 123, 69)"],
  SILVER: ["rgb(101, 101, 101)", "rgb(191, 191, 191)"],
  GOLD: ["rgb(255, 145, 2)", "rgb(217, 182, 20)"],
  PLATINUM: ["rgb(33, 148, 74)", "rgb(48, 229, 205)"],
  DIAMOND: ["rgb(200, 25, 97)", "rgb(191, 118, 220)"],
  LEGEND: ["red", "rgb(255, 0, 105)"],
  TRANSCENDENT: ["rgb(255, 0, 105)", "white"],
};

// DOM elements
const indicator = document.getElementById("connection-indicator");
const pingDisplay = document.getElementById("ping-display");

// Utility functions to show/hide loading modal
function showLoad() {
  $("#cube-3d-wrapper").css("transform", "scale(1)");
  $("#cube-modal")
    .addClass("open") // gates the spin animation: only animate while visible
    .css("opacity", "1")
    .css("visibility", "visible");
  setTimeout(() => {
    if ($("#cube-modal").css("opacity") === "1" && !$("#load-warning").length) {
      const warningText = $("<div>")
        .attr("id", "load-warning")
        .text("Server connection is taking longer than expected.")
        .css({
          position: "absolute",
          width: "600px",
          top: "200px",
          color: "#fdd835",
          marginTop: "10px",
          fontSize: "1.2rem",
          textAlign: "center",
          animation: "fadeIn 1s ease forwards",
        });
      $("#cube-3d-wrapper").append(warningText);
    }
  }, 5000);
}

const ranks = [
  { name: "IRON", min: 0 },
  { name: "BRONZE", min: 300 },
  { name: "SILVER", min: 600 },
  { name: "GOLD", min: 900 },
  { name: "PLATINUM", min: 1200 },
  { name: "DIAMOND", min: 1500 },
  { name: "LEGEND", min: 1800 },
  { name: "TRANSCENDENT", min: 2100, single: true },
];

function calculateRankInfo(rating) {
  for (let i = ranks.length - 1; i >= 0; i--) {
    const rank = ranks[i];
    if (rating >= rank.min) {
      if (rank.single) {
        return {
          name: rank.name,
          division: null,
          progress: 0,
          lower: rank.min,
          upper: null,
        };
      }

      const divisionOffset = rating - rank.min;
      const divisionIndex = Math.floor(divisionOffset / 100); // 0, 1, 2
      const division = ["I", "II", "III"][divisionIndex]; // ascending order
      const lower = rank.min + divisionIndex * 100;
      const upper = lower + 100;

      return {
        name: rank.name,
        division,
        progress: divisionOffset % 100,
        lower,
        upper,
      };
    }
  }

  // Fallback for rating < 0 (shouldn't happen, but safe)
  return {
    name: "IRON",
    division: "I",
    progress: 0,
    lower: 0,
    upper: 100,
  };
}

function hideLoad() {
  $("#cube-3d-wrapper").css("transform", "scale(0)");
  $("#cube-modal")
    .removeClass("open")
    .css("opacity", "0")
    .css("visibility", "hidden");
  $("#load-warning").remove();
}

// Utility functions to show/hide boxes
function showBox(name) {
  $("#" + name).css({
    opacity: "1",
    visibility: "visible",
    transform: "scale(1)",
  });
}

function hidePreload() {
  $("#preload").fadeOut(300);
  $("#particles-js").fadeOut(300, function () {
    $(this).remove();
  });
  hideBox("login-box");
  hideBox("register-box");
  hideBox("register-step2-box");
  hideBox("register-step3-box");
}

function hideBox(name) {
  $("#" + name).css({
    opacity: "0",
    visibility: "hidden",
    transform: "scale(0)",
  });
}

tsParticles.loadJSON("fire-canvas", "assets/fire-particles.json");
tsParticles.loadJSON("zen-canvas", "assets/zen-particles.json");

// Function to generate a random salt
function generateSalt(length = 16) {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let salt = "";
  for (let i = 0; i < length; i++) {
    salt += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return salt;
}

// Function to store user data in localStorage
function storeUserData(token, username) {
  localStorage.setItem("userToken", token);
  localStorage.setItem("username", username);
}

// Function to retrieve user data from localStorage
function getUserData() {
  const token = localStorage.getItem("userToken");
  const username = localStorage.getItem("username");
  return token && username ? { token, username } : null;
}

// Function to clear user data from localStorage
function clearUserData() {
  localStorage.removeItem("userToken");
  localStorage.removeItem("username");
  localStorage.removeItem("guestName");
}

// Guest mode: playing without an account. Ranked, replays, and profiles are
// account features; guests get CPU practice and custom rooms.
function isGuest() {
  return !getUserData();
}

// Function to display error messages

// Function to validate email format
function validateEmail(email) {
  const re = /\S+@\S+\.\S+/;
  return re.test(email);
}

// Function to validate password strength
function validatePassword(password) {
  return password.length >= 6 && password.length <= 20;
}

// Function to validate username
function validateUsername(username) {
  return username.length >= 3 && username.length <= 20;
}

// Function to validate token (placeholder for actual validation)
function isValidToken() {
  socket.emit("verifyToken", localStorage.getItem("userToken"));
}

// Function to update connection indicator
function updateConnectionIndicator(connected) {
  if (connected) {
    indicator.classList.remove("pulsing-yellow");
    indicator.style.backgroundColor = "limegreen";
    indicator.style.boxShadow = "0 0 8px limegreen";
    pingDisplay.textContent = "—";
  } else {
    indicator.classList.add("pulsing-yellow");
    pingDisplay.textContent = "Reconnecting...";
  }
}

// Function to measure ping
function ping() {
  const start = Date.now();
  socket.emit("ping-check", (data) => {
    const latency = Date.now() - start;
    pingDisplay.textContent = `Ping: ${latency}ms`;
  });
}

// Function to handle user login
function loginUser(username, password) {
  showLoad();
  socket.emit("login-user", { username, password }, (response) => {
    hideLoad();
    console.log(response);
    if (response.success) {
      storeUserData(response.token, username);
      openGame();
    } else {
      $("#reg3-notice").text(response.error);
    }
  });
}

// Function to handle user registration
function registerUser(username, password, email) {
  showLoad();
  socket.emit("register-user", { username, password, email }, (response) => {
    hideLoad();
    if (response.success) {
      storeUserData(response.token, username);
      openGame();
    } else {
      $("#reg2-notice").text(response.error);
    }
  });
}

function openGame(data) {
  $("#tabpage-1").show();
  document.getElementById("wallpaper").style["background-image"] =
    'url("assets/art/wallpapers/' +
    (Math.floor(Math.random() * 15) + 1).toString() +
    '.jpg")';
  hidePreload();
  showBox("home-container");
  pg = 1;
  $("#main-header-text").text("HOME");
  $("#main-footer").text("CUBE WARS HOME");
  $("#changelog").remove();
  $("#main-tabs").addClass("show");
  $("#username-text").text(
    (localStorage.getItem("username") || localStorage.getItem("guestName") || "GUEST").toUpperCase()
  );
  applyGuestGating();
  $("#tabpage-1").addClass("visible");
  $("#tabpage-1").css("right", "0vw");
}

// Visually lock account-only features for guests.
function applyGuestGating() {
  const g = isGuest();
  $("#ranked-btn, #replays-btn").toggleClass("locked", g);
  $("#level-indicator").toggleClass("guest", g);
  $("#set-logout").text(g ? "LOG IN / REGISTER" : "LOG OUT");
}

// Small denial beat: tell the guest what they're missing without a modal.
function guestDeny(msg) {
  try {
    window.CubeArenaRender.Sfx.play("wall", 1.2, 0.4);
  } catch (e) {}
  const f = $("#main-footer");
  f.text(msg);
  clearTimeout(window._guestDenyT);
  window._guestDenyT = setTimeout(() => {
    if (pg === 2) f.text("SELECT A GAME MODE!");
    if (pg === 1) f.text("CUBE WARS HOME");
  }, 2600);
}

particlesJS.load("particles-js", "assets/particles.json", function () {
  console.log("✅ particles.js config loaded");
});

// Document ready
$(document).ready(function () {
  // Handle socket connection

  socket.on("connect", async () => {
    updateConnectionIndicator(true);
    ping();

    document.documentElement.scrollTop = 0;
    $("#logo").css("opacity", "1");

    const userData = getUserData();
    if (userData) {
      showBox("login-box");
      isValidToken(userData.token);
      $("#login-box h1").text(userData.username.toUpperCase());
    } else {
      showBox("register-box");
    }
    hideLoad();
  });

  // Handle socket disconnection
  socket.on("disconnect", () => {
    updateConnectionIndicator(false);
    if (build == "dev") {
      location.reload(); // Consider removing for production
    }
  });

  // Periodically ping the server
  setInterval(() => {
    if (socket.connected) {
      ping();
    }
  }, 2000);

  // PLAY AS GUEST: no account, server assigns a guest_xxxx name.
  function enterGuestMode() {
    clearUserData();
    showLoad();
    socket.emit("guest-hello", (resp) => {
      hideLoad();
      if (!resp || resp.error) {
        $("#reg1-notice").text((resp && resp.error) || "Could not start a guest session.");
        return;
      }
      localStorage.setItem("guestName", resp.name);
      openGame();
    });
  }
  $("#guest-btn").on("click", enterGuestMode);

  // Handle "LET'S GO!" button click
  $("#start-btn").on("click", function () {
    const userData = getUserData();
    if (userData) {
      isValidToken(userData.token);
      openGame();
    } else {
      alert("User session is invalid. Please register or log in again.");
      clearUserData();
      location.reload();
      hideBox("login-box");
      showBox("register-box");
    }
  });

  // Real matchmaking: the queue UI drives the server's queue, and a
  // "match-found" from the server launches the online game.
  const netSession = new window.CubeArenaNet.NetSession(socket);

  function leaveQueueUI() {
    $("#enter-matchmaking").removeClass("queue");
    mm = 0;
    $("#back-btn").removeClass("no-hover").css("left", "-70px");
    clearInterval(mmInterval);
    $("#mmtimer").text("ENTER MATCHMAKING");
    $("#mm-subtitle").text("FIND A 1v1 OPPONENT OF SIMILAR SKILL");
    $("#main-header-text").text("THE TESSERACT");
    $("#border-flash").removeClass("flashing-border");
  }

  $("#enter-matchmaking").on("click", function () {
    if (mm === 0) {
      // Matchmaking turning on
      $("#enter-matchmaking").addClass("queue");
      mm = 1;
      $("#back-btn").addClass("no-hover").css("left", "-270px");

      mmStartTime = Date.now();
      $("#mmtimer").text("FINDING MATCH");
      $("#mm-subtitle").text("00:00 · CLICK TO CANCEL");
      $("#main-header-text").text(`THE TESSERACT - 00:00`);

      mmInterval = setInterval(function () {
        let elapsed = Math.floor((Date.now() - mmStartTime) / 1000);
        let minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
        let seconds = String(elapsed % 60).padStart(2, "0");
        $("#main-header-text").text(`THE TESSERACT - ${minutes}:${seconds}`);
        $("#mm-subtitle").text(`${minutes}:${seconds} · CLICK TO CANCEL`);
      }, 1000);

      $("#border-flash").addClass("flashing-border");
      socket.emit("queue-join", localStorage.getItem("userToken"));
    } else {
      leaveQueueUI();
      socket.emit("queue-leave");
    }
  });

  socket.on("queue-error", (msg) => {
    leaveQueueUI();
    alert(msg);
  });

  netSession.onMatchFound = function (data) {
    leaveQueueUI();
    resetCustomUI();
    launchGame("the tesseract", {
      seed: data.seed,
      netHooks: netSession.hooks(),
      myIndex: data.youAre,
      myName: data.youName,
      myRating: data.youRating,
      opponent: data.opponent,
    });
    // The session needs the live controller to apply server snapshots to.
    netSession.controller = activeGame;
  };

  netSession.onOpponentLeft = function () {
    // Forfeit win; the match-over panel follows from the server's match-over.
    $("#game-over-reason").text("YOUR OPPONENT DISCONNECTED. YOU WIN BY FORFEIT.");
  };

  socket.on("match-over", (data) => {
    // Stash the authoritative result (incl. rating delta) for the panel.
    window._lastMatchOver = data;
  });

  // Champion-style round overlay: show the score BIG with the old value,
  // then punch the winner's digit up by one.
  window.CubeWarsRoundFX = function (info) {
    const Sfx = window.CubeArenaRender.Sfx;
    const meIdx = info.myIndex;
    const iWon = info.winner === meIdx;
    const newMine = info.wins[meIdx] || 0;
    const newFoe = info.wins[1 - meIdx] || 0;
    // The pre-round score: winner's count minus the point just scored.
    const oldMine = iWon && info.winner !== -1 ? newMine - 1 : newMine;
    const oldFoe = !iWon && info.winner !== -1 ? newFoe - 1 : newFoe;

    const ov = $("#round-overlay");
    $("#ro-label")
      .text(info.winner === -1 ? "DOUBLE KO" : iWon ? "ROUND WON" : "ROUND LOST")
      .css("color", info.winner === -1 ? "#ffffff" : iWon ? "#ffd166" : "#ff5e6e");
    $("#ro-me").text(oldMine).removeClass("ro-punch");
    $("#ro-foe").text(oldFoe).removeClass("ro-punch");
    $("#ro-sub").text("");
    ov.removeClass("active");
    void ov[0].offsetWidth;
    ov.addClass("active");

    // Beat 2: the winning digit ticks up with a punch — fast.
    setTimeout(() => {
      if (!ov.hasClass("active")) return;
      const el = iWon ? $("#ro-me") : $("#ro-foe");
      el.text(iWon ? newMine : newFoe);
      el.removeClass("ro-punch");
      void el[0].offsetWidth;
      el.addClass("ro-punch");
      // Win = triumphant wipe; loss = a low dash whoosh.
      Sfx.play(iWon ? "roundWin" : "dash", iWon ? 1 : 0.8);
      const leader = Math.max(newMine, newFoe);
      if (leader === 2) $("#ro-sub").text("MATCH POINT");
    }, 350);

    // Fast score beat, then 3-2-1 over the respawned board. Engine pause is
    // 2.6s: score 0-1.1s, teleport at 1.0s, countdown 1.15-2.5s, GO ~= go.
    setTimeout(() => ov.removeClass("active"), 1100);
    setTimeout(() => {
      if (activeGame && activeGame.game && !activeGame.game.over) {
        runBigCountdown(null);
      }
    }, 1150);
  };

  // Post-match chat: type on the results screen, relayed to your opponent.
  $("#go-chat-input").on("keydown", function (e) {
    if (e.key !== "Enter") return;
    const txt = this.value.trim();
    if (!txt) return;
    this.value = "";
    socket.emit("match-chat", txt);
    window._chatAppend &&
      window._chatAppend(
        (localStorage.getItem("username") || localStorage.getItem("guestName") || "me").toLowerCase(),
        txt,
        false
      );
    e.stopPropagation();
  });
  socket.on("match-chat", (m) => {
    if (window._chatAppend) window._chatAppend(m.from.toLowerCase(), m.text, false);
  });
  socket.on("chat-peer-left", (m) => {
    if (window._chatAppend) {
      window._chatAppend(null, (m.name || "opponent").toLowerCase() + " left the room", true);
    }
    $("#go-chat-input").prop("disabled", true).attr("placeholder", "opponent left");
  });

  // Profile modal: click the header chip.
  function openProfile() {
    if (isGuest()) return guestDeny("CREATE AN ACCOUNT TO TRACK STATS AND RATING");
    socket.emit("get-profile", localStorage.getItem("userToken"), (resp) => {
      if (resp.error || !resp.data) return;
      const p = resp.data;
      const info = calculateRankInfo(p.rating);
      $("#profile-name").text(p.username.toUpperCase());
      $("#profile-rank").text(info.division ? info.name + " " + info.division : info.name);
      $("#profile-rating").text(p.rating);
      $("#profile-wins").text(p.wins);
      $("#profile-games").text(p.games);
      $("#profile-level").text(p.level);
      $("#profile-joined").text(
        "JOINED " +
          (p.createdAt
            ? new Date(p.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }).toUpperCase()
            : "\u2014")
      );
      $("#profile-modal").addClass("active");
    });
  }
  $("#level-indicator").on("click", openProfile);
  $("#profile-close").on("click", () => $("#profile-modal").removeClass("active"));
  $("#profile-modal").on("click", function (e) {
    if (e.target === this) $(this).removeClass("active");
  });

  // Live presence numbers for the queue screen and the PLAY menu.
  socket.on("stats", (d) => {
    $("#tl-queue-count").text(d.queue);
    $("#tl-game-count").text(d.inGame);
    $("#tl-online-count").text(d.online);
    $(".player-count h1").text(d.inGame);
  });

  $("#play-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover").css("left", "-70px");
    $("#tabpage-1").css("right", "-85vw");
    $("#tabpage-2").css("right", "-0vw");
    $("#tabpage-1").removeClass("visible");
    $("#tabpage-2").addClass("visible");
    pg = 2;
    $("#main-header-text").text("PLAY");
    $("#main-footer").text("SELECT A GAME MODE!");
  });

  // ===========================================================
  // SETTINGS — persisted to localStorage, applied live
  // ===========================================================

  const SETTINGS_KEY = "cw_settings";
  window.CubeWarsSettings = Object.assign(
    { sfx: 55, shake: true },
    JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
  );

  function applySettings() {
    const s = window.CubeWarsSettings;
    window.CubeArenaRender.Sfx.volume = s.sfx / 100;
    // Live-loaded Howls keep their creation volume; refresh them.
    const sounds = window.CubeArenaRender.Sfx.sounds;
    for (const k in sounds) {
      try {
        sounds[k].volume(s.sfx / 100);
      } catch (e) {}
    }
    $("#set-sfx").val(s.sfx);
    $("#set-sfx-val").text(s.sfx);
    $("#set-shake").prop("checked", s.shake);
    $("#set-shake-val").text(s.shake ? "ON" : "OFF");
    $("#set-username").text(
      (localStorage.getItem("username") || localStorage.getItem("guestName") || "guest").toUpperCase()
    );
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  $("#set-sfx").on("input", function () {
    window.CubeWarsSettings.sfx = +this.value;
    applySettings();
  });
  $("#set-shake").on("change", function () {
    window.CubeWarsSettings.shake = this.checked;
    applySettings();
  });
  $("#set-logout").on("click", function () {
    clearUserData();
    location.reload();
  });
  applySettings();

  // ===========================================================
  // GAME LAUNCH (arena duel: practice vs bot now, versus later)
  // ===========================================================

  let activeGame = null;

  function showMatchOverPanel(winner, stats) {
    const myIdx = activeGame ? activeGame.myIndex : 0;
    const iWon = winner === myIdx;
    const names = window._matchNames || { me: "YOU", foe: "OPPONENT", net: false };
    const net = window._lastMatchOver;

    // AUTHORITATIVE stats: online, each client's local sim tracked slightly
    // different numbers (prediction) — the server's copy is the truth and is
    // identical on both screens.
    const authStats = names.net && net && net.stats ? net.stats : stats;
    const mine = authStats[myIdx] || {};
    const theirs = authStats[1 - myIdx] || {};

    // Grand finish: jingle + fullscreen colour flash + slamming title.
    window.CubeArenaRender.Sfx.play(iWon ? "victory" : "defeat");
    const flash = document.getElementById("game-flash");
    flash.className = "";
    void flash.offsetWidth;
    flash.className = iWon ? "win" : "lose";

    const title = document.getElementById("game-over-title");
    title.style.animation = "none";
    void title.offsetWidth;
    title.style.animation = "";
    $("#game-over-title")
      .text(winner === -1 ? "DRAW" : iWon ? "VICTORY" : "DEFEAT")
      .css("color", iWon ? "#ffd166" : "#ff4d4d");

    // Top bar: mode crumb + player chip (like the league results header).
    $("#go-topbar-title").text(
      (names.net ? "THE TESSERACT" : "PRACTICE") + " / RESULTS"
    );
    $("#go-chip-name").text(names.me);
    $("#go-chip-rating").text(
      names.net && net ? String(net.ratingAfter || 0) : "—"
    );

    // Score cards: big number is ROUND WINS (first to 3), like a league set
    // score. Winner card gets the golden glow.
    const score =
      names.net && net && net.score
        ? net.score
        : activeGame && activeGame.game
        ? activeGame.game.roundWins
        : [0, 0];
    $("#go-me-name").text(names.me);
    $("#go-foe-name").text(names.foe);
    $("#go-me-big").text(score[myIdx] || 0).toggleClass("go-big-dim", !iWon);
    $("#go-foe-big").text(score[1 - myIdx] || 0).toggleClass("go-big-dim", iWon);
    $(".go-me").toggleClass("go-winner", iWon);
    $(".go-foe").toggleClass("go-winner", !iWon && winner !== -1);

    // Notable stats, big and labelled, identical metrics on both cards.
    const statCells = (p) => {
      const acc = p.shots > 0 ? Math.min(100, Math.round((p.hits / p.shots) * 100)) : 0;
      return (
        '<div class="go-stat"><b>' + Math.round(p.dealt || 0) + "</b><label>DMG</label></div>" +
        '<div class="go-stat"><b>' + (p.hits || 0) + "</b><label>HITS</label></div>" +
        '<div class="go-stat"><b>' + (p.shots || 0) + "</b><label>SHOTS</label></div>" +
        '<div class="go-stat"><b>' + acc + "%</b><label>ACC</label></div>"
      );
    };
    $("#go-me-stats").html(statCells(mine));
    $("#go-foe-stats").html(statCells(theirs));

    // Chat-style match log.
    const winName = winner === -1 ? null : winner === myIdx ? names.me : names.foe;
    window._chatAppend = window._chatAppend || function (who, text, isSystem) {
      $("#go-chat-log").append(
        '<div class="go-chat-line"><span>' +
          (isSystem ? "[SYSTEM]" : who) +
          "</span> <i>" + $("<i>").text(text).html() + "</i></div>"
      );
      const log = document.getElementById("go-chat-log");
      log.scrollTop = log.scrollHeight;
    };
    $("#go-chat-log").empty();
    window._chatAppend(null, "started the game", true);
    if (net && net.how === "forfeit") {
      window._chatAppend(null, (iWon ? names.foe : names.me).toLowerCase() + " disconnected", true);
    } else {
      window._chatAppend(null, "final score " + (score[myIdx] || 0) + " - " + (score[1 - myIdx] || 0), true);
    }
    window._chatAppend(null, "game finished", true);
    // Chat input only makes sense against a human.
    $("#go-chat-input").toggle(!!names.net);

    // Standing panel: online only, animated rating count.
    if (names.net && net && net.ranked !== false && typeof net.ratingAfter === "number") {
      $("#go-standing").css("visibility", "visible");
      const from = net.ratingBefore || 0;
      const to = net.ratingAfter;
      const delta = net.ratingDelta || 0;
      $("#go-delta")
        .text(delta === 0 ? "=" : (delta > 0 ? "\u2197 " : "\u2198 ") + Math.abs(delta))
        .css("color", delta === 0 ? "#8b93a7" : delta > 0 ? "#ffffff" : "#ff5e6e");
      const info = calculateRankInfo(to);
      $("#go-rank").text(info.division ? info.name + " " + info.division : info.name);
      $("#go-rank-progress").text(
        info.upper ? "\u2191 " + (info.upper - to) + " TO NEXT" : "MAX RANK"
      );

      const el = document.getElementById("go-rating");
      el.textContent = from; // hold the old rating while the panel animates in
      setTimeout(() => {
        const t0 = performance.now();
        const dur = 1100;
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          const k = 1 - Math.pow(1 - t, 3); // ease-out cubic
          el.textContent = Math.round(from + (to - from) * k);
          if (t < 1 && document.getElementById("game-over-panel").classList.contains("active")) {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }, 1050); // #go-lower finishes rising at ~1.0s
    
      window._lastMatchOver = null;
    } else {
      $("#go-standing").css("visibility", "hidden");
    }

    $("#game-over-panel").addClass("active");
  }

  function exitGame() {
    socket.emit("chat-leave"); // tell the last opponent we've moved on
    $("#go-chat-input").prop("disabled", false).attr("placeholder", "message...");
    if (window._gamePingInterval) {
      clearInterval(window._gamePingInterval);
      window._gamePingInterval = null;
    }
    if (activeGame) {
      // Abandoning a live online match is a forfeit — the server settles it.
      if (activeGame.netHooks && activeGame.game && !activeGame.game.over) {
        socket.emit("match-leave");
      }
      activeGame.stop();
      activeGame = null;
    }
    $("#game-over-panel").removeClass("active");
    $("#match-intro").removeClass("active");
    $("#big-countdown").removeClass("active punch go");
    $("#game-screen").removeClass("active");
    $("#dev-warning, #changelog, #connection-indicator-wrapper").show();
    // Only the menu comes back — #preload stays hidden, since reaching a game
    // means the player is already past it.
    $("#home-container").show();
  }

  // Shared 3-2-1-GO: used for the match intro AND between rounds.
  function runBigCountdown(onGo) {
    const Sfx = window.CubeArenaRender.Sfx;
    Sfx.play("countdown");
    const bc = document.getElementById("big-countdown");
    const $bc = $(bc);
    $bc.addClass("active");
    const steps = ["3", "2", "1", "GO!"];
    let i = 0;
    const beat = () => {
      if (!activeGame || (activeGame.game && activeGame.game.over)) {
        $bc.removeClass("active punch go");
        return;
      }
      $bc.text(steps[i]);
      $bc.toggleClass("go", steps[i] === "GO!");
      $bc.removeClass("punch");
      void bc.offsetWidth;
      $bc.addClass("punch");
      if (steps[i] === "GO!") {
        if (onGo) onGo();
        setTimeout(() => $bc.removeClass("active punch go"), 450);
      } else {
        i++;
        setTimeout(beat, 450);
      }
    };
    beat();
  }

  function launchGame(mode, opts) {
    opts = opts || {};
    window._lastLaunch = [mode, opts]; // so RESTART replays the full intro
    // Audio context can only be created after a user gesture, so init here
    // rather than on page load.
    window.CubeArenaRender.Sfx.init();

    // Random wallpaper behind the board. Measured mean luminance per image, so
    // dark art gets shown more strongly and bright art is held back — keeps the
    // board equally readable whichever one comes up.
    const WALLPAPER_LUM = {
      1: 129, 2: 47, 3: 89, 4: 106, 5: 164, 6: 97, 7: 82, 8: 174,
      9: 110, 10: 144, 11: 145, 12: 94, 13: 126, 14: 73, 15: 105,
    };
    const wpIndex = Math.floor(Math.random() * 15) + 1;
    const wpEl = document.getElementById("game-wallpaper");
    wpEl.style["background-image"] =
      'url("assets/art/wallpapers/' + wpIndex + '.jpg")';
    // Target a consistent perceived brightness of roughly 34 on a 0-255 scale.
    const lum = WALLPAPER_LUM[wpIndex] || 110;
    wpEl.style.opacity = Math.max(0.22, Math.min(0.62, 34 / (lum / 10) / 10)).toFixed(3);

    $("#game-over-panel").removeClass("active");
    $("#game-screen").addClass("active");
    // Page furniture would collide with the control hints; hide during play.
    $("#dev-warning, #changelog, #connection-indicator-wrapper").hide();
    // The overlay is translucent so the wallpaper reads through, which means the
    // menu underneath must actually be hidden or it bleeds into the board.
    $("#home-container, #preload").hide();

    if (activeGame) activeGame.stop();
    activeGame = new window.CubeArenaController.ArenaController({
      stage: document.getElementById("game-stage"),
      mode: mode,
      bot: opts.bot,
      myIndex: opts.myIndex || 0,
      netHooks: opts.netHooks || null,
      onExit: exitGame,
      onMatchOver: showMatchOverPanel,
      onRestart: restartGame,
    });
    activeGame.start(opts.seed);

    // ---- Match presentation: MATCH FOUND cards -> 3-2-1 -> GO -------------
    const Sfx = window.CubeArenaRender.Sfx;
    // Online: server-authoritative name (localStorage is shared across tabs).
    const meName = (
      opts.myName ||
      localStorage.getItem("username") ||
      localStorage.getItem("guestName") ||
      "YOU"
    ).toUpperCase();
    const isNet = !!opts.netHooks;
    $("#mi-found").text(isNet ? "MATCH FOUND" : "PRACTICE MATCH");
    $("#mi-p1name").text(meName);
    $("#mi-p1sub").text(isNet ? "RATING " + (opts.myRating || 0) : "YOU");
    $("#mi-p2name").text(
      isNet && opts.opponent ? opts.opponent.username.toUpperCase() : "BOT"
    );
    $("#mi-p2sub").text(
      isNet && opts.opponent ? "RATING " + (opts.opponent.rating || 0) : "TRAINING DUMMY"
    );

    if (isNet) Sfx.play("intro1"); // act-intro stinger on real match found
    $("#match-intro").addClass("active");

    setTimeout(() => {
      $("#match-intro").removeClass("active");
      if (!activeGame) return; // player exited during the intro
      runBigCountdown(() => activeGame && activeGame.unfreeze());
    }, 2400);

    // Live ping readout in the arena HUD. Local play just shows "LOCAL".
    if (window._gamePingInterval) clearInterval(window._gamePingInterval);
    if (opts.netHooks) {
      window._gamePingInterval = setInterval(() => {
        const t0 = Date.now();
        socket.emit("ping-check", () => {
          if (activeGame && activeGame.renderer) {
            activeGame.renderer.pingMs = Date.now() - t0;
          }
        });
      }, 2000);
    }


    // Name the HP bars. Cube 0 is always the left bar, so "YOU" follows index.
    const r = activeGame.renderer;
    // Left bar is always the local player; the renderer mirrors the world so
    // this holds for both sides of an online match.
    const foeName = opts.opponent ? opts.opponent.username.toUpperCase() : "BOT";
    r.p1Name.text = meName;
    r.p2Name.text = foeName;
    window._matchNames = { me: meName, foe: foeName, net: isNet };
  }

  $("#zen-btn").on("click", function () {
    launchGame("practice");
  });

  // NEXT: practice replays; online returns to the queue page.
  $("#go-next").on("click", function () {
    if (activeGame && !activeGame.netHooks) restartGame();
    else exitGame();
  });

  function restartGame() {
    if (!activeGame || !window._lastLaunch) return;
    $("#go-chat-input").prop("disabled", false).attr("placeholder", "message...");
    $("#game-over-panel").removeClass("active");
    // Full relaunch so the intro/countdown presentation replays and a fresh
    // seed generates a fresh map.
    launchGame(window._lastLaunch[0], Object.assign({}, window._lastLaunch[1], { seed: undefined }));
  }

  // Exposed so multiplayer (and the console) can drive a game directly.
  window.CubeWarsLaunch = launchGame;
  window.CubeWarsExit = exitGame;
  window.CubeWarsActive = function () {
    return activeGame;
  };

  // ---- CUSTOM GAMES (room codes) ----
  $("#custom-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover").css("left", "-70px");
    $(".tabpage").css("right", "-85vw").removeClass("visible");
    $("#tabpage-4").css("right", "-0vw").addClass("visible");
    pg = 4;
    $("#main-header-text").text("CUSTOM GAME");
    $("#main-footer").text("PLAY A FRIEND WITH A ROOM CODE");
  });

  function resetCustomUI() {
    $("#cg-hosting").hide();
    $("#cg-create-wrap").show();
    $("#cg-error").text("");
    $("#cg-code").html("&mdash;");
  }
  resetCustomUI();

  $("#cg-create").on("click", function () {
    socket.emit("custom-create", localStorage.getItem("userToken"), (resp) => {
      if (resp.error) return $("#cg-error").text(resp.error);
      $("#cg-create-wrap").hide();
      $("#cg-hosting").show();
      $("#cg-code").text(resp.code);
    });
  });

  $("#cg-cancel").on("click", function () {
    socket.emit("custom-cancel");
    resetCustomUI();
  });

  $("#cg-join").on("click", function () {
    const code = $("#cg-join-code").val().toUpperCase().trim();
    if (code.length < 4) return $("#cg-error").text("Enter the 5-character code.");
    socket.emit("custom-join", { token: localStorage.getItem("userToken"), code: code }, (resp) => {
      if (resp.error) return $("#cg-error").text(resp.error);
      $("#cg-error").text("");
      // match-found arrives next and launches the game.
    });
  });
  $("#cg-join-code").on("keydown", function (e) {
    if (e.key === "Enter") $("#cg-join").click();
    e.stopPropagation();
  });

  // ===========================================================
  // REPLAYS — game history + deterministic playback.
  // A replay is seed + per-tick inputs; the engine re-simulates the
  // match exactly. Controls: pause, speed, round jump, POV swap.
  // ===========================================================

  let replayPlayer = null;
  const SPEEDS = [0.5, 1, 2, 4];

  class ReplayPlayer {
    constructor(decoded, pov) {
      this.decoded = decoded;
      this.meta = decoded.meta;
      this.names = (this.meta.names || ["P1", "P2"]).map((n) => n.toUpperCase());
      this.pov = pov === 1 ? 1 : 0;
      this.speed = 1;
      this.playing = true;
      this.acc = 0;
      this.lastT = performance.now();
      this.renderer = null;
      this._buildSim(0);
      this._buildRenderer();
      this._renderMarkers();
      this._syncBar();
      this._onKey = (e) => {
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
        const k = e.key.toLowerCase();
        if (k === "escape") exitReplay();
        else if (k === " ") {
          e.preventDefault();
          this.togglePlay();
        }
      };
      document.addEventListener("keydown", this._onKey);
      // Same setInterval-not-rAF reasoning as the live game loop.
      this.timer = setInterval(() => this._loop(), 1000 / window.CubeArena.TICK_RATE);
    }

    // Fresh sim fast-forwarded (silently) to startTick.
    _buildSim(startTick) {
      this.game = new window.CubeArena.ArenaGame({ seed: this.meta.seed });
      this.cursor = new window.CubeArenaReplay.Cursor(this.decoded);
      for (let t = 1; t <= startTick; t++) {
        this.game.step(this.cursor.inputsFor(t));
        this.game.drainEvents(); // no FX while seeking
      }
      this.game._lastStepAt = performance.now();
      if (this.renderer) this.renderer.game = this.game;
      this.acc = 0;
    }

    // Renderer rebuild = perspective change (mirroring + identity colors).
    _buildRenderer() {
      if (this.renderer) this.renderer.destroy();
      this.renderer = new window.CubeArenaRender.ArenaRenderer(
        document.getElementById("game-stage"),
        this.game,
        { myIndex: this.pov, netMode: false }
      );
      this.renderer.p1Name.text = this.names[this.pov];
      this.renderer.p2Name.text = this.names[1 - this.pov];
      this.renderer.pingMs = null;
    }

    _loop() {
      if (!this.renderer) return;
      const now = performance.now();
      const dtMs = Math.min(250, now - this.lastT);
      this.lastT = now;
      if (this.playing && !this.done()) {
        this.acc += (dtMs / 1000) * this.speed;
        const DT = window.CubeArena.DT;
        // Cap catch-up so 4x on a slow machine can't spiral.
        let steps = 0;
        while (this.acc >= DT && !this.done() && steps < 16) {
          this.acc -= DT;
          steps++;
          this.game.step(this.cursor.inputsFor(this.game.tick + 1));
          this.game._lastStepAt = performance.now();
        }
      }
      this.renderer.consumeEvents();
      if (this.done() && this.playing) {
        this.playing = false;
        this._syncBar();
      }
      this._syncProgress();
    }

    done() {
      return this.game.over || this.game.tick >= this.meta.ticks;
    }

    curRoundIdx() {
      const rounds = this.meta.rounds || [0];
      let i = 0;
      while (i + 1 < rounds.length && rounds[i + 1] <= this.game.tick) i++;
      return i;
    }

    togglePlay() {
      if (this.done()) {
        // RESTART from the top.
        this._buildSim(0);
        this._buildRenderer();
        this.playing = true;
      } else {
        this.playing = !this.playing;
      }
      this._syncBar();
    }

    jumpRound(delta) {
      const rounds = this.meta.rounds || [0];
      const target = Math.max(0, Math.min(rounds.length - 1, this.curRoundIdx() + delta));
      const startTick = rounds[target];
      if (startTick >= this.game.tick) {
        // Forward: silently fast-forward the live sim.
        while (this.game.tick < startTick && !this.game.over) {
          this.game.step(this.cursor.inputsFor(this.game.tick + 1));
          this.game.drainEvents();
        }
        this.game._lastStepAt = performance.now();
        this.acc = 0;
      } else {
        // Backward: deterministic rebuild from tick 0.
        this._buildSim(startTick);
        this._buildRenderer();
      }
      this.playing = true;
      this._syncBar();
    }

    cycleSpeed() {
      this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
      this._syncBar();
    }

    // YouTube-style scrub: jump to any tick. Forward = silent fast-forward of
    // the live sim; backward = deterministic rebuild from tick 0 (a few ms).
    seekTick(t) {
      t = Math.max(0, Math.min(this.meta.ticks, Math.round(t)));
      if (t < this.game.tick) {
        this._buildSim(t);
      } else {
        while (this.game.tick < t && !this.game.over) {
          this.game.step(this.cursor.inputsFor(this.game.tick + 1));
          this.game.drainEvents();
        }
        this.game._lastStepAt = performance.now();
        this.acc = 0;
      }
      this._syncBar();
      this._syncProgress();
    }

    // Round-boundary ticks on the seek track.
    _renderMarkers() {
      const track = document.getElementById("rb-seek-track");
      if (!track) return;
      track.querySelectorAll(".rb-marker").forEach((m) => m.remove());
      const rounds = this.meta.rounds || [0];
      for (let i = 1; i < rounds.length; i++) {
        const m = document.createElement("div");
        m.className = "rb-marker";
        m.style.left = (rounds[i] / Math.max(1, this.meta.ticks)) * 100 + "%";
        track.appendChild(m);
      }
    }

    switchPov() {
      this.pov = 1 - this.pov;
      this._buildRenderer();
      this._syncBar();
    }

    _syncBar() {
      $("#rb-play").text(this.done() ? "RESTART" : this.playing ? "PAUSE" : "PLAY");
      $("#rb-speed").text((this.speed + "×").replace("0.5×", "½×"));
      $("#rb-pov").text("POV: " + this.names[this.pov]);
    }

    _syncProgress() {
      const fmt = (t) => {
        const s = Math.floor(t / window.CubeArena.TICK_RATE);
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      };
      $("#rb-progress").text(
        (this.done() ? "REPLAY OVER" : "ROUND " + (this.curRoundIdx() + 1)) +
          " · " + fmt(Math.min(this.game.tick, this.meta.ticks)) + " / " + fmt(this.meta.ticks)
      );
      const frac = Math.min(1, this.game.tick / Math.max(1, this.meta.ticks));
      const pct = (frac * 100).toFixed(2) + "%";
      const fill = document.getElementById("rb-seek-fill");
      const handle = document.getElementById("rb-seek-handle");
      if (fill) fill.style.width = pct;
      if (handle) handle.style.left = pct;
    }

    destroy() {
      clearInterval(this.timer);
      document.removeEventListener("keydown", this._onKey);
      if (this.renderer) this.renderer.destroy();
      this.renderer = null;
      this.game = null;
    }
  }

  function launchReplay(decoded, pov) {
    window.CubeArenaRender.Sfx.init();

    // Same wallpaper treatment as a live match.
    const WPL = { 1:129,2:47,3:89,4:106,5:164,6:97,7:82,8:174,9:110,10:144,11:145,12:94,13:126,14:73,15:105 };
    const wp = Math.floor(Math.random() * 15) + 1;
    const wpEl = document.getElementById("game-wallpaper");
    wpEl.style["background-image"] = 'url("assets/art/wallpapers/' + wp + '.jpg")';
    wpEl.style.opacity = Math.max(0.22, Math.min(0.62, 34 / ((WPL[wp] || 110) / 10) / 10)).toFixed(3);

    $("#game-over-panel, #match-intro").removeClass("active");
    $("#game-screen").addClass("active");
    $("#game-help").hide();
    $("#replay-bar").addClass("active");
    $("#dev-warning, #changelog, #connection-indicator-wrapper").hide();
    $("#home-container, #preload").hide();

    if (replayPlayer) replayPlayer.destroy();
    replayPlayer = new ReplayPlayer(decoded, pov);
  }

  function exitReplay() {
    if (replayPlayer) {
      replayPlayer.destroy();
      replayPlayer = null;
    }
    $("#replay-bar").removeClass("active");
    $("#game-help").show();
    $("#round-overlay").removeClass("active");
    $("#game-screen").removeClass("active");
    $("#dev-warning, #changelog, #connection-indicator-wrapper").show();
    $("#home-container").show();
  }

  // Seek bar: click anywhere to jump, drag to scrub. Playback pauses during
  // the drag and resumes after, YouTube-style.
  (function wireSeekBar() {
    const seek = document.getElementById("rb-seek");
    if (!seek) return;
    let dragging = false;
    let wasPlaying = false;
    const fracFrom = (e) => {
      const r = document.getElementById("rb-seek-track").getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    const applySeek = (e) => {
      if (replayPlayer) replayPlayer.seekTick(fracFrom(e) * replayPlayer.meta.ticks);
    };
    seek.addEventListener("mousedown", (e) => {
      if (!replayPlayer) return;
      dragging = true;
      wasPlaying = replayPlayer.playing;
      replayPlayer.playing = false;
      applySeek(e);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) applySeek(e);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      if (replayPlayer) {
        replayPlayer.playing = wasPlaying && !replayPlayer.done();
        replayPlayer._syncBar();
      }
    });
  })();

  $("#rb-exit").on("click", exitReplay);
  $("#rb-play").on("click", () => replayPlayer && replayPlayer.togglePlay());
  $("#rb-prev").on("click", () => replayPlayer && replayPlayer.jumpRound(-1));
  $("#rb-next").on("click", () => replayPlayer && replayPlayer.jumpRound(1));
  $("#rb-speed").on("click", () => replayPlayer && replayPlayer.cycleSpeed());
  $("#rb-pov").on("click", () => replayPlayer && replayPlayer.switchPov());

  // ---- history list ----

  function fmtWhen(ms) {
    const d = new Date(ms);
    return d
      .toLocaleDateString(undefined, { month: "short", day: "numeric" })
      .toUpperCase() +
      " " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toUpperCase();
  }

  function loadReplayList() {
    $("#replay-list").html('<p class="rp-empty">LOADING...</p>');
    socket.emit("replay-list", localStorage.getItem("userToken"), (resp) => {
      if (resp.error) return $("#replay-list").html('<p class="rp-empty">' + resp.error + "</p>");
      const rows = resp.data || [];
      if (!rows.length) {
        return $("#replay-list").html(
          '<p class="rp-empty">NO REPLAYS YET — PLAY AN ONLINE MATCH AND IT WILL SHOW UP HERE.</p>'
        );
      }
      const html = rows
        .map((r) => {
          const me = (r.names[r.you] || "YOU").toUpperCase();
          const foe = (r.names[1 - r.you] || "OPPONENT").toUpperCase();
          const won = r.winner === r.you;
          const res = r.winner === -1 ? "D" : won ? "W" : "L";
          const dur = Math.floor(r.durationS / 60) + ":" + String(r.durationS % 60).padStart(2, "0");
          return (
            '<div class="rp-row ' + (r.winner === -1 ? "rp-draw" : won ? "rp-win" : "rp-loss") + '" data-id="' + r.id + '">' +
            '<div class="rp-result">' + res + "</div>" +
            '<div class="rp-info">' +
            '<div class="rp-main">' + me + ' <i>vs</i> ' + foe +
            '<span class="rp-score">' + (r.score[r.you] || 0) + " - " + (r.score[1 - r.you] || 0) + "</span></div>" +
            '<div class="rp-sub">' + (r.ranked ? "RANKED" : "CUSTOM") +
            " · " + fmtWhen(r.endedAt) + " · " + dur +
            (r.how === "forfeit" ? " · FORFEIT" : "") + "</div>" +
            "</div>" +
            '<div class="rp-actions">' +
            '<button class="rp-btn rp-watch">WATCH</button>' +
            '<button class="rp-btn rp-dl" title="Download as .txt">.TXT</button>' +
            '<button class="rp-btn rp-keep' + (r.keep ? " kept" : "") + '">' + (r.keep ? "KEPT ✓" : "KEEP") + "</button>" +
            "</div></div>"
          );
        })
        .join("");
      $("#replay-list").html(html);
    });
  }

  function fetchReplay(id, cb) {
    socket.emit("replay-get", { token: localStorage.getItem("userToken"), id: id }, (resp) => {
      if (resp.error) return alert(resp.error);
      cb(resp);
    });
  }

  $("#replay-list").on("click", ".rp-watch", function () {
    const id = $(this).closest(".rp-row").data("id");
    fetchReplay(id, (resp) => {
      let decoded;
      try {
        decoded = window.CubeArenaReplay.decode(resp.data);
      } catch (err) {
        return alert("Could not read this replay: " + err.message);
      }
      launchReplay(decoded, resp.you === 1 ? 1 : 0);
    });
  });

  $("#replay-list").on("click", ".rp-dl", function () {
    const row = $(this).closest(".rp-row");
    fetchReplay(row.data("id"), (resp) => {
      const meta = (() => {
        try { return JSON.parse(resp.data.split("\n")[1]); } catch (e) { return {}; }
      })();
      const names = meta.names || ["p1", "p2"];
      const d = new Date(meta.date || Date.now());
      const stamp = d.toISOString().slice(0, 10);
      const blob = new Blob([resp.data], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "cubewars-" + stamp + "-" + names[0] + "-vs-" + names[1] + ".txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 500);
    });
  });

  $("#replay-list").on("click", ".rp-keep", function () {
    const btn = $(this);
    const id = btn.closest(".rp-row").data("id");
    const keep = !btn.hasClass("kept");
    socket.emit("replay-keep", { token: localStorage.getItem("userToken"), id: id, keep: keep }, (resp) => {
      if (resp.error) return alert(resp.error);
      btn.toggleClass("kept", resp.keep).text(resp.keep ? "KEPT ✓" : "KEEP");
    });
  });

  $("#replays-btn").on("click", function () {
    if (isGuest()) return guestDeny("REPLAYS NEED AN ACCOUNT — LOG IN FROM SETTINGS");
    $("#back-btn").removeClass("no-hover").css("left", "-70px");
    $(".tabpage").css("right", "-85vw").removeClass("visible");
    $("#tabpage-5").css("right", "-0vw").addClass("visible");
    pg = 5;
    $("#main-header-text").text("REPLAYS");
    $("#main-footer").text("REWATCH YOUR RECENT MATCHES");
    loadReplayList();
  });

  $("#settings-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover").css("left", "-70px");
    // Hide every page first — settings can be reached with any page open.
    $(".tabpage").css("right", "-85vw").removeClass("visible");
    $("#tabpage-7").css("right", "-0vw");
    $("#tabpage-7").addClass("visible");
    pg = 7;
    $("#main-header-text").text("SETTINGS");
    $("#main-footer").text("TWEAK YOUR EXPERIENCE");
  });

  $("#ranked-btn").on("click", function () {
    if (isGuest()) return guestDeny("RANKED NEEDS AN ACCOUNT — LOG IN FROM SETTINGS");
    showLoad();
    socket.emit(
      "requestRankData",
      localStorage.getItem("userToken"),
      (response) => {
        console.log(response);
        hideLoad();

        if (response.error) {
          forceLogOut(response.error);
          return;
        }

        const rating = response.data.rankedRating || 0;
        const gamesPlayed = response.data.rankedGamesPlayed || 0;
        const wins = response.data.wins || 0;
        $("#tl-substats").text(
          "RATING: " + rating + " · GAMES WON: " + wins + " / " + gamesPlayed + " (" +
            (gamesPlayed ? Math.round((wins / gamesPlayed) * 100) : 0) + "%)"
        );

        const rankInfo = calculateRankInfo(rating);

        // Determine base gradient
        const gradientColors = rankColors[rankInfo.name.toUpperCase()] || [
          "#ffffff",
          "#dddddd",
        ];
        const gradientCSS = `linear-gradient(to right, ${gradientColors[0]}, ${gradientColors[1]})`;

        // Apply to progress bar
        $("#rating-bar-fill").css("background", gradientCSS);
        const glowColor = gradientColors[1];

        // Apply soft glow to the entire rating-box
        // Update rating number
        $("#meter-rating").text(rating);

        // Update rank name
        const rankText = rankInfo.division
          ? `${rankInfo.name} ${rankInfo.division}`
          : rankInfo.name;
        $("#rank-label").text(`RANK: ${rankText}`);

        // Update thresholds
        $("#threshold-low").text(`${rankInfo.lower}`);
        $("#threshold-high").text(
          rankInfo.upper ? `${rankInfo.upper}` : "MAX"
        );

        // Update progress bar
        const percent = rankInfo.upper
          ? ((rating - rankInfo.lower) / (rankInfo.upper - rankInfo.lower)) *
            100
          : 100;
        $("#rating-bar-fill").css("width", `${percent}%`);

        // Update progress text
        const nextDivision = getNextDivision(rankInfo);
        const progressText = rankInfo.upper
          ? `${rankInfo.upper - rating} TO ${nextDivision}`
          : "MAXED OUT";
        $("#progress-label").text(progressText);

        // Final UI transitions
        $("#back-btn").removeClass("no-hover").css("left", "-70px");
        $("#tabpage-2").css("right", "-85vw").removeClass("visible");
        $("#tabpage-3").css("right", "0vw").addClass("visible");
        pg = 3;
        $("#tabpage-3").scrollTop(0);
        $("#main-header-text").text("THE TESSERACT");
        $("#main-footer").text("CLIMB THE RANKS IN 1v1 MATCHUPS");
      }
    );
  });

  function forceLogOut(data) {
    alert("Critical error: " + data);
    clearUserData();
    location.reload();
    hideBox("login-box");
    showBox("register-box");
  }

  function getNextDivision(rankInfo) {
    const order = ["I", "II", "III"];
    const nextIndex = order.indexOf(rankInfo.division) + 1;
    const nextDivision = nextIndex < order.length ? order[nextIndex] : null;

    return rankInfo.name === "TRANSCENDENT"
      ? "MAXED OUT"
      : nextDivision
      ? `${rankInfo.name} ${nextDivision}`
      : getNextRankName(rankInfo.name) + " I";
  }

  function getNextRankName(currentName) {
    const rankNames = ranks.map((r) => r.name);
    const i = rankNames.indexOf(currentName);
    return rankNames[i + 1] || "TRANSCENDENT";
  }

  $("#about-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover").css("left", "-70px");
    $(".tabpage").css("right", "-85vw").removeClass("visible");
    $("#tabpage-8").css("right", "-0vw");
    $("#tabpage-8").addClass("visible");
    pg = 8;
    $("#tabpage-8").scrollTop(0);
    $("#main-header-text").text("ABOUT");
    $("#main-footer").text("ABOUT CUBE WARS");
  });

  $("#back-btn").on("click", function () {
    if (pg === 2) {
      $("#back-btn").addClass("no-hover").css("left", "-270px");
      $("#tabpage-2").css("right", "-85vw");
      $("#tabpage-1").css("right", "0vw");
      $("#tabpage-2").removeClass("visible");
      $("#tabpage-1").addClass("visible");
      pg = 1;
      $("#main-header-text").text("HOME");
      $("#main-footer").text("CUBE WARS HOME");
    }
    if (pg === 7) {
      $("#back-btn").addClass("no-hover").css("left", "-270px");
      $("#tabpage-7").css("right", "-85vw");
      $("#tabpage-1").css("right", "0vw");
      $("#tabpage-7").removeClass("visible");
      $("#tabpage-1").addClass("visible");
      pg = 1;
      $("#main-header-text").text("HOME");
      $("#main-footer").text("CUBE WARS HOME");
    }
    if (pg === 8) {
      $("#back-btn").addClass("no-hover").css("left", "-270px");
      $("#tabpage-8").css("right", "-85vw");
      $("#tabpage-1").css("right", "0vw");
      $("#tabpage-8").removeClass("visible");
      $("#tabpage-1").addClass("visible");
      pg = 1;
      $("#main-header-text").text("HOME");
      $("#main-footer").text("CUBE WARS HOME");
    }
    if (pg === 4) {
      socket.emit("custom-cancel");
      resetCustomUI();
      $("#tabpage-4").css("right", "-85vw").removeClass("visible");
      $("#tabpage-2").css("right", "0vw").addClass("visible");
      pg = 2;
      $("#main-header-text").text("PLAY");
      $("#main-footer").text("SELECT A GAME MODE!");
    }
    if (pg === 5) {
      $("#tabpage-5").css("right", "-85vw").removeClass("visible");
      $("#tabpage-2").css("right", "0vw").addClass("visible");
      pg = 2;
      $("#main-header-text").text("PLAY");
      $("#main-footer").text("SELECT A GAME MODE!");
    }
    if (pg === 3 && mm == 0) {
      $("#tabpage-3").css("right", "-85vw");
      $("#tabpage-2").css("right", "0vw");
      $("#tabpage-3").removeClass("visible");
      $("#tabpage-2").addClass("visible");
      pg = 2;
      $("#main-header-text").text("PLAY");
      $("#main-footer").text("SELECT A GAME MODE!");
    }
  });

  // Handle "NOT YOU?" button click
  $("#switch-user-btn").on("click", function () {
    clearUserData();
    hideBox("login-box");
    showBox("register-box");
  });

  document
    .getElementById("username-input")
    .addEventListener("input", function (e) {
      var start = this.selectionStart;
      var end = this.selectionEnd;

      // Convert text to lowercase
      this.value = this.value.toLowerCase();

      // Restore the selection range
      this.setSelectionRange(start, end);
    });

  socket.on("tokenReturn", (data) => {
    console.log(data);
    if (data == "invalid") {
      forceLogOut("User session is invalid. Please register or log in again.");
    }
  });

  // Handle "CONTINUE" button click in registration
  $("#continue-btn").on("click", function () {
    const username = $("#username-input").val().trim();
    // The register copy promises it: blank username = play as a guest.
    if (!username) return enterGuestMode();
    if (!validateUsername(username)) {
      $("#reg1-notice").text("Username must be between 3 and 20 characters.");
      return;
    }
    $("#reg-notice").text(""); // Replace with custom UI as needed
    showLoad();
    socket.emit("check-username", { username }, (response) => {
      console.log(response);
      hideLoad();

      if (response.error !== undefined) {
        $("#reg1-notice").text(response.error);
        return;
      }

      if (response.exists) {
        console.log("Username exists");
        // Username exists, prompt for password
        hideBox("register-box");
        showBox("register-step3-box");
      } else {
        // Username does not exist, prompt for registration
        hideBox("register-box");
        showBox("register-step2-box");
        $("#register-btn")
          .off("click")
          .on("click", function () {
            const password = $("#password-input").val();
            const email = $("#email-input").val();
            if (!validatePassword(password)) {
              $("#reg2-notice").text(
                "Password must be between 6 and 20 characters."
              );
              return;
            }
            if (email && !validateEmail(email)) {
              $("#reg2-notice").text("Invalid email format.");
              return;
            }
            registerUser(username, password, email);
          });
      }
    });
  });

  // Handle "BACK" button click in registration step 2
  $("#back-reg1").on("click", function () {
    hideBox("register-step2-box");
    showBox("register-box");
  });

  $("#back-login").on("click", function () {
    hideBox("register-step3-box");
    showBox("register-box");
  });

  $("#login1-btn").on("click", function () {
    const username = $("#username-input").val();
    const password = $("#login-password-input").val();
    if (!validatePassword(password)) {
      $("#reg3-notice").text("Password must be between 6 and 20 characters.");
      return;
    }
    showLoad();
    console.log(username);
    console.log(password);
    loginUser(username, password);
  });

  // Handle test write button click
  $("#testWriteButton").on("click", function () {
    socket.emit("test-db-write", {
      username: "test_user",
      score: Math.floor(Math.random() * 100),
      timestamp: new Date().toISOString(),
    });
  });

  // Show loading modal on page load
  showLoad();
});

function createPreloadParticles(container) {
  const particles = [];

  for (let i = 0; i < 50; i++) {
    const p = createParticle();
    p.x = Math.random() * window.innerWidth;
    p.y = Math.random() * window.innerHeight;
    container.addChild(p);
    particles.push(p);
  }

  app.ticker.add(() => {
    particles.forEach((p) => {
      p.y -= p.speed;
      p.alpha -= 0.005;
      if (p.alpha <= 0) {
        p.x = Math.random() * window.innerWidth;
        p.y = window.innerHeight + Math.random() * 100;
        p.alpha = 1;
      }
    });
  });
}

function createGameParticles(container) {
  const particles = [];

  for (let i = 0; i < 30; i++) {
    const p = createParticle(0x00ffcc); // Different color for game
    p.x = Math.random() * window.innerWidth;
    p.y = Math.random() * window.innerHeight;
    container.addChild(p);
    particles.push(p);
  }

  app.ticker.add(() => {
    particles.forEach((p) => {
      p.x += Math.sin(p.rotation) * 0.5;
      p.y -= p.speed;
      p.alpha -= 0.004;
      if (p.alpha <= 0) {
        p.x = Math.random() * window.innerWidth;
        p.y = window.innerHeight + Math.random() * 100;
        p.alpha = 1;
      }
    });
  });
}
