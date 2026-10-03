// Audit log viewer (read only): every create / update / delete / post / login with old and new values.
import { get } from '../core/api.js';
import { h, modal, fdate, today } from '../core/dom.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';

const ACTION_BADGE = { create: 'ok', update: 'info', delete: 'off', post: 'ok', unpost: 'warn', login: '', logout: '' };
const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const ago = (n) => { const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

export default {
  async mount(root) {
    const facets = await get('audit/facets');
    const form = new Form([
      { name: 'from', label: 'From', type: 'date', span: 2 },
      { name: 'to', label: 'To', type: 'date', span: 2 },
      { name: 'user_id', label: 'User', type: 'select', span: 2, numeric: true, blankLabel: 'All users', options: facets.users.map((u) => ({ value: u.id, label: u.username })) },
      { name: 'entity', label: 'Record type', type: 'select', span: 2, blankLabel: 'All', options: facets.entities.map((e) => ({ value: e, label: e })) },
      { name: 'action', label: 'Action', type: 'select', span: 2, blankLabel: 'All', options: facets.actions.map((a) => ({ value: a, label: a })) },
      { name: 'q', label: 'Search values / IP', span: 2, placeholder: 'e.g. 0005, 5000' },
    ]);
    form.values = { from: ago(30), to: today() };
    let page = 1;
    let pages = 1;
    const info = h('span');
    const btnPrev = h('button', { class: 'btn sm', type: 'button', onclick: () => { page--; load(); } }, '‹ Prev');
    const btnNext = h('button', { class: 'btn sm', type: 'button', onclick: () => { page++; load(); } }, 'Next ›');

    const grid = new DataGrid({
      columns: [
        { key: 'created_at', label: 'When', render: (r) => `${fdate(r.created_at)} ${r.created_at.slice(11, 19)}` },
        { key: 'username', label: 'User', render: (r) => r.username || '(system)' },
        { key: 'action', label: 'Action', render: (r) => h('span', { class: 'badge ' + (ACTION_BADGE[r.action] ?? '') }, r.action) },
        { key: 'entity', label: 'Record' },
        { key: 'entity_id', label: 'ID', align: 'right' },
        { key: 'summary', label: 'Values', render: (r) => h('span', { class: 'muted', style: 'display:inline-block;max-width:560px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom' }, r.summary || '') },
        { key: 'ip_address', label: 'IP' },
      ],
      onOpen: (r) => openEntry(r.id),
      emptyText: 'No audit entries for this filter.',
    });

    async function load() {
      const res = await get('audit', { ...form.values, page });
      pages = res.pages;
      page = res.page;
      grid.setRows(res.rows);
      info.textContent = `${res.total} entr${res.total === 1 ? 'y' : 'ies'} · page ${page} of ${pages}`;
      btnPrev.disabled = page <= 1;
      btnNext.disabled = page >= pages;
    }

    async function openEntry(id) {
      const a = await get(`audit/${id}`);
      const keys = [...new Set([...Object.keys(a.old_values || {}), ...Object.keys(a.new_values || {})])];
      const both = a.old_values && a.new_values;
      const body = keys.length
        ? h('table', { class: 'diff' }, h('thead', null, h('tr', null, h('th', null, 'Field'), both || a.old_values ? h('th', null, both ? 'Before' : 'Value (removed)') : null,
          both || a.new_values ? h('th', null, both ? 'After' : 'Value') : null)),
          h('tbody', null, keys.map((k) => h('tr', null, h('th', null, k),
            a.old_values ? h('td', { class: both ? 'old' : '' }, fmt(a.old_values[k])) : null,
            a.new_values ? h('td', { class: both ? 'new' : '' }, fmt(a.new_values[k])) : null))))
        : h('div', { class: 'muted' }, 'No field values recorded for this action.');
      modal({
        title: `${a.action} · ${a.entity}${a.entity_id ? ' #' + a.entity_id : ''}`,
        wide: true,
        body: h('div', null, h('p', { class: 'muted', style: 'margin:0 0 8px' },
          `${fdate(a.created_at)} ${a.created_at.slice(11, 19)} by ${a.full_name || a.username || 'system'} from ${a.ip_address || '—'}`), body,
        a.user_agent ? h('p', { class: 'lock-note', style: 'margin-top:8px' }, a.user_agent) : null),
        buttons: [{ label: 'Close', class: 'primary' }],
      });
    }

    async function logins() {
      const rows = await get('audit/logins');
      modal({
        title: 'Login attempts (last 30 days)',
        wide: true,
        body: h('div', { class: 'grid-wrap', style: 'max-height:60vh' }, h('table', { class: 'grid' },
          h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Username'), h('th', null, 'IP'), h('th', null, 'Result'))),
          h('tbody', null, rows.map((r) => h('tr', null, h('td', null, `${fdate(r.attempted_at)} ${r.attempted_at.slice(11, 19)}`), h('td', null, r.username),
            h('td', null, r.ip_address), h('td', null, h('span', { class: 'badge ' + (Number(r.success) ? 'ok' : 'off') }, Number(r.success) ? '✓ success' : '✕ failed'))))))),
        buttons: [{ label: 'Close', class: 'primary' }],
      });
    }

    const show = () => { page = 1; load(); };
    setKeys({ load: show, prev: () => { if (page > 1) { page--; load(); } }, next: () => { if (page < pages) { page++; load(); } } });
    form.el.addEventListener('change', show);
    root.append(
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: show }, 'Show ', h('kbd', null, 'F7')),
        h('button', { class: 'btn', type: 'button', onclick: logins }, 'Login attempts'), h('span', { class: 'spacer' }), info, btnPrev, btnNext),
      h('div', { class: 'panel', style: 'margin-bottom:10px' }, h('div', { class: 'panel-body' }, form.el)),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, grid.el,
        h('div', { class: 'grid-foot' }, 'Double-click / Enter a row to see the changed fields', h('span', { class: 'spacer' }), 'PgUp / PgDn: pages'))),
    );
    await load();
  },
};
