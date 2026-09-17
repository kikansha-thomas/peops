const express = require('express');
const path = require('path');
const { db, computeTotals, padInvoiceNumber } = require('./db.js');
const { generatePdf, saveInvoicePdfToArchive } = require('./pdf.js');

const DESKTOP_DIR = path.join(__dirname, '..', '..');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// 書類種別ごとの差分をここに集約する。請求書/納品書は取引先(client)への発行、
// 発注書は取引先(client=発注先・仕入先)への発行で、issuer(自社)から見た向きは共通のため
// 同じcompanies.client_company_id列を「相手方」として使い回している。
const DOC_KINDS = {
  invoice: {
    table: 'invoices', itemsTable: 'invoice_items', fk: 'invoice_id',
    numberField: 'invoice_number', dateField: 'issue_date', prefix: 'INV', counterField: 'next_invoice_no',
    hasDueDate: true, dueDateField: 'due_date', label: '請求書', segment: 'invoices',
  },
  delivery: {
    table: 'delivery_notes', itemsTable: 'delivery_note_items', fk: 'delivery_note_id',
    numberField: 'delivery_number', dateField: 'delivery_date', prefix: 'DEL', counterField: 'next_delivery_no',
    hasDueDate: false, label: '納品書', segment: 'delivery-notes',
  },
  purchase_order: {
    table: 'purchase_orders', itemsTable: 'purchase_order_items', fk: 'purchase_order_id',
    numberField: 'po_number', dateField: 'order_date', prefix: 'PO', counterField: 'next_po_no',
    hasDueDate: true, dueDateField: 'expected_delivery_date', label: '発注書', segment: 'purchase-orders',
  },
};

function getCompany(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function assignNextNumber(issuerId, kind) {
  const { counterField: field, prefix, label } = DOC_KINDS[kind];
  const issuer = getCompany(issuerId);
  if (!issuer) throw Object.assign(new Error('発行元の取引先が見つかりません'), { status: 400 });
  if (issuer[field] == null) {
    throw Object.assign(
      new Error(`${issuer.name}の${label}番号の連番が未設定です。取引先編集画面で次回番号を設定してください。`),
      { status: 400 }
    );
  }
  const n = issuer[field];
  db.prepare(`UPDATE companies SET ${field} = ?, updated_at = ? WHERE id = ?`).run(n + 1, now(), issuerId);
  return padInvoiceNumber(prefix, n);
}

// ---------- companies ----------

app.get('/api/companies', (req, res) => {
  let rows = db.prepare('SELECT * FROM companies ORDER BY is_self DESC, name').all();
  if (req.query.role === 'self') rows = rows.filter((c) => c.is_self);
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    rows = rows.filter((c) => c.name.toLowerCase().includes(q));
  }
  res.json(rows);
});

app.get('/api/companies/:id', (req, res) => {
  const company = getCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'not found' });
  res.json(company);
});

const COMPANY_FIELDS = [
  'name', 'billing_name', 'postal_code', 'address', 'building_tel_fax', 'contact_person',
  'email', 'payment_terms', 'bank_info', 'invoice_registration_number', 'notes',
  'is_self', 'next_invoice_no', 'next_delivery_no', 'next_po_no',
];

app.post('/api/companies', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '会社名は必須です' });
  const cols = COMPANY_FIELDS;
  const values = cols.map((c) => (b[c] === undefined || b[c] === '' ? null : b[c]));
  const placeholders = cols.map(() => '?').join(', ');
  const info = db
    .prepare(`INSERT INTO companies (${cols.join(', ')}, created_at, updated_at) VALUES (${placeholders}, ?, ?)`)
    .run(...values, now(), now());
  res.status(201).json(getCompany(info.lastInsertRowid));
});

