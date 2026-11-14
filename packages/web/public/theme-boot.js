// Applies the theme before the first paint (no flash): the saved choice, else the theme of the
// operating system. "scuro" is the base theme (no data-theme attribute). An external file,
// because the Content-Security-Policy of the server blocks inline scripts.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("cb-theme");
  } catch (e) {}
  // themes of earlier versions: the light ones become "chiaro", "notte" becomes "scuro"
  if (theme === "carta" || theme === "ufficio" || theme === "colorato") theme = "chiaro";
  if (theme === "notte") theme = "scuro";
  if (theme !== "chiaro" && theme !== "scuro") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "scuro" : "chiaro";
  }
  if (theme === "chiaro") document.documentElement.setAttribute("data-theme", "chiaro");
})();
