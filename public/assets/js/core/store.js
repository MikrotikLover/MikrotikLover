// Session + cached lookups (departments, designations, shifts ...).
import { get } from './api.js';

export const session = { user: null, permissions: {}, timeout: 1800, company: {} };
export const lookups = { departments: [], designations: [], shifts: [], shift_groups: [], roles: [], settings: {} };

export function can(module, action = 'view') {
  return (session.permissions[module] || []).includes(action);
}

export async function loadLookups() {
  Object.assign(lookups, await get('lookups'));
  return lookups;
}

/** Options helpers for selects. */
export const opt = {
  departments: (all = false) => lookups.departments.filter((d) => all || d.is_active).map((d) => ({ value: d.id, label: d.name })),
  designations: (all = false) => lookups.designations.filter((d) => all || d.is_active).map((d) => ({ value: d.id, label: d.name })),
  shifts: (all = false) => lookups.shifts.filter((s) => all || s.is_active)
    .map((s) => ({ value: s.id, label: `${s.code} - ${s.name} (${s.start_time.slice(0, 5)}-${s.end_time.slice(0, 5)})` })),
  shiftGroups: (all = false) => lookups.shift_groups.filter((s) => all || s.is_active).map((s) => ({ value: s.id, label: `${s.code} - ${s.name}` })),
  roles: () => lookups.roles.map((r) => ({ value: r.id, label: r.name })),
};
