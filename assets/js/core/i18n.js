/**
 * i18n — English / Urdu with RTL. Numbers and dates use Western digits
 * (standard on Pakistani business documents) in both languages.
 */
import en from '../i18n/en.js';
import ur from '../i18n/ur.js';

const dictionaries = { en, ur };
const STORAGE_KEY = 'fpms.lang';

function stored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

let lang = stored() === 'ur' ? 'ur' : 'en';

export function getLang() {
  return lang;
}

export function has(key) {
  return key in dictionaries[lang] || key in dictionaries.en;
}

export function t(key, vars = null) {
  let text = dictionaries[lang][key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** Applies lang + dir to <html>; fires a "langchange" event on window. */
export function setLang(next) {
  lang = next === 'ur' ? 'ur' : 'en';
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode */ }
  applyDocumentLang();
  window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}

export function applyDocumentLang() {
  const html = document.documentElement;
  html.lang = lang;
  html.dir = lang === 'ur' ? 'rtl' : 'ltr';
}

const numberFormatters = new Map();
export function fmtNumber(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (!numberFormatters.has(decimals)) {
    numberFormatters.set(decimals, new Intl.NumberFormat('en-PK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  }
  return numberFormatters.get(decimals).format(n);
}

export function fmtMoney(value) {
  return `Rs ${fmtNumber(value, 2)}`;
}

/** "2026-10-02" or "2026-10-02 14:05:00" → "02-10-2026" / "02-10-2026 2:05 PM" */
export function fmtDate(value, withTime = false) {
  if (!value) return '';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return String(value);
  let out = `${m[3]}-${m[2]}-${m[1]}`;
  if (withTime && m[4]) {
    const h = Number(m[4]);
    out += ` ${((h + 11) % 12) + 1}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return out;
}

/** Today's date in Asia/Karachi as YYYY-MM-DD regardless of device timezone. */
export function todayPK() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
