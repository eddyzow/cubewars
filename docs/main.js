$(document).ready(function () {
  document.documentElement.scrollTop = 0;
  $("#logo").css("opacity", "1");

  const hasUserToken = true; // 🔄 Replace this later with your actual logic

  if (hasUserToken) {
    showBox("login-box");
  } else {
    showBox("register-box");
  }

  $("#start-btn").on("click", function () {});

  $("#continue-btn").on("click", function () {
    // Check validity of username. If exists:
    hideBox("register-box");
    showBox("register-step2-box");
    // If does not exist:
  });
  $("#switch-user-btn").on("click", function () {
    hideBox("login-box");
    showBox("register-box");
  });
  $("#back-reg1").on("click", function () {
    hideBox("register-step2-box");
    showBox("register-box");
  });
});

function hideBox(name) {
  $("#" + name).css("opacity", "0");
  $("#" + name).css("visibility", "hidden");
  $("#" + name).css("transform", "scale(0)");
}
function showBox(name) {
  $("#" + name).css("opacity", "1");
  $("#" + name).css("visibility", "visible");
  $("#" + name).css("transform", "scale(1)");
}

const socket = io("https://cubewars-826c3a3278db.herokuapp.com");
const indicator = document.getElementById("connection-indicator");
const pingDisplay = document.getElementById("ping-display");

socket.on("connect", () => {
  indicator.classList.remove("pulsing-yellow");
  indicator.style.backgroundColor = "limegreen";
  indicator.style.boxShadow = "0 0 8px limegreen";
  pingDisplay.textContent = "—";
  ping();
});

socket.on("disconnect", () => {
  indicator.classList.add("pulsing-yellow");
  pingDisplay.textContent = "Reconnecting...";
  location.reload(); // IMPORTANT TODO: remove this for production
});

setInterval(() => {
  if (socket.connected) {
    ping();
  }
}, 2000);

function ping() {
  const start = Date.now();
  socket.emit("ping-check", () => {
    const latency = Date.now() - start;
    pingDisplay.textContent = `Connected to us-east-1. Ping: ${latency}ms`;
  });
}
