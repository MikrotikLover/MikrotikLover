import { api } from '../core/api.js';
import { t, fmtNumber } from '../core/i18n.js';
import { can } from '../core/session.js';
import { loadLookups, invalidate, toOptions, findOpt } from '../core/lookups.js';
import { esc, spinner, errorState, toast, confirmDialog } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { renderFields, mountFields } from '../core/formKit.js';
import { lineGrid } from '../core/lineGrid.js';
import { PROCESS } from './masters/config.js';
import { navigate } from '../app.js';

const INCH_TO_M = 0.0254;

/** Same formula as app/services/InkService.php (server recalculates on save). */
export function inkMlPerMeter(coverage, gsm, widthInch, p) {
  const c = Number(coverage);
  const g = Number(gsm);
  const w = Number(widthInch);
  if (!(c > 0 && g > 0 && w > 0)) return 0;
  return Math.round(p.ml_per_sqm_full * (c / 100) * (w * INCH_TO_M) * (g / Math.max(1, p.reference_gsm)) * 10000) / 10000;
}

const HEADER_FIELDS = [
  { key: 'design_code', label: 'f.design_code', type: 'text', max: 30, dir: 'ltr', hint: 'f.code_auto', upper: true },
  { key: 'name', label: 'f.design_name', type: 'text', max: 120, required: true },
  { key: 'party_id', label: 'f.customer', type: 'lookup', set: 'parties', filter: (o) => o.is_customer || o.is_fabric_owner },
  { key: 'process_type', label: 'f.process_type', type: 'select', required: true, default: 'sublimation', options: PROCESS },
  { key: 'default_machine_id', label: 'f.default_machine', type: 'lookup', set: 'machines', filter: (o, v) => o.machine_type === v.process_type },
  { key: 'finished_item_id', label: 'f.finished_item', type: 'lookup', set: 'items', filter: (o) => o.item_type === 'finished_fabric' },
  { key: 'repeat_width_cm', label: 'f.repeat_width', type: 'number', min: 0, step: '0.01' },
  { key: 'repeat_height_cm', label: 'f.repeat_height', type: 'number', min: 0, step: '0.01' },
  { key: 'basis_gsm', label: 'f.basis_gsm', type: 'number', min: 0, step: '0.01', hint: 'f.basis_hint' },
  { key: 'basis_width_inch', label: 'f.basis_width', type: 'number', min: 0, step: '0.01' },
];
const FOOTER_FIELDS = [
  { key: 'remarks', label: 'f.remarks', type: 'textarea', max: 255 },
  { key: 'is_active', label: 'common.active', type: 'checkbox', default: true },
];

