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

export function countryOptions(locale = "en") {
  const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const countries = [];
  for (const first of alphabet) {
    for (const second of alphabet) {
      const code = first + second;
      const name = names.of(code);
      if (name && code !== "ZZ") countries.push([code, name]);
    }
  }
  return countries.sort((a, b) => a[1].localeCompare(b[1], locale));
}
