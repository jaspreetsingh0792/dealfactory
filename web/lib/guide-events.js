const page = location.pathname === "/" ? "home" : "footmuffs";
const enabled = document.querySelector('meta[name="dealfactory-counts"]') !== null;
function count(event) {
  if (enabled && !navigator.globalPrivacyControl && navigator.doNotTrack !== "1") {
    navigator.sendBeacon?.(`/events?page=${page}&event=${event}`, "");
  }
}
count("view");
document.addEventListener("click", event => {
  const anchor = event.target.closest?.("a[href]");
  if (anchor && (anchor.hasAttribute("data-retailer") ||
      (anchor.closest("#results") && /^https?:$/.test(anchor.protocol) && anchor.origin !== location.origin))) {
    count("outbound");
  }
});
const share = document.querySelector("#share-guide");
if (share && (navigator.share || navigator.clipboard)) {
  share.hidden = false;
  share.addEventListener("click", async () => {
    const url = document.querySelector('link[rel="canonical"]').href + "?utm_source=reader&utm_medium=share";
    try {
      if (navigator.share) await navigator.share({title: document.title, url});
      else {
        await navigator.clipboard.writeText(url);
        share.textContent = "Guide link copied";
      }
      count("share");
    } catch (error) {
      if (error.name !== "AbortError") share.textContent = "Use your browser to share this guide";
    }
  });
}
