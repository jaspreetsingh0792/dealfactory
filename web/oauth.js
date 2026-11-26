// OAuth callback: hand the result to the page that opened this window (same origin only), then close.
(function () {
  var result = { type: "dealfactory-oauth", search: location.search, hash: location.hash };
  // Don't leave tokens or codes in the address bar or history.
  history.replaceState(null, "", location.pathname);
  try {
    if (window.opener && window.opener.location.origin === location.origin) {
      window.opener.postMessage(result, location.origin);
      window.close();
      return;
    }
  } catch (e) { /* opener on another origin: fall through */ }
  try {
    var flow = JSON.parse(sessionStorage.getItem("dealfactory.oauth.flow"));
    if (flow && typeof flow.returnPath === "string") {
      var destination = new URL(flow.returnPath, location.origin);
      if (destination.origin === location.origin) {
        sessionStorage.setItem("dealfactory.oauth.pending", JSON.stringify(result));
        destination.hash = "connect";
        location.replace(destination.href);
        return;
      }
    }
  } catch (e) { /* The callback might have been opened separately. */ }
  try {
    if (typeof BroadcastChannel === "function") {
      var ch = new BroadcastChannel("dealfactory-oauth");
      ch.postMessage(result);
      ch.close();
      window.close();
      document.getElementById("msg").textContent = "Sign-in complete. You can close this window and return to DealFactory.";
      return;
    }
  } catch (e) { /* ignore */ }
  document.getElementById("msg").textContent = "Return to the shopping advisor and start sign-in again.";
})();
