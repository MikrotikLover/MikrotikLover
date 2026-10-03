// Dashboard: headcount, today's attendance, 14-day attendance trend, pending work, payroll and loans.
// Sections appear only when the user may see the underlying module (the API leaves them out otherwise).
import { get } from '../core/api.js';
import { h, fdate, money } from '../core/dom.js';
import { go } from '../core/router.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
// Categorical slots (validated: CVD-safe adjacent pairs; aqua is below 3:1 so a legend, tooltip and table view accompany it)
const SERIES = [['present', 'Present', '#2a78d6'], ['absent', 'Absent', '#eb6834'], ['on_leave', 'On leave', '#1baf7a']];
const MONTH = (m) => new Date(m + 'T12:00:00').toLocaleString('en-GB', { month: 'short', year: 'numeric' });

/** Stacked bars (one per day) with hover tooltip; a toggle swaps in a table view. */
function trendChart(trend) {
  const W = 640, H = 200, padL = 30, padB = 22, padT = 8;
  const max = Math.max(1, ...trend.map((d) => d.present + d.absent + d.on_leave));
  const step = Math.ceil(max / 4) || 1;
  const top = step * 4;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const bw = (W - padL) / trend.length;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend', role: 'img', 'aria-label': 'Attendance for the last 14 days' });
  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: 'gridline' }), s('text', { x: padL - 6, y: y(v) + 3, class: 'tick', 'text-anchor': 'end' }, String(v)));
  }
  const tip = h('div', { class: 'viz-tip hidden' });
  trend.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.18;
    const w = bw * 0.64;
    let base = 0;
    const g = s('g');
    const segs = SERIES.filter(([k]) => d[k] > 0);
    segs.forEach(([k, , color], j) => {
      const y1 = y(base + d[k]);
      const y0 = y(base);
      const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between stacked segments
      const last = j === segs.length - 1;
      // 4px rounded data-end on the top segment only, anchored square on the baseline
      const r = last ? Math.min(4, hgt / 2, w / 2) : 0;
      const path = `M${x},${y0 - (j > 0 ? 2 : 0)} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0 - (j > 0 ? 2 : 0)} Z`;
      g.append(s('path', { d: path, fill: color }));
      base += d[k];
    });
    const dt = new Date(d.date + 'T12:00:00');
    if (i % 2 === 0 || trend.length <= 8) g.append(s('text', { x: x + w / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, `${dt.getDate()}/${dt.getMonth() + 1}`));
    // hit target: the full column, bigger than the mark
    const hit = s('rect', { x: padL + i * bw, y: padT, width: bw, height: H - padT - padB, fill: 'transparent' });
    hit.addEventListener('mouseenter', () => {
      tip.replaceChildren(h('b', null, dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })),
        ...SERIES.map(([k, l, c]) => h('div', null, h('i', { style: `background:${c}` }), `${l}: `, h('b', null, d[k]))),
        h('div', { class: 'muted' }, `Late: ${d.late}`));
      tip.classList.remove('hidden');
      tip.style.left = `${((padL + i * bw + bw / 2) / W) * 100}%`;
      g.classList.add('hover');
    });
    hit.addEventListener('mouseleave', () => { tip.classList.add('hidden'); g.classList.remove('hover'); });
    svg.append(g, hit);
  });
  const legend = h('div', { class: 'viz-legend' }, SERIES.map(([, l, c]) => h('span', null, h('i', { style: `background:${c}` }), l)));
  const table = h('table', { class: 'grid hidden' },
    h('thead', null, h('tr', null, h('th', null, 'Date'), ...SERIES.map(([, l]) => h('th', { class: 'num' }, l)), h('th', { class: 'num' }, 'Late'))),
    h('tbody', null, trend.map((d) => h('tr', null, h('td', null, fdate(d.date)), ...SERIES.map(([k]) => h('td', { class: 'num' }, d[k])), h('td', { class: 'num' }, d.late)))));
  const plot = h('div', { class: 'viz-plot' }, svg, tip);
  const toggle = h('button', { class: 'btn sm', type: 'button', onclick: () => {
    const showTable = table.classList.contains('hidden');
    table.classList.toggle('hidden', !showTable);
    plot.classList.toggle('hidden', showTable);
    toggle.textContent = showTable ? 'Chart' : 'Table';
  } }, 'Table');
  return { legend, toggle, body: h('div', null, plot, table) };
}

