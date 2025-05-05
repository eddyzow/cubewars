// main.js

// Determine build environment
const build = "prod"; // Change to "prod" for production

// Initialize socket connection
const socket =
  build === "dev" ? io() : io("https://cubewars-826c3a3278db.herokuapp.com");

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
  $("#preload").css({
    opacity: "0",
    visibility: "hidden",
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
      hidePreload();
      showBox("game-container");
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
      hidePreload();
      showBox("game-container");
    } else {
      $("#reg2-notice").text(response.error);
    }
  });
}

// Document ready
$(document).ready(function () {
  // Handle socket connection
  socket.on("connect", () => {
    updateConnectionIndicator(true);
    ping();
    hideLoad();
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
      hidePreload();
      showBox("game-container");
    } else {
      alert("User session is invalid. Please register or log in again.");
      clearUserData();
      hideBox("login-box");
      showBox("register-box");
    }
  });

  // Handle "NOT YOU?" button click
  $("#switch-user-btn").on("click", function () {
    clearUserData();
    hideBox("login-box");
    showBox("register-box");
  });

  socket.on("tokenReturn", (data) => {
    console.log(data);
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
