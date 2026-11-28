/** Labelled shop links. Off unless the matching IDs are present. No click ids. */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const AMAZON_TAG = /^[A-Za-z0-9-]{1,40}$/;

const SHOPS = [
  { key: "COOLBLUE", retailers: ["coolblue"], hosts: ["coolblue.nl", "coolblue.be", "coolblue.de"] },
  { key: "BOL", retailers: ["bol", "bol.com"], hosts: ["bol.com"] },
  { key: "AMAZON_NL", retailers: ["amazon", "amazon.nl"], hosts: ["amazon.nl"], amazon: true },
  { key: "INSTALPUNT", retailers: ["instalpunt"], hosts: ["instalpunt.nl"] },
  { key: "AQARA", retailers: ["aqara"], hosts: ["aqara.com"] },
  { key: "BLAUWESTROOMSHOP", retailers: ["blauwestroomshop"], hosts: ["blauwestroomshop.nl"] },
];

export const DISCLOSURE = {
  en: "We may earn a commission at no extra cost to you. It never changes the ranking or the recommendations.",
  nl: "We kunnen een commissie ontvangen, zonder extra kosten voor jou. Het verandert de volgorde en de aanbevelingen niet.",
};

function clean(env, name, pattern) {
  const value = String(env?.[name] ?? "").trim();
  return pattern.test(value) ? value : "";
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shopFor(url, retailer) {
  const host = hostOf(url);
  if (!host) return null;
  const name = String(retailer || "").trim().toLowerCase();
  const byHost = SHOPS.find(shop => shop.hosts.some(item => host === item || host.endsWith(`.${item}`)));
  if (!byHost) return null;
  if (name && !byHost.retailers.includes(name)) return null;
  return byHost;
}

function networkOf(env, shop) {
  const value = String(env?.[`AFFILIATE_${shop.key}_NETWORK`] ?? "").trim().toLowerCase();
  return value === "awin" || value === "daisycon" || value === "tradetracker" ? value : "";
}

export function rewriteRetailerLink(url, retailer, env = {}) {
  const shop = shopFor(url, retailer);
  if (!shop) return { href: url, affiliate: false };
  if (shop.amazon) {
    const tag = clean(env, "AFFILIATE_AMAZON_NL_TAG", AMAZON_TAG);
    if (!tag || /[?&]tag=/.test(url)) return { href: url, affiliate: false };
    const join = url.includes("?") ? "&" : "?";
    return { href: `${url}${join}tag=${tag}`, affiliate: true };
  }
  const network = networkOf(env, shop);
  const merchant = clean(env, `AFFILIATE_${shop.key}_MERCHANT_ID`, ID);
  const material = clean(env, `AFFILIATE_${shop.key}_MATERIAL_ID`, ID);
  const destination = encodeURIComponent(url);
  if (network === "awin") {
    const publisher = clean(env, "AFFILIATE_AWIN_PUBLISHER_ID", ID);
    if (!publisher || !merchant) return { href: url, affiliate: false };
    return {
      href: `https://www.awin1.com/cread.php?awinmid=${merchant}&awinaffid=${publisher}&ued=${destination}`,
      affiliate: true,
    };
  }
  if (network === "daisycon") {
    const website = clean(env, "AFFILIATE_DAISYCON_WEBSITE_ID", ID);
    if (!website || !merchant) return { href: url, affiliate: false };
    const materialQuery = material ? `&li=${material}` : "";
    return {
      href: `https://ds1.nl/c/?wi=${website}&si=${merchant}${materialQuery}&dl=${destination}`,
      affiliate: true,
    };
  }
  if (network === "tradetracker") {
    const affiliate = clean(env, "AFFILIATE_TRADETRACKER_AFFILIATE_ID", ID);
    if (!affiliate || !merchant || !material) return { href: url, affiliate: false };
    return {
      href: `https://tc.tradetracker.net/?c=${merchant}&m=${material}&a=${affiliate}&u=${destination}`,
      affiliate: true,
    };
  }
  return { href: url, affiliate: false };
}

export function applyAffiliates(offers, env = {}) {
  return offers.map(offer => {
    const rewritten = rewriteRetailerLink(offer.url, offer.retailer, env);
    return { ...offer, href: rewritten.href, affiliate: rewritten.affiliate };
  });
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function renderOpenShop({ href, affiliate, dutch = false, className = "open-shop" }) {
  const shop = dutch ? "Open de winkel" : "Open shop";
  const label = dutch ? "Affiliatelink" : "Affiliate link";
  const rel = affiliate ? ' rel="sponsored nofollow noopener"' : "";
  const mark = affiliate ? `<span class="affiliate-label">${label}</span>` : "";
  return `<a class="${className}" data-retailer href="${escapeAttr(href)}"${rel}>${shop}</a>${mark}`;
}

/** Price and name only. Commission is not an input. */
export function sortOffers(offers, mode) {
  return [...offers].sort((a, b) => {
    if (mode === "name") return String(a.name).localeCompare(String(b.name));
    const amount = item => mode === "total" && item.total != null ? Number(item.total) : Number(String(item.price).replace(",", "."));
    const difference = amount(a) - amount(b);
    return mode === "desc" ? -difference : difference;
  });
}