export default {
  async mount(root) {
    root.append(h('div', { class: 'muted' }, 'Loading…'));
    const d = await get('dashboard/summary');
    const t = d.totals;
    const card = (v, l, path) => h(path ? 'a' : 'div', { class: 'card' + (path ? ' link' : ''), href: path ? '#' + path : null },
      h('div', { class: 'v' }, v ?? 0), h('div', { class: 'l' }, l));
    const max = Math.max(1, ...d.by_department.map((x) => x.employees));
    const panel = (title, body, extra = null) => h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title), extra), h('div', { class: 'panel-body' }, body));

    const sections = [
      h('div', { class: 'cards' },
        card(t.active, 'Active employees', '/employees'),
        card(t.permanent, 'Permanent'),
        card(t.daily_wages, 'Daily wages'),
        card(t.contract, 'Contract'),
        card(t.joined_this_month, 'Joined this month'),
        card(t.inactive, 'Inactive / left')),
      h('div', { class: 'cards' },
        card(d.today.present, "Today's present"),
        card(d.today.absent, "Today's absent"),
        card(d.today.on_leave, 'On leave today'),
        card(d.today.late, 'Late today'),
        d.loans ? card(money(d.loans.balance), `Loans outstanding (${d.loans.active})`, '/loans') : null),
    ];

    const pend = (d.pending || []).filter((p) => p.count > 0);
    const row2 = [];
    if (d.trend) {
      const c = trendChart(d.trend);
      row2.push(panel('Attendance — last 14 days', c.body, h('span', { style: 'display:flex;gap:10px;align-items:center' }, c.legend, c.toggle)));
    }
    row2.push(panel('Needs attention', pend.length
      ? h('div', { class: 'todo' }, pend.map((p) => h('button', { class: 'todo-item', type: 'button', onclick: () => go(p.path) },
        h('b', null, p.count), h('span', null, p.label, p.note ? h('small', { class: 'muted' }, ' · ' + p.note) : null), h('span', { class: 'muted' }, '›'))))
      : h('div', { class: 'muted' }, '✓ Nothing pending.')));
    sections.push(h('div', { class: 'md', style: 'grid-template-columns:minmax(360px,1.6fr) minmax(260px,1fr)' }, ...row2));

    const row3 = [
      panel('Employees by Department', h('div', { class: 'bars' }, d.by_department.map((x) => h('div', { class: 'bar-row' },
        h('span', null, x.name, ' ', x.name_ur ? h('span', { class: 'urdu muted' }, x.name_ur) : null),
        h('div', { class: 'bar' }, h('span', { style: `width:${(x.employees / max) * 100}%` })),
        h('b', { class: 'num' }, x.employees))))),
    ];
    if (d.payroll) {
      row3.push(panel('Salary sheets (last 6 months)', d.payroll.length
        ? h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Employees'),
          h('th', { class: 'num' }, 'Net salary'), h('th', null, 'Status'))),
        h('tbody', null, d.payroll.map((p) => h('tr', null, h('td', null, MONTH(p.salary_month)), h('td', null, p.sheet_type === 'daily_wages' ? 'Daily Wages' : 'Permanent'),
          h('td', { class: 'num' }, p.employees), h('td', { class: 'num' }, money(p.net)),
          h('td', null, h('span', { class: 'badge ' + (p.status === 'posted' ? 'ok' : 'warn') }, p.status === 'posted' ? '✓ posted' : '✎ draft'))))))
        : h('div', { class: 'muted' }, 'No salary sheets in the last 6 months.')));
    }
    row3.push(panel('Upcoming Holidays', d.upcoming_holidays.length
      ? h('table', { class: 'grid' }, h('tbody', null, d.upcoming_holidays.map((x) => h('tr', null,
        h('td', null, fdate(x.holiday_date)), h('td', null, x.name), h('td', { class: 'urdu' }, x.name_ur || '')))))
      : h('div', { class: 'muted' }, 'No upcoming holidays.')));
    if (d.month_vouchers?.length) {
      const names = { ADV: 'Advances', INC: 'Incentives', PEN: 'Penalties' };
      row3.push(panel('This month’s vouchers (posted)', h('table', { class: 'grid' }, h('tbody', null, d.month_vouchers.map((v) =>
        h('tr', null, h('td', null, names[v.voucher_type] || v.voucher_type), h('td', { class: 'num' }, v.n), h('td', { class: 'num' }, money(v.amount))))))));
    }
    sections.push(h('div', { class: 'dash-grid' }, ...row3));
    root.replaceChildren(...sections.filter(Boolean));
  },
};
