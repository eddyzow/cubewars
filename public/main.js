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
