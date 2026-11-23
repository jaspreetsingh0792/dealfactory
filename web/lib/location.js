// Where is the visitor? Three ways, from most to least private:
//  1. guessFromDevice(): time zone + browser language, computed locally (no network).
//  2. searchPlace(q):    the visitor types a city; looked up on OpenStreetMap Nominatim.
//  3. preciseLocation(): browser geolocation (asks permission), rounded, reverse-geocoded on Nominatim.
// Only country, region and city are kept; coordinates are discarded.

import { TZ_COUNTRY } from "./tz.js";

const EUR = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK".split(" ");
const CURRENCY = {
  ...Object.fromEntries(EUR.map((c) => [c, "EUR"])),
  US: "USD", GB: "GBP", CH: "CHF", LI: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK",
  HU: "HUF", RO: "RON", BG: "BGN", RS: "RSD", BA: "BAM", MK: "MKD", AL: "ALL", UA: "UAH", TR: "TRY", RU: "RUB",
  CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU", AU: "AUD", NZ: "NZD",
  JP: "JPY", CN: "CNY", HK: "HKD", TW: "TWD", KR: "KRW", SG: "SGD", MY: "MYR", TH: "THB", ID: "IDR", PH: "PHP",
  VN: "VND", IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD",
  BH: "BHD", OM: "OMR", IL: "ILS", EG: "EGP", MA: "MAD", TN: "TND", NG: "NGN", KE: "KES", GH: "GHS", ZA: "ZAR",
  ET: "ETB", TZ: "TZS", UG: "UGX",
};

export function currencyFor(country) {
  return CURRENCY[country] || null;
}

export function languageFor(country, fallback) {
  try {
    return new Intl.Locale(`und-${country}`).maximize().language;
  } catch {
    return fallback || null;
  }
}

export function countryName(code, locale) {
  try {
    return new Intl.DisplayNames([locale || navigator.language || "en"], { type: "region" }).of(code);
  } catch {
    return code;
  }
}

export function guessFromDevice(env = globalThis) {
  const tz = env.Intl?.DateTimeFormat().resolvedOptions().timeZone;
  const langs = env.navigator?.languages?.length ? env.navigator.languages : [env.navigator?.language].filter(Boolean);
  let fromLocale = null;
  for (const l of langs) {
    try {
      const r = new Intl.Locale(l).region;
      if (r) { fromLocale = r; break; }
    } catch { /* ignore */ }
  }
  const country = TZ_COUNTRY[tz] || fromLocale;
  if (!country) return null;
  return { country, currency: currencyFor(country), language: languageFor(country, langs[0]?.split("-")[0]),
           how: TZ_COUNTRY[tz] ? `time zone ${tz}` : `browser language ${langs[0]}` };
}

const NOMINATIM = "https://nominatim.openstreetmap.org";

function fromAddress(a, fallbackName) {
  const country = (a.country_code || "").toUpperCase() || null;
  return {
    country,
    region: a.state || a.province || a.region || null,
    city: a.city || a.town || a.village || a.municipality || a.county || fallbackName || null,
    currency: currencyFor(country),
    language: country ? languageFor(country) : null,
  };
}

// Nominatim policy: no autocomplete, max 1 request/second. We only call it on submit.
export async function searchPlace(q, lang) {
  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&featureType=settlement&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "Accept-Language": lang || "en" } });
  if (!r.ok) throw new Error(`Place search failed (HTTP ${r.status}).`);
  const rows = await r.json();
  return rows.map((row) => ({ label: row.display_name, ...fromAddress(row.address || {}, row.name) }));
}

export function preciseLocation(lang) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser has no location access."));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      // Rounded to ~1 km before it leaves the device.
      const lat = pos.coords.latitude.toFixed(2), lon = pos.coords.longitude.toFixed(2);
      try {
        const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lon}`,
          { headers: { "Accept-Language": lang || "en" } });
        if (!r.ok) throw new Error(`Location lookup failed (HTTP ${r.status}).`);
        const row = await r.json();
        resolve(fromAddress(row.address || {}, row.name));
      } catch (e) {
        reject(e);
      }
    }, (err) => reject(new Error(err.code === 1 ? "Location permission was denied." : "Could not get your location.")),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  });
}