app.put('/api/companies/:id', (req, res) => {
  const existing = getCompany(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const cols = COMPANY_FIELDS;
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => (b[c] === undefined || b[c] === '' ? null : b[c]));
  db.prepare(`UPDATE companies SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), req.params.id);
  res.json(getCompany(req.params.id));
});

app.delete('/api/companies/:id', (req, res) => {
  const id = req.params.id;
  const usedAsInvoice = db.prepare('SELECT COUNT(*) c FROM invoices WHERE issuer_company_id = ? OR client_company_id = ?').get(id, id).c;
  const usedAsDelivery = db.prepare('SELECT COUNT(*) c FROM delivery_notes WHERE issuer_company_id = ? OR client_company_id = ?').get(id, id).c;
  const usedAsPurchaseOrder = db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE issuer_company_id = ? OR client_company_id = ?').get(id, id).c;
  if (usedAsInvoice > 0 || usedAsDelivery > 0 || usedAsPurchaseOrder > 0) {
    return res.status(400).json({ error: 'この取引先には請求書・納品書・発注書の履歴があるため削除できません' });
  }
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.status(204).end();
});

// ---------- shared invoice/delivery-note/purchase-order logic ----------

function listDocs(kind, companyId) {
  const { table, itemsTable, fk: fkField, dateField } = DOC_KINDS[kind];
  const rows = db.prepare(`SELECT * FROM ${table} WHERE client_company_id = ? ORDER BY ${dateField} DESC, id DESC`).all(companyId);
  return rows.map((r) => {
    const items = db.prepare(`SELECT * FROM ${itemsTable} WHERE ${fkField} = ? ORDER BY sort_order`).all(r.id);
    return { ...r, items, totals: computeTotals(items) };
  });
}

function getDoc(kind, id) {
  const { table, itemsTable, fk: fkField } = DOC_KINDS[kind];
  const doc = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!doc) return null;
  const items = db.prepare(`SELECT * FROM ${itemsTable} WHERE ${fkField} = ? ORDER BY sort_order`).all(id);
  return { ...doc, items, totals: computeTotals(items) };
}

function createDoc(kind, body) {
  const { table, itemsTable, fk: fkField, numberField, dateField, hasDueDate, dueDateField, label } = DOC_KINDS[kind];

  if (!body.issuer_company_id || !body.client_company_id) {
    throw Object.assign(new Error(`発行元・相手先は必須です(${label})`), { status: 400 });
  }
  const number = body.invoice_number_override || assignNextNumber(body.issuer_company_id, kind);
  const cols = hasDueDate
    ? [numberField, 'issuer_company_id', 'client_company_id', dateField, dueDateField, 'subject', 'notes']
    : [numberField, 'issuer_company_id', 'client_company_id', dateField, 'subject', 'notes'];
  const values = cols.map((c) => {
    if (c === numberField) return number;
    if (c === dateField) return body[dateField] || today();
    return body[c] ?? null;
  });
  const placeholders = cols.map(() => '?').join(', ');
  const info = db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}, created_at, updated_at) VALUES (${placeholders}, ?, ?)`)
    .run(...values, now(), now());
  const docId = info.lastInsertRowid;
  const insertItem = db.prepare(
    `INSERT INTO ${itemsTable} (${fkField}, sort_order, transaction_date, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)`
  );
  (body.items || []).forEach((it, idx) => {
    insertItem.run(docId, idx + 1, it.transaction_date || null, it.description || '', it.quantity ?? null, it.unit_price ?? null);
  });
  return getDoc(kind, docId);
}

function updateDoc(kind, id, body) {
  const { table, itemsTable, fk: fkField, dateField, hasDueDate, dueDateField } = DOC_KINDS[kind];
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!existing) return null;

  const cols = hasDueDate
    ? ['issuer_company_id', 'client_company_id', dateField, dueDateField, 'subject', 'notes']
    : ['issuer_company_id', 'client_company_id', dateField, 'subject', 'notes'];
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => (body[c] !== undefined ? body[c] : existing[c]));
  db.prepare(`UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);

  if (Array.isArray(body.items)) {
    db.prepare(`DELETE FROM ${itemsTable} WHERE ${fkField} = ?`).run(id);
    const insertItem = db.prepare(
      `INSERT INTO ${itemsTable} (${fkField}, sort_order, transaction_date, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)`
    );
    body.items.forEach((it, idx) => {
      insertItem.run(id, idx + 1, it.transaction_date || null, it.description || '', it.quantity ?? null, it.unit_price ?? null);
    });
  }
  return getDoc(kind, id);
}

function duplicateDoc(kind, id) {
  const src = getDoc(kind, id);
  if (!src) return null;
  const { dateField, hasDueDate, dueDateField } = DOC_KINDS[kind];
  const body = {
    issuer_company_id: src.issuer_company_id,
    client_company_id: src.client_company_id,
    subject: src.subject,
    notes: src.notes,
    items: src.items.map((it) => ({
      transaction_date: it.transaction_date,
      description: it.description,
      quantity: it.quantity,
      unit_price: it.unit_price,
    })),
  };
  body[dateField] = today();
  if (hasDueDate) body[dueDateField] = null;
  return createDoc(kind, body);
}

async function docPdfBuffer(kind, doc) {
  const { numberField, dateField, hasDueDate, dueDateField } = DOC_KINDS[kind];
  const issuer = getCompany(doc.issuer_company_id);
  const client = getCompany(doc.client_company_id);
  return generatePdf({
    kind,
    number: doc[numberField],
    issueDate: doc[dateField],
    dueDate: hasDueDate ? doc[dueDateField] : null,
    subject: doc.subject,
    issuer,
    client,
    items: doc.items,
    notes: doc.notes,
  });
}

function registerDocRoutes(kind) {
  const { segment, numberField, dateField, label } = DOC_KINDS[kind];
  const basePath = `/api/${segment}`;

  app.get(`/api/companies/:companyId/${segment}`, (req, res) => {
    res.json(listDocs(kind, req.params.companyId));
  });

  app.get(`${basePath}/:id`, (req, res) => {
    const doc = getDoc(kind, req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json(doc);
  });

  app.post(basePath, (req, res) => {
    try {
      res.status(201).json(createDoc(kind, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.put(`${basePath}/:id`, (req, res) => {
    const doc = updateDoc(kind, req.params.id, req.body || {});
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json(doc);
  });

  app.delete(`${basePath}/:id`, (req, res) => {
    db.prepare(`DELETE FROM ${DOC_KINDS[kind].table} WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  });

  app.post(`${basePath}/:id/duplicate`, (req, res) => {
    try {
      const doc = duplicateDoc(kind, req.params.id);
      if (!doc) return res.status(404).json({ error: 'not found' });
      res.status(201).json(doc);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get(`${basePath}/:id/pdf`, async (req, res) => {
    const doc = getDoc(kind, req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    try {
      const buffer = await docPdfBuffer(kind, doc);
      const number = doc[numberField];
      const dateStr = doc[dateField];
      const client = getCompany(doc.client_company_id);
      const issuer = getCompany(doc.issuer_company_id);
      const fileBase = `${client.name}御中_${label}_${number}`;
      saveInvoicePdfToArchive(DESKTOP_DIR, kind, issuer.name, dateStr, fileBase, buffer);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileBase)}.pdf"`);
      res.send(buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

registerDocRoutes('invoice');
registerDocRoutes('delivery');
registerDocRoutes('purchase_order');

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log('請求書・納品書管理アプリ: http://localhost:' + PORT));
