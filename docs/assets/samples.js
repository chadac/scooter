/* Demos autoplay on screen; clicking one opens its full view. */
(function () {
  var EXPAND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 21v-2H6.41l4.5-4.5-1.41-1.41-4.5 4.5V14H3v7h7m4.5-10.09 4.5-4.5V10h2V3h-7v2h3.59l-4.5 4.5 1.41 1.41Z"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z"/></svg>';
  // Demos by heading id plus the focus dialog; null elsewhere.
  var page = null;

  function init() {
    page = null;
    document.querySelectorAll(".scooter-demo-focus").forEach(function (d) { d.remove(); });
    var grid = document.querySelector(".scooter-demos");
    if (!grid) return;
    var videos = grid.querySelectorAll("video");
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
    dialog.className = "scooter-demo-focus md-typeset";
    dialog.innerHTML =
      '<header><h2></h2><button type="button" class="scooter-demo-close" ' +
      'aria-label="Back to all samples" title="Back to all samples (Esc)">' + CLOSE + "</button></header>" +
      '<p></p><div class="scooter-demo-stage"></div>';
    document.body.append(dialog);
    var stage = dialog.querySelector(".scooter-demo-stage");
    dialog.querySelector(".scooter-demo-close").addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("close", function () {
      stage.replaceChildren();
      if (!page || !page.demos[location.hash.slice(1)]) return;
      // Undo our own history entry so Back doesn't reopen it.
      if (page.pushed) history.back();
      else history.replaceState(history.state, "", location.pathname + location.search);
    });

    var demos = {};
    grid.querySelectorAll(":scope > div").forEach(function (card) {
      var h = card.querySelector("h2");
      if (!h || !h.id) return;
      demos[h.id] = card;
      var link = document.createElement("a");
      link.className = "scooter-demo-open";
      link.href = "#" + h.id;
      link.title = "Open full view";
      // The title link replaces the heading's permalink.
      Array.from(h.childNodes).forEach(function (n) {
        if (n.classList && n.classList.contains("headerlink")) n.remove();
        else link.append(n);
      });
      link.insertAdjacentHTML("beforeend", EXPAND);
      h.prepend(link);
      card.querySelectorAll("video").forEach(function (v) {
        v.title = "Open full view";
        v.addEventListener("click", function () { location.hash = h.id; });
      });
    });
    page = { demos: demos, dialog: dialog, stage: stage, pushed: false };
    sync(false);
  }

  // Shows the hash's demo, or the grid if none.
  function sync(pushed) {
    if (!page) return;
    var card = page.demos[location.hash.slice(1)];
    var dialog = page.dialog;
    if (!card) {
      if (dialog.open) dialog.close();
      return;
    }
    page.pushed = pushed;
    var link = card.querySelector(".scooter-demo-open");
    var desc = card.querySelector("p");
    dialog.querySelector("h2").textContent = link.textContent;
    dialog.querySelector("p").textContent = desc ? desc.textContent : "";
    var sources = card.querySelectorAll("video");
    page.stage.replaceChildren();
    sources.forEach(function (v) {
      var big = v.cloneNode();
      big.removeAttribute("title");
      big.controls = true;
      big.preload = "auto";
      page.stage.append(big);
    });
    if (!dialog.open) dialog.showModal();
    // Only the visible colour scheme's render plays.
    page.stage.querySelectorAll("video").forEach(function (big, i) {
      if (!big.getClientRects().length) return;
      big.currentTime = sources[i].currentTime;
      big.play().catch(function () {});
    });
  }

  window.addEventListener("hashchange", function () { sync(true); });
  // Material's instant navigation swaps pages without a reload.
  if (window.document$) window.document$.subscribe(init);
  else document.addEventListener("DOMContentLoaded", init);
})();
