/* Demo videos play while on screen; a click opens one large. */
(function () {
  function init() {
    var videos = document.querySelectorAll(".scooter-demos video");
    if (!videos.length) return;
    if ("IntersectionObserver" in window) {
      var seen = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) e.target.play().catch(function () {});
          else e.target.pause();
        });
      }, { threshold: 0.4 });
      videos.forEach(function (v) { seen.observe(v); });
    }
    var dialog = document.createElement("dialog");
    dialog.className = "scooter-demo-zoom";
    dialog.innerHTML = '<video muted loop playsinline controls></video>';
    document.body.append(dialog);
    var big = dialog.querySelector("video");
    // A click outside the video lands on the dialog itself.
    dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", function () { big.pause(); big.removeAttribute("src"); big.load(); });
    videos.forEach(function (v) {
      v.addEventListener("click", function () {
        big.poster = v.poster;
        big.src = v.currentSrc || v.src;
        big.currentTime = v.currentTime;
        dialog.showModal();
        big.play().catch(function () {});
      });
    });
  }
  // Material's instant navigation swaps pages without a reload.
  if (window.document$) window.document$.subscribe(init);
  else document.addEventListener("DOMContentLoaded", init);
})();
