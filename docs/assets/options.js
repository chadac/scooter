/* Client-side filtering for the option index — no build step, no dependency.
 * The rows carry a data-opt attribute (name + description, lowercased) so filtering is a
 * substring test over every whitespace-separated term the reader types. */
(function () {
  function init() {
    var input = document.querySelector(".opt-filter");
    var list = document.querySelector(".opt-list");
    if (!input || !list) return;
    var rows = Array.prototype.slice.call(list.querySelectorAll(".opt-row"));
    var count = document.querySelector(".opt-count");

    function apply() {
      var terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      rows.forEach(function (row) {
        var hay = row.getAttribute("data-opt") || "";
        var match = terms.every(function (t) { return hay.indexOf(t) !== -1; });
        row.hidden = !match;
        if (match) shown++;
      });
      if (count) {
        count.textContent = terms.length
          ? shown + " of " + rows.length + " options"
          : rows.length + " options";
      }
    }

    input.addEventListener("input", apply);
    apply();
  }
  // material's instant-navigation swaps content without a page load, so re-init per document.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(init);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
