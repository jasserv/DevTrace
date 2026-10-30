// Applies the last known appearance before React renders, preventing a flash of the wrong
// theme. The SQLite setting remains the source of truth; the app refreshes this cache
// (localStorage "devtrace.appearance") every time settings load or change.
(function () {
  var root = document.documentElement;
  try {
    var cached = JSON.parse(localStorage.getItem("devtrace.appearance") || "{}");
    var preference = cached.theme === "light" || cached.theme === "dark" ? cached.theme : "system";
    var dark =
      preference === "dark" ||
      (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    if (cached.reduceMotion === true) root.setAttribute("data-reduce-motion", "true");
  } catch (error) {
    root.setAttribute("data-theme", "light");
  }
})();
