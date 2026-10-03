import { api } from '../core/api.js';
import { t, todayPK } from '../core/i18n.js';
import { can } from '../core/session.js';
import { loadLookups } from '../core/lookups.js';
import { esc, spinner, errorState } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { renderFields, mountFields } from '../core/formKit.js';
import { lineGrid } from '../core/lineGrid.js';
import { stockCache } from '../core/stockCache.js';
import { navigate } from '../app.js';
import { qtyFmt } from './vouchers/defs.js';

/**
 * Shared entry form for every voucher (#/v/<key>/new, #/v/<key>/<id>/edit).
 * Header (formKit) → line grid (lineGrid) → summary → remarks → Save, all on enterNav.
 *
 * Optional def hooks: noGrid (lines computed on the server), summary(env) → HTML or
 * Promise<HTML> shown under the grid, toForm(record) → record for editing,
 * extraStockWh(values) → more warehouses to load stock for, mount(env, form).
 */
export function voucherFormView(key, def) {
  return {
    title: (params) => `${t(def.title)} · ${t(params.id ? 'common.edit' : 'common.new')}`,
    render(main, params) {
      const isEdit = !!params.id;
      let nav = null;
      main.innerHTML = spinner();

      Promise.all([
        loadLookups(def.lookups),
        isEdit ? api.get(`${def.api}/${params.id}`) : Promise.resolve(null),
      ]).then(([lk, record]) => {
        if (record && record.status !== 'posted') {
          main.innerHTML = errorState(t('voucher.not_editable'));
          return;
        }
        const headerFields = [
          { key: 'voucher_date', label: 'f.date', type: 'text', inputType: 'date', required: true, default: () => todayPK() },
          ...def.header(),
        ];
        const remarksField = [{ key: 'remarks', label: 'f.remarks', type: 'textarea', max: 500 }];

        main.innerHTML = `
          <div class="voucher-bar">
            ${can(`${def.perm}.view`) ? `<a class="btn btn-ghost btn-sm" href="#/v/${key}">${icon('history', { size: 18 })}<span>${esc(t('voucher.all'))}</span></a>` : ''}
            <div class="last-saved" data-last hidden></div>
            ${record ? `<span class="pill" dir="ltr">${esc(record.voucher_no)}</span>` : ''}
          </div>
          <form class="card form voucher-form" autocomplete="off">
            <div class="form-grid">${renderFields(headerFields)}</div>
            ${def.noGrid ? '' : '<div data-grid></div>'}
            <div class="voucher-summary" data-summary hidden></div>
            <div class="form-grid">${renderFields(remarksField)}</div>
            <div class="form-actions">
              <a class="btn btn-ghost" href="${record ? `#/v/${key}/${record.id}` : `#/v/${key}`}">${esc(t('common.cancel'))}</a>
              <button type="submit" class="btn btn-primary">${icon('check', { size: 20 })}<span>${esc(t('common.save'))}</span></button>
            </div>
            <p class="kb-hint">${icon('keyboard', { size: 16 })}${esc(t('kb.hint'))}</p>
          </form>`;

        const form = main.querySelector('form');
        form.elements.voucher_date.max = todayPK();
        const ctx = mountFields(form, [...headerFields, ...remarksField], lk);
        const stock = stockCache();
        const itemsById = new Map(lk.items.map((i) => [String(i.value), i]));

        // In edit mode the voucher's own outflow is already in the ledger: add it back
        // so "available" shows what this voucher may use.
        const ownOut = new Map();
        const ownItems = new Set();
        if (record && def.toForm) record = def.toForm(record);
        if (record) {
          for (const l of record.lines) {
            ownItems.add(String(l.item_id));
            const it = itemsById.get(String(l.item_id));
            const lot = Number(it?.track_lots) ? l.lot_no : '';
            const k = `${l.item_id}|${lot}`;
            ownOut.set(k, (ownOut.get(k) || 0) + Number(l.qty ?? l.actual_qty ?? 0));
          }
        }

        const env = {
          lk, ctx, stock, grid: null,
          // Inward vouchers (IGP) add stock; all others issue from env.wh().
          outflow: def.stockWh({}) !== null,
          values: () => ctx.values(),
          wh: () => def.stockWh(ctx.values()),
          item: (row) => itemsById.get(String(row.get('item_id'))) || null,
          hasStock: (itemId) => {
            const wh = env.wh();
            if (!wh || ownItems.has(String(itemId))) return true;
            const a = stock.available(wh, itemId);
            return a === null || a > 0.0005;
          },
          available: (row) => {
            const it = env.item(row);
            const wh = env.wh();
            if (!it || !wh) return null;
            // Lot-tracked item: that lot's balance once a lot is typed, otherwise all lots.
            const typed = (row.get('lot_no') || '').trim();
            const lot = Number(it.track_lots) && typed !== '' ? typed : null;
            const a = stock.available(wh, it.value, lot);
            if (a === null) return null;
            let own = 0;
            if (record && String(def.stockWh(record)) === String(wh)) {
              for (const [k, q] of ownOut) {
                const [iid, l] = k.split('|');
                if (iid === String(it.value) && (lot === null || l === lot)) own += q;
              }
            }
            return a + own;
          },
        };

        // Vouchers whose lines are computed (estimation) get an inert grid stand-in.
        const grid = def.noGrid
          ? { rows: () => [], getRows: () => [], setRows: () => {}, clear: () => {}, refreshOptions: () => {}, setFooter: () => {} }
          : lineGrid({ name: 'lines', columns: def.columns(env), onChange: () => recalc() });
        env.grid = grid;
        if (!def.noGrid) form.querySelector('[data-grid]').replaceWith(grid.el);

        const summaryEl = main.querySelector('[data-summary]');
        let summaryTimer = null;
        let summaryToken = 0;
        function renderSummary() {
          if (!def.summary) return;
          clearTimeout(summaryTimer);
          summaryTimer = setTimeout(async () => {
            const token = ++summaryToken;
            try {
              const html = await def.summary(env);
              if (token !== summaryToken) return;
              summaryEl.hidden = !html;
              summaryEl.innerHTML = html || '';
            } catch (err) {
              if (token !== summaryToken) return;
              summaryEl.hidden = false;
              summaryEl.innerHTML = `<div class="notice notice-warn">${esc(err.message)}</div>`;
            }
          }, def.noGrid ? 300 : 60);
        }
        env.refreshSummary = renderSummary;

        function recalc() {
          if (!def.noGrid) {
            const rows = grid.rows().filter((r) => !r.isEmpty()).map((r) => r.values());
            grid.setFooter(t('grid.total'), def.footer(rows, env));
          }
          renderSummary();
        }

        async function reloadStock() {
          const whs = [env.wh(), ...(def.extraStockWh?.(ctx.values()) || [])].filter(Boolean);
          if (!whs.length) return;
          await Promise.all(whs.map((w) => stock.load(w)));
          grid.refreshOptions();
          grid.rows().forEach((r) => r.refresh());
          renderSummary();
        }

        // Header side effects (party → ownership, machine → warehouse …) and stock reloads.
        let prev = ctx.values();
        form.addEventListener('change', (e) => {
          const name = e.target.name;
          if (!name || e.target.closest('[data-enter-grid]')) return;
          const cur = ctx.values();
          if (cur[name] === prev[name]) return;
          prev = cur;
          def.effects?.[name]?.(env);
          prev = ctx.values();
          reloadStock();
          recalc();
        });

        function applyDefaults() {
          ctx.setDefaults();
          ctx.setValues(def.defaults(env));
          prev = ctx.values();
        }

        if (record) {
          ctx.setValues(record);
          grid.setRows(def.toForm ? record.lines : record.lines.map((l) => ({ ...l, qty: qtyFmt(l.qty), ml_filled: l.ml_filled !== undefined ? qtyFmt(l.ml_filled) : undefined, rate: l.rate !== undefined ? Number(l.rate) : undefined })));
          prev = ctx.values();
        } else {
          applyDefaults();
        }
        ctx.snapshot();
        def.mount?.(env, form);
        recalc();
        reloadStock();

        const lastEl = main.querySelector('[data-last]');
        nav = EnterNav.attach(form, {
          resetAfterSave: !isEdit,
          successMessage: (res) => t('voucher.saved_no', { no: res.voucher_no }),
          collect: () => ({ ...ctx.collect(), lines: grid.getRows() }),
          onSave: async (data) => {
            const res = isEdit ? await api.put(`${def.api}/${params.id}`, data) : await api.post(def.api, data);
            stock.clear();
            return res;
          },
          onReset: () => {
            grid.clear();
            setTimeout(() => { prev = ctx.values(); recalc(); reloadStock(); }, 10);
          },
          onSaved: (res) => {
            if (isEdit) {
              navigate(`/v/${key}/${res.id}`);
              return;
            }
            lastEl.hidden = false;
            lastEl.innerHTML = `${esc(t('voucher.last_saved'))}: <a href="#/v/${key}/${res.id}" dir="ltr">${esc(res.voucher_no)}</a>
              <a class="btn btn-ghost btn-sm" href="#/v/${key}/${res.id}?print=1">${icon('printer', { size: 16 })}<span>${esc(t('voucher.print'))}</span></a>`;
          },
        });
      }).catch((err) => { main.innerHTML = errorState(err.message); });

      return () => nav?.destroy();
    },
  };
}
