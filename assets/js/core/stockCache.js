/**
 * Per-warehouse stock balances for voucher grids (available qty + lot hints).
 * Loaded once per warehouse while a form is open; call clear() after a save.
 */
import { api } from './api.js';

export function stockCache() {
  const byWh = new Map();       // warehouse_id → Promise<rows>
  const data = new Map();       // warehouse_id → rows

  async function load(warehouseId) {
    const wh = Number(warehouseId);
    if (!wh) return [];
    if (!byWh.has(wh)) {
      byWh.set(wh, api.get('stock/balance', { warehouse_id: wh }).then((rows) => {
        data.set(wh, rows);
        return rows;
      }).catch(() => {
        byWh.delete(wh);
        return [];
      }));
    }
    return byWh.get(wh);
  }

  /** Available qty (all lots when lot is null). Returns null while not loaded. */
  function available(warehouseId, itemId, lot = null) {
    const rows = data.get(Number(warehouseId));
    if (!rows || !itemId) return null;
    return rows
      .filter((r) => r.item_id === Number(itemId) && (lot === null || r.lot_no === lot))
      .reduce((s, r) => s + r.qty, 0);
  }

  /** Lots with stock for an item → [{value: lot, label: "qty"}]. */
  function lots(warehouseId, itemId) {
    const rows = data.get(Number(warehouseId)) || [];
    return rows.filter((r) => r.item_id === Number(itemId) && r.lot_no !== '' && r.qty > 0)
      .map((r) => ({ value: r.lot_no, label: String(Math.round(r.qty * 1000) / 1000) }));
  }

  function clear() {
    byWh.clear();
    data.clear();
  }

  return { load, available, lots, clear };
}
