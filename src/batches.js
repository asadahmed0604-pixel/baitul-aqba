// Transfer batches: management groups paid orphan-months into a batch, then tracks the money from
// "donations received" to "transferred to the orphans' area".
import { fail } from './http.js';
import { tx, audit } from './db.js';
import { round2 } from './payments.js';
import { monthLabel } from '../public/shared/receipt-parser.js';

export const BATCH_STATUS = {
  collecting: 'Donations pending',
  ready: 'Donations received · transfer to area pending',
  transferred: 'Money transferred to area',
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const statusSql = (statuses) => {
  const list = statuses.filter((s) => ['verified', 'pending'].includes(s));
  return { sql: `p.status IN (${list.map(() => '?').join(',') || "''"})`, params: list };
};

/** Paid amount per orphan for a month, split by verified / pending. */
function paidByOrphan(db, month, orphanIds) {
  const rows = db.prepare(`
    SELECT pm.orphan_id,
      SUM(CASE WHEN p.status = 'verified' THEN pm.amount ELSE 0 END) AS verified,
      SUM(CASE WHEN p.status = 'pending' THEN pm.amount ELSE 0 END) AS pending
    FROM payment_months pm JOIN payments p ON p.id = pm.payment_id
    WHERE pm.month = ? ${orphanIds ? `AND pm.orphan_id IN (${orphanIds.map(() => '?').join(',') || '-1'})` : ''}
    GROUP BY pm.orphan_id`).all(month, ...(orphanIds || []));
  return new Map(rows.map((r) => [r.orphan_id, { verified: round2(r.verified), pending: round2(r.pending) }]));
}

const sponsorsOf = (db) => {
  const stmt = db.prepare(`SELECT GROUP_CONCAT(u.name, ', ') AS s FROM donor_orphans d JOIN users u ON u.id = d.donor_id WHERE d.orphan_id = ?`);
  return (orphanId) => stmt.get(orphanId)?.s || '';
};

export function eligibleOrphans(db, month, { includePending = false, area = '' } = {}) {
  const st = statusSql(includePending ? ['verified', 'pending'] : ['verified']);
  const rows = db.prepare(`
    SELECT o.id, o.orphan_no, o.name, o.city, o.monthly_amount, SUM(pm.amount) AS amount
    FROM payment_months pm JOIN payments p ON p.id = pm.payment_id JOIN orphans o ON o.id = pm.orphan_id
    WHERE pm.month = ? AND ${st.sql}
      AND NOT EXISTS (SELECT 1 FROM batch_items bi WHERE bi.orphan_id = o.id AND bi.month = pm.month)
      ${area ? 'AND lower(COALESCE(o.city, \'\')) = lower(?)' : ''}
    GROUP BY o.id ORDER BY o.orphan_no`).all(month, ...st.params, ...(area ? [area] : []));
  const sponsors = sponsorsOf(db);
  return rows.map((r) => ({ ...r, amount: round2(r.amount), sponsors: sponsors(r.id) }));
}

export function listBatches(db) {
  return db.prepare(`
    SELECT b.*, COUNT(bi.id) AS orphans, COALESCE(SUM(bi.amount), 0) AS total, u.name AS created_by_name
    FROM batches b LEFT JOIN batch_items bi ON bi.batch_id = b.id LEFT JOIN users u ON u.id = b.created_by
    GROUP BY b.id ORDER BY b.month DESC, b.id DESC`).all()
    .map((b) => ({ ...b, total: round2(b.total), status_label: BATCH_STATUS[b.status] }));
}

export function getBatch(db, id) {
  const b = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  if (!b) fail(404, 'Batch not found');
  const items = db.prepare(`
    SELECT bi.orphan_id, bi.month, bi.amount, o.orphan_no, o.name, o.city FROM batch_items bi
    JOIN orphans o ON o.id = bi.orphan_id WHERE bi.batch_id = ? ORDER BY o.orphan_no`).all(id);
  const live = paidByOrphan(db, b.month, items.map((i) => i.orphan_id));
  const sponsors = sponsorsOf(db);
  const rows = items.map((i) => ({
    ...i, sponsors: sponsors(i.orphan_id),
    verified_now: live.get(i.orphan_id)?.verified || 0, pending_now: live.get(i.orphan_id)?.pending || 0,
  }));
  return {
    ...b, status_label: BATCH_STATUS[b.status], month_label: monthLabel(b.month), items: rows,
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
    // Amounts are fixed when orphans are added; flag anything that changed since (e.g. an entry was rejected).
    changed: rows.filter((r) => Math.abs(r.verified_now - r.amount) > 0.009 && Math.abs(r.verified_now + r.pending_now - r.amount) > 0.009).length,
  };
}

function addItems(db, batch, orphanIds, includePending) {
  const eligible = new Map(eligibleOrphans(db, batch.month, { includePending }).map((o) => [o.id, o]));
  const ins = db.prepare('INSERT INTO batch_items (batch_id, orphan_id, month, amount) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const id of orphanIds) {
    const o = eligible.get(Number(id));
    if (!o) {
      const orphan = db.prepare('SELECT orphan_no FROM orphans WHERE id = ?').get(Number(id));
      fail(400, `${orphan?.orphan_no || `Orphan ${id}`} is not paid for ${monthLabel(batch.month)} or is already in a batch`);
    }
    ins.run(batch.id, o.id, batch.month, o.amount);
    added++;
  }
  return added;
}

export function batchSummary(db, month) {
  const byStatus = db.prepare(`
    SELECT b.status, COUNT(DISTINCT b.id) AS batches, COUNT(bi.id) AS orphans, COALESCE(SUM(bi.amount), 0) AS total
    FROM batches b LEFT JOIN batch_items bi ON bi.batch_id = b.id GROUP BY b.status`).all();
  const get = (s) => {
    const r = byStatus.find((x) => x.status === s) || { batches: 0, orphans: 0, total: 0 };
    return { batches: r.batches, orphans: r.orphans, total: round2(r.total) };
  };
  const unbatched = eligibleOrphans(db, month);
  return {
    collecting: get('collecting'), ready: get('ready'), transferred: get('transferred'),
    unbatched: { orphans: unbatched.length, total: round2(unbatched.reduce((s, o) => s + o.amount, 0)) },
  };
}

export const BATCH_COLUMNS = [
  { key: 'orphan_no', label: 'orphan_no' }, { key: 'name', label: 'orphan_name' }, { key: 'city', label: 'area' },
  { key: 'sponsors', label: 'sponsors' }, { key: 'month', label: 'month' }, { key: 'amount', label: 'amount' },
  { key: 'verified_now', label: 'verified_now' }, { key: 'pending_now', label: 'pending_now' },
];

export function registerBatchRoutes({ r, db, admin, csv, today }) {
  r.get('/api/admin/batches', admin, () => ({ batches: listBatches(db), statuses: BATCH_STATUS }));

  r.get('/api/admin/batches/eligible', admin, (ctx) => {
    const month = ctx.query.get('month');
    if (!MONTH_RE.test(month || '')) fail(400, 'Choose a month');
    return { month, orphans: eligibleOrphans(db, month, { includePending: ctx.query.get('pending') === '1', area: ctx.query.get('area') || '' }) };
  });

  r.post('/api/admin/batches', admin, (ctx) => {
    const b = ctx.body;
    if (!MONTH_RE.test(b.month || '')) fail(400, 'Choose the month this batch is for');
    const ids = (Array.isArray(b.orphan_ids) ? b.orphan_ids : []).map(Number).filter(Boolean);
    if (!ids.length) fail(400, 'Select at least one paid orphan');
    const status = BATCH_STATUS[b.status] ? b.status : 'ready';
    return tx(db, () => {
      const count = db.prepare('SELECT COUNT(*) AS n FROM batches WHERE month = ?').get(b.month).n;
      const name = String(b.name || '').trim() || `${monthLabel(b.month)} · Batch ${count + 1}`;
      const res = db.prepare('INSERT INTO batches (name, month, area, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, b.month, String(b.area || '').trim() || null, status, String(b.notes || '').trim() || null, ctx.user.id);
      const id = Number(res.lastInsertRowid);
      const added = addItems(db, { id, month: b.month }, ids, b.include_pending === true || b.include_pending === '1');
      audit(db, ctx.user.id, 'batch.create', 'batch', id, { name, month: b.month, orphans: added });
      return { batch: getBatch(db, id) };
    });
  });

  r.get('/api/admin/batches/:id', admin, (ctx) => ({ batch: getBatch(db, Number(ctx.params.id)), statuses: BATCH_STATUS }));

  r.put('/api/admin/batches/:id', admin, (ctx) => {
    const id = Number(ctx.params.id);
    const cur = getBatch(db, id);
    const b = ctx.body;
    const status = b.status !== undefined ? b.status : cur.status;
    if (!BATCH_STATUS[status]) fail(400, 'Unknown batch status');
    const pick = (k) => (b[k] !== undefined ? String(b[k] ?? '').trim() || null : cur[k]);
    let transferDate = pick('transfer_date');
    let transferAmount = b.transfer_amount !== undefined && b.transfer_amount !== '' ? Number(String(b.transfer_amount).replace(/,/g, '')) : cur.transfer_amount;
    if (status === 'transferred') {
      transferDate = transferDate || today();
      if (transferAmount == null || !Number.isFinite(transferAmount)) transferAmount = cur.total;
    }
    db.prepare(`UPDATE batches SET name = ?, area = ?, status = ?, notes = ?, transfer_date = ?, transfer_ref = ?, transfer_amount = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(pick('name') || cur.name, pick('area'), status, pick('notes'), transferDate, pick('transfer_ref'),
        transferAmount == null || !Number.isFinite(transferAmount) ? null : round2(transferAmount), id);
    audit(db, ctx.user.id, 'batch.update', 'batch', id, b);
    return { batch: getBatch(db, id) };
  });

  r.post('/api/admin/batches/:id/add', admin, (ctx) => {
    const batch = getBatch(db, Number(ctx.params.id));
    if (batch.status === 'transferred') fail(400, 'This batch has already been transferred');
    const ids = (Array.isArray(ctx.body.orphan_ids) ? ctx.body.orphan_ids : []).map(Number).filter(Boolean);
    const added = tx(db, () => addItems(db, batch, ids, ctx.body.include_pending === true));
    audit(db, ctx.user.id, 'batch.add', 'batch', batch.id, { orphans: added });
    return { batch: getBatch(db, batch.id) };
  });

  r.post('/api/admin/batches/:id/remove', admin, (ctx) => {
    const batch = getBatch(db, Number(ctx.params.id));
    if (batch.status === 'transferred') fail(400, 'This batch has already been transferred');
    const ids = (Array.isArray(ctx.body.orphan_ids) ? ctx.body.orphan_ids : []).map(Number).filter(Boolean);
    const del = db.prepare('DELETE FROM batch_items WHERE batch_id = ? AND orphan_id = ?');
    for (const id of ids) del.run(batch.id, id);
    audit(db, ctx.user.id, 'batch.remove', 'batch', batch.id, { orphans: ids.length });
    return { batch: getBatch(db, batch.id) };
  });

  r.delete('/api/admin/batches/:id', admin, (ctx) => {
    const batch = getBatch(db, Number(ctx.params.id));
    db.prepare('DELETE FROM batches WHERE id = ?').run(batch.id);
    audit(db, ctx.user.id, 'batch.delete', 'batch', batch.id, { name: batch.name, status: batch.status });
    return { ok: true };
  });

  r.get('/api/admin/batches/:id/export', admin, (ctx) => {
    const b = getBatch(db, Number(ctx.params.id));
    const rows = b.items.map((i) => ({ ...i, batch: b.name, status: b.status_label, transfer_date: b.transfer_date, transfer_ref: b.transfer_ref }));
    const safe = b.name.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    csv(ctx.res, `batch-${safe || b.id}.csv`, [
      { key: 'batch', label: 'batch' }, ...BATCH_COLUMNS, { key: 'status', label: 'batch_status' },
      { key: 'transfer_date', label: 'transfer_date' }, { key: 'transfer_ref', label: 'transfer_ref' },
    ], rows);
  });
}
