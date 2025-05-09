// main.js

// Determine build environment
const build = "prod"; // Change to "prod" for production

// Initialize socket connection
const socket =
  build === "dev"
    ? io("localhost:3000")
    : io("https://cubewars-826c3a3278db.herokuapp.com");

if (build === "prod") {
  $("#dev-warning").remove();
}

let pg = 0;
let app;
let preloadLayer, gameLayer;

// DOM elements
const indicator = document.getElementById("connection-indicator");
const pingDisplay = document.getElementById("ping-display");

// Utility functions to show/hide loading modal
function showLoad() {
  $("#cube-3d-wrapper").css("transform", "scale(1)");
  $("#cube-modal").css("opacity", "1").css("visibility", "visible");
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

function hideLoad() {
  $("#cube-3d-wrapper").css("transform", "scale(0)");
  $("#cube-modal").css("opacity", "0").css("visibility", "hidden");
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
  socket.emit("ping-check", () => {
    const latency = Date.now() - start;
    pingDisplay.textContent = `Connected to us-east-1. Ping: ${latency}ms`;
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
    (Math.floor(Math.random() * 8) + 1).toString() +
    '.jpg")';
  hidePreload();
  showBox("home-container");
  pg = 1;
  $("#main-header-text").text("HOME");
  $("#main-footer").text("CUBE WARS HOME");
  $("#changelog").remove();
  $("#main-tabs").addClass("show");
  $("#tabpage-1").addClass("visible");
  $("#tabpage-1").css("right", "0vw");
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

  $("#play-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover");
    $("#back-btn").css("left", "-70px");
    $("#tabpage-1").css("right", "-85vw");
    $("#tabpage-2").css("right", "-0vw");
    $("#tabpage-1").removeClass("visible");
    $("#tabpage-2").addClass("visible");
    pg = 2;
    $("#main-header-text").text("PLAY");
    $("#main-footer").text("SELECT A GAME MODE!");
  });

  $("#settings-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover");
    $("#back-btn").css("left", "-70px");
    $("#tabpage-1").css("right", "-85vw");
    $("#tabpage-7").css("right", "-0vw");
    $("#tabpage-1").removeClass("visible");
    $("#tabpage-7").addClass("visible");
    pg = 7;
    $("#main-header-text").text("SETTINGS");
    $("#main-footer").text("TWEAK YOUR EXPERIENCE");
  });

  $("#about-btn").on("click", function () {
    $("#back-btn").removeClass("no-hover");
    $("#back-btn").css("left", "-70px");
    $("#tabpage-1").css("right", "-85vw");
    $("#tabpage-8").css("right", "-0vw");
    $("#tabpage-1").removeClass("visible");
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
      alert("User session is invalid. Please register or log in again.");
      clearUserData();
      location.reload();
      hideBox("login-box");
      showBox("register-box");
    }
  });

  // Handle "CONTINUE" button click in registration
  $("#continue-btn").on("click", function () {
    const username = $("#username-input").val().trim();
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
