/**
 * Cached dropdown data from GET lookups?sets=...
 * Call invalidate(set) after saving a master so the next form sees it.
 */
import { api } from './api.js';
import { getLang } from './i18n.js';

const cache = new Map();

export async function loadLookups(sets) {
  const missing = sets.filter((s) => !cache.has(s));
  if (missing.length) {
    const data = await api.get('lookups', { sets: missing.join(',') });
    for (const [k, v] of Object.entries(data)) cache.set(k, v);
  }
  return Object.fromEntries(sets.map((s) => [s, cache.get(s)]));
}

export function invalidate(...sets) {
  if (!sets.length) cache.clear();
  sets.forEach((s) => cache.delete(s));
}

/** Label in the current UI language (Urdu name when available). */
export function optLabel(o) {
  return getLang() === 'ur' && o.label_ur ? o.label_ur : o.label;
}

/** Lookup rows → searchSelect options, optionally filtered. */
export function toOptions(list, filter = null) {
  return (list || []).filter((o) => !filter || filter(o)).map((o) => ({ ...o, value: o.value, label: optLabel(o), sub: o.sub }));
}

export function findOpt(list, value) {
  return (list || []).find((o) => String(o.value) === String(value)) || null;
}
