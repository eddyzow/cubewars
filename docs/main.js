$(document).ready(function () {
  $("#start-btn").on("click", function () {
    $("#preload").hide();
    $("#game-container").show();
  });
  document.documentElement.scrollTop = 0;
  $("#logo").css("opacity", "1");
  $("#login-box").css("opacity", "1");
  $("#login-box").css("transform", "scale(1, 1)");
});