export default {
  title: (params) => `${t('setup.designs')} · ${t(params.id ? 'common.edit' : 'design.new')}`,
  render(main, params) {
    const isEdit = !!params.id;
    const manage = can('designs.manage');
    let nav = null;
    let pendingFile = null;
    let objectUrl = null;
    main.innerHTML = spinner();

    Promise.all([
      loadLookups(['parties', 'machines', 'items', 'ink_colours', 'ink_params']),
      isEdit ? api.get(`designs/${params.id}`) : Promise.resolve(null),
    ]).then(([lk, record]) => {
      const inkItems = lk.items.filter((i) => i.item_type === 'ink');
      const rateOf = (item) => (item && Number(item.unit_to_base) > 0 ? Number(item.rate) / Number(item.unit_to_base) : 0);

      main.innerHTML = `
        <form class="design-form" autocomplete="off">
          <fieldset class="plain" ${manage ? '' : 'disabled'}>
          <section class="card form">
            <div class="image-box">
              <div class="image-preview" data-preview>${icon('image', { size: 40 })}</div>
              <div class="image-actions">
                <label class="btn btn-ghost btn-sm file-btn">${icon('plus', { size: 18 })}<span>${esc(t('design.choose_image'))}</span>
                  <input type="file" name="image" accept="image/jpeg,image/png,image/webp" data-enter-skip hidden></label>
                <button type="button" class="btn btn-ghost btn-sm" data-remove-image hidden>${icon('trash', { size: 18 })}<span>${esc(t('design.remove_image'))}</span></button>
                <div class="field-hint">${esc(t('design.image_hint'))}</div>
                <div data-error-host data-image-error></div>
              </div>
            </div>
            <div class="form-grid">${renderFields(HEADER_FIELDS)}</div>
          </section>

          <section class="card form">
            <div class="section-head"><h2>${esc(t('design.ink_title'))}</h2>
              <button type="button" class="btn btn-ghost btn-sm" data-cmyk>${esc(t('design.load_cmyk'))}</button></div>
            <p class="field-hint">${esc(t('design.ink_hint', { ml: lk.ink_params.ml_per_sqm_full, gsm: lk.ink_params.reference_gsm }))}</p>
            <div data-inks></div>
          </section>

          <section class="card form">
            <h2>${esc(t('design.bom_title'))}</h2>
            <p class="field-hint">${esc(t('design.bom_hint'))}</p>
            <div data-bom></div>
          </section>

          <section class="card form">
            <div class="cost-summary" data-summary></div>
            <div class="form-grid">${renderFields(FOOTER_FIELDS)}</div>
            ${manage ? `<div class="form-actions">
              <a class="btn btn-ghost" href="#/designs">${esc(t('common.cancel'))}</a>
              <button type="submit" class="btn btn-primary">${icon('check', { size: 20 })}<span>${esc(t('common.save'))}</span></button></div>
              <p class="kb-hint">${icon('keyboard', { size: 16 })}${esc(t('kb.hint'))}</p>` : ''}
          </section>
          </fieldset>
        </form>`;

      const form = main.querySelector('form');
      const allFields = [...HEADER_FIELDS, ...FOOTER_FIELDS];
      const ctx = mountFields(form, allFields, lk);
      const v = () => ctx.values();

      /* ---------------------------------------------------- ink grid */
      const colourOpt = (row) => findOpt(lk.ink_colours, row.get('ink_colour_id'));
      const inkItemFor = (row) => {
        const chosen = findOpt(inkItems, row.get('item_id'));
        if (chosen) return chosen;
        const colour = Number(row.get('ink_colour_id'));
        const proc = v().process_type;
        const candidates = inkItems.filter((i) => i.ink_colour_id === colour && (i.process_type === proc || i.process_type === 'any'));
        return candidates.find((i) => i.process_type === proc) || candidates[0] || null;
      };
      const rowMl = (row) => (row.get('is_manual') ? Number(row.get('ml_per_meter')) || 0
        : inkMlPerMeter(row.get('coverage_pct'), v().basis_gsm, v().basis_width_inch, lk.ink_params));
      const rowInkCost = (row) => (rowMl(row) / 1000) * rateOf(inkItemFor(row));

      const inks = lineGrid({
        name: 'inks',
        addLabel: t('design.add_colour'),
        columns: [
          { key: 'ink_colour_id', label: t('f.colour'), type: 'lookup', rowKey: true,
            options: () => toOptions(lk.ink_colours), onChange: (row) => row.combo('item_id').setOptions(inkOptions(row)) },
          { key: 'coverage_pct', label: t('f.coverage'), type: 'number', step: '0.01', min: 0, max: 100 },
          { key: 'is_manual', label: t('f.manual_ml'), type: 'checkbox' },
          { key: 'ml_per_meter', label: t('f.ml_per_meter'), type: 'number', step: '0.0001', min: 0, readonly: (row) => !row.get('is_manual') },
          { key: 'item_id', label: t('f.ink_item'), type: 'lookup', placeholder: t('design.default_ink'), options: (row) => inkOptions(row) },
          { key: 'cost', label: t('f.cost_per_meter'), type: 'display', format: (row) => (row.isEmpty() ? '' : fmtNumber(rowInkCost(row), 2)) },
        ],
        onChange: () => recalc(),
      });
      function inkOptions(row) {
        const colour = Number(row.get('ink_colour_id'));
        const proc = v().process_type;
        return toOptions(inkItems, (i) => (!colour || i.ink_colour_id === colour) && (i.process_type === proc || i.process_type === 'any' || !i.process_type));
      }
      main.querySelector('[data-inks]').replaceWith(inks.el);

      /* ---------------------------------------------------- BOM grid */
      const bomItem = (row) => findOpt(lk.items, row.get('item_id'));
      const bomCost = (row) => {
        const it = bomItem(row);
        return it ? Number(row.get('qty_per_meter') || 0) * (1 + Number(row.get('wastage_pct') || 0) / 100) * Number(it.rate || 0) : 0;
      };
      const bom = lineGrid({
        name: 'bom',
        addLabel: t('design.add_material'),
        columns: [
          { key: 'item_id', label: t('f.material'), type: 'lookup', rowKey: true,
            options: () => toOptions(lk.items, (i) => ['paper', 'chemical', 'other'].includes(i.item_type)) },
          { key: 'qty_per_meter', label: t('f.qty_per_meter'), type: 'number', step: '0.000001', min: 0 },
          { key: 'wastage_pct', label: t('f.wastage'), type: 'number', step: '0.01', min: 0, max: 100 },
          { key: 'unit', label: t('f.unit'), type: 'display', format: (row) => bomItem(row)?.unit_code || '' },
          { key: 'cost', label: t('f.cost_per_meter'), type: 'display', format: (row) => (bomItem(row) ? fmtNumber(bomCost(row), 2) : '') },
        ],
        onChange: () => recalc(),
      });
      main.querySelector('[data-bom]').replaceWith(bom.el);

      /* ---------------------------------------------------- totals */
      let recalcing = false;
      function recalc() {
        if (recalcing) return;
        recalcing = true;
        let cov = 0; let ml = 0; let inkCost = 0; let colours = 0;
        for (const row of inks.rows()) {
          if (!row.get('is_manual')) {
            const calc = inkMlPerMeter(row.get('coverage_pct'), v().basis_gsm, v().basis_width_inch, lk.ink_params);
            row.input('ml_per_meter').value = row.isEmpty() || !calc ? '' : String(calc);
          }
          row.refresh();
          if (row.isEmpty()) continue;
          colours += 1;
          cov += Number(row.get('coverage_pct')) || 0;
          ml += rowMl(row);
          inkCost += rowInkCost(row);
        }
        let matCost = 0;
        for (const row of bom.rows()) { row.refresh(); if (!row.isEmpty()) matCost += bomCost(row); }
        inks.setFooter(t('grid.total'), { coverage_pct: `${fmtNumber(cov, 2)}%`, ml_per_meter: fmtNumber(ml, 4), cost: fmtNumber(inkCost, 2) });
        bom.setFooter(t('grid.total'), { cost: fmtNumber(matCost, 2) });
        main.querySelector('[data-summary]').innerHTML = `
          <div><span>${esc(t('design.colours'))}</span><strong dir="ltr">${colours}</strong></div>
          <div><span>${esc(t('design.ink_ml_m'))}</span><strong dir="ltr">${fmtNumber(ml, 2)} ml</strong></div>
          <div><span>${esc(t('design.ink_cost_m'))}</span><strong dir="ltr">Rs ${fmtNumber(inkCost, 2)}</strong></div>
          <div><span>${esc(t('design.bom_cost_m'))}</span><strong dir="ltr">Rs ${fmtNumber(matCost, 2)}</strong></div>
          <div class="total"><span>${esc(t('design.material_cost_m'))}</span><strong dir="ltr">Rs ${fmtNumber(inkCost + matCost, 2)}</strong></div>`;
        recalcing = false;
      }

      form.addEventListener('input', (e) => { if (['basis_gsm', 'basis_width_inch'].includes(e.target.name)) recalc(); });
      form.addEventListener('change', (e) => {
        if (e.target.name === 'process_type') { inks.refreshOptions(); recalc(); }
        if (e.target.name === 'finished_item_id') {
          // Prefill basis GSM / width from the finished fabric when empty.
          const it = findOpt(lk.items, e.target.value);
          if (it) {
            if (!form.elements.basis_gsm.value && it.gsm) form.elements.basis_gsm.value = Number(it.gsm);
            if (!form.elements.basis_width_inch.value && it.width_inch) form.elements.basis_width_inch.value = Number(it.width_inch);
            recalc();
          }
        }
      });

      main.querySelector('[data-cmyk]').addEventListener('click', () => {
        const have = new Set(inks.rows().map((r) => r.get('ink_colour_id')).filter(Boolean));
        const cmyk = ['C', 'M', 'Y', 'K'].map((c) => lk.ink_colours.find((o) => o.code === c)).filter((o) => o && !have.has(String(o.value)));
        const kept = inks.getRows();
        inks.setRows([...kept, ...cmyk.map((o) => ({ ink_colour_id: o.value }))]);
        inks.refreshOptions();
        recalc();
        inks.rows().find((r) => !r.get('coverage_pct'))?.input('coverage_pct').focus();
      });

      /* ---------------------------------------------------- image */
      const preview = main.querySelector('[data-preview]');
      const removeBtn = main.querySelector('[data-remove-image]');
      const fileInput = form.elements.image;
      const imageError = main.querySelector('[data-image-error]');
      const showImage = (url) => {
        preview.innerHTML = url ? `<img src="${esc(url)}" alt="">` : icon('image', { size: 40 });
        removeBtn.hidden = !url || !manage;
      };
      fileInput.addEventListener('change', async () => {
        imageError.innerHTML = '';
        const file = fileInput.files[0];
        if (!file) return;
        if (!isEdit) {
          pendingFile = file;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(file);
          showImage(objectUrl);
          return;
        }
        try {
          const res = await uploadImage(params.id, file);
          showImage(res.thumb_url);
          toast(t('design.image_saved'), 'success');
        } catch (err) {
          imageError.innerHTML = `<div class="field-error">${esc(err.errors?.image || err.message)}</div>`;
        } finally {
          fileInput.value = '';
        }
      });
      removeBtn.addEventListener('click', async () => {
        if (!isEdit) { pendingFile = null; showImage(null); return; }
        if (!(await confirmDialog({ message: t('design.remove_image_confirm'), danger: true, confirmText: t('common.delete') }))) return;
        try {
          await api.del(`designs/${params.id}/image`);
          showImage(null);
        } catch (err) { toast(err.message, 'error'); }
      });
      function uploadImage(id, file) {
        const fd = new FormData();
        fd.append('image', file);
        return api.upload(`designs/${id}/image`, fd);
      }

      /* ---------------------------------------------------- load / save */
      if (record) {
        ctx.setValues(record);
        inks.setRows(record.inks.map((l) => ({ ...l, ml_per_meter: Number(l.ml_per_meter) })));
        inks.refreshOptions();
        bom.setRows(record.bom);
        showImage(record.thumb_url);
      } else {
        ctx.setDefaults();
      }
      ctx.snapshot();
      recalc();

      if (!manage) return;
      nav = EnterNav.attach(form, {
        resetAfterSave: !isEdit,
        successMessage: (res) => t('design.saved', { code: res.design_code }),
        collect: () => ({
          ...ctx.collect(),
          inks: inks.getRows().map((l) => ({ ...l, item_id: l.item_id || null, ml_per_meter: l.is_manual ? l.ml_per_meter : null })),
          bom: bom.getRows(),
        }),
        onSave: async (data) => {
          const res = isEdit ? await api.put(`designs/${params.id}`, data) : await api.post('designs', data);
          invalidate('designs');
          if (!isEdit && pendingFile) {
            try {
              await uploadImage(res.id, pendingFile);
            } catch (err) {
              // Design is saved; open it so the image can be retried there.
              toast(`${t('design.image_failed')} ${err.errors?.image || err.message}`, 'error');
              setTimeout(() => navigate(`/designs/${res.id}`), 0);
            }
          }
          return res;
        },
        onReset: () => {
          inks.clear();
          bom.clear();
          pendingFile = null;
          showImage(null);
          setTimeout(recalc, 10);
        },
        onSaved: () => { if (isEdit) navigate('/designs'); },
      });
    }).catch((err) => { main.innerHTML = errorState(err.message); });

    return () => {
      nav?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  },
};
