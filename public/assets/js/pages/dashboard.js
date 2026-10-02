// Dashboard: headcount by department, today's attendance, upcoming holidays.
import { get } from '../core/api.js';
import { h, fdate } from '../core/dom.js';

export default {
  async mount(root) {
    root.append(h('div', { class: 'muted' }, 'Loading…'));
    const d = await get('dashboard/summary');
    const t = d.totals;
    const card = (v, l) => h('div', { class: 'card' }, h('div', { class: 'v' }, v ?? 0), h('div', { class: 'l' }, l));
    const max = Math.max(1, ...d.by_department.map((x) => x.employees));
    root.replaceChildren(
      h('div', { class: 'cards' },
        card(t.active, 'Active employees'),
        card(t.permanent, 'Permanent'),
        card(t.daily_wages, 'Daily wages'),
        card(t.contract, 'Contract'),
        card(t.joined_this_month, 'Joined this month'),
        card(t.inactive, 'Inactive / left')),
      h('div', { class: 'cards' },
        card(d.today.present, "Today's present"),
        card(d.today.absent, "Today's absent"),
        card(d.today.on_leave, 'On leave today'),
        card(d.today.late, 'Late today')),
      h('div', { class: 'md' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Employees by Department')),
          h('div', { class: 'panel-body bars' }, d.by_department.map((x) => h('div', { class: 'bar-row' },
            h('span', null, x.name, ' ', x.name_ur ? h('span', { class: 'urdu muted' }, x.name_ur) : null),
            h('div', { class: 'bar' }, h('span', { style: `width:${(x.employees / max) * 100}%` })),
            h('b', { class: 'num' }, x.employees))))),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Upcoming Holidays')),
          h('div', { class: 'panel-body' }, d.upcoming_holidays.length
            ? h('table', { class: 'grid' }, h('tbody', null, d.upcoming_holidays.map((x) => h('tr', null,
              h('td', null, fdate(x.holiday_date)), h('td', null, x.name), h('td', { class: 'urdu' }, x.name_ur || '')))))
            : h('div', { class: 'muted' }, 'No upcoming holidays.')))));
  },
};
