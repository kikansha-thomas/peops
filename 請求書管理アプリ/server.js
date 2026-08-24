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

function getCompany(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function assignNextNumber(issuerId, kind) {
  const field = kind === 'invoice' ? 'next_invoice_no' : 'next_delivery_no';
  const prefix = kind === 'invoice' ? 'INV' : 'DEL';
  const issuer = getCompany(issuerId);
  if (!issuer) throw Object.assign(new Error('発行元の取引先が見つかりません'), { status: 400 });
  if (issuer[field] == null) {
    throw Object.assign(
      new Error(`${issuer.name}の${kind === 'invoice' ? '請求書' : '納品書'}番号の連番が未設定です。取引先編集画面で次回番号を設定してください。`),
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
  'is_self', 'next_invoice_no', 'next_delivery_no',
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
  if (usedAsInvoice > 0 || usedAsDelivery > 0) {
    return res.status(400).json({ error: 'この取引先には請求書・納品書の履歴があるため削除できません' });
  }
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.status(204).end();
});

// ---------- shared invoice/delivery-note logic ----------

function listDocs(kind, companyId) {
  const table = kind === 'invoice' ? 'invoices' : 'delivery_notes';
  const numberField = kind === 'invoice' ? 'invoice_number' : 'delivery_number';
  const dateField = kind === 'invoice' ? 'issue_date' : 'delivery_date';
  const itemsTable = kind === 'invoice' ? 'invoice_items' : 'delivery_note_items';
  const fkField = kind === 'invoice' ? 'invoice_id' : 'delivery_note_id';
  const rows = db.prepare(`SELECT * FROM ${table} WHERE client_company_id = ? ORDER BY ${dateField} DESC, id DESC`).all(companyId);
  return rows.map((r) => {
    const items = db.prepare(`SELECT * FROM ${itemsTable} WHERE ${fkField} = ? ORDER BY sort_order`).all(r.id);
    return { ...r, items, totals: computeTotals(items) };
  });
}

function getDoc(kind, id) {
  const table = kind === 'invoice' ? 'invoices' : 'delivery_notes';
  const itemsTable = kind === 'invoice' ? 'invoice_items' : 'delivery_note_items';
  const fkField = kind === 'invoice' ? 'invoice_id' : 'delivery_note_id';
  const doc = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!doc) return null;
  const items = db.prepare(`SELECT * FROM ${itemsTable} WHERE ${fkField} = ? ORDER BY sort_order`).all(id);
  return { ...doc, items, totals: computeTotals(items) };
}

function createDoc(kind, body) {
  const table = kind === 'invoice' ? 'invoices' : 'delivery_notes';
  const itemsTable = kind === 'invoice' ? 'invoice_items' : 'delivery_note_items';
  const fkField = kind === 'invoice' ? 'invoice_id' : 'delivery_note_id';
  const numberField = kind === 'invoice' ? 'invoice_number' : 'delivery_number';
  const dateField = kind === 'invoice' ? 'issue_date' : 'delivery_date';

  if (!body.issuer_company_id || !body.client_company_id) {
    throw Object.assign(new Error('発行元・請求先(納品先)は必須です'), { status: 400 });
  }
  const number = body.invoice_number_override || assignNextNumber(body.issuer_company_id, kind);
  const cols = kind === 'invoice'
    ? [numberField, 'issuer_company_id', 'client_company_id', dateField, 'due_date', 'subject', 'notes']
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
  const table = kind === 'invoice' ? 'invoices' : 'delivery_notes';
  const itemsTable = kind === 'invoice' ? 'invoice_items' : 'delivery_note_items';
  const fkField = kind === 'invoice' ? 'invoice_id' : 'delivery_note_id';
  const dateField = kind === 'invoice' ? 'issue_date' : 'delivery_date';
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!existing) return null;

  const cols = kind === 'invoice'
    ? ['issuer_company_id', 'client_company_id', dateField, 'due_date', 'subject', 'notes']
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
  return createDoc(kind, {
    issuer_company_id: src.issuer_company_id,
    client_company_id: src.client_company_id,
    issue_date: today(),
    delivery_date: today(),
    due_date: null,
    subject: src.subject,
    notes: src.notes,
    items: src.items.map((it) => ({
      transaction_date: it.transaction_date,
      description: it.description,
      quantity: it.quantity,
      unit_price: it.unit_price,
    })),
  });
}

async function docPdfBuffer(kind, doc) {
  const issuer = getCompany(doc.issuer_company_id);
  const client = getCompany(doc.client_company_id);
  return generatePdf({
    kind,
    number: kind === 'invoice' ? doc.invoice_number : doc.delivery_number,
    issueDate: kind === 'invoice' ? doc.issue_date : doc.delivery_date,
    dueDate: doc.due_date,
    subject: doc.subject,
    issuer,
    client,
    items: doc.items,
    notes: doc.notes,
  });
}

function registerDocRoutes(kind, segment) {
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
    const table = kind === 'invoice' ? 'invoices' : 'delivery_notes';
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
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
      const number = kind === 'invoice' ? doc.invoice_number : doc.delivery_number;
      const dateStr = kind === 'invoice' ? doc.issue_date : doc.delivery_date;
      const client = getCompany(doc.client_company_id);
      const issuer = getCompany(doc.issuer_company_id);
      const fileBase = `${client.name}御中_${kind === 'invoice' ? '請求書' : '納品書'}_${number}`;
      saveInvoicePdfToArchive(DESKTOP_DIR, kind, issuer.name, dateStr, fileBase, buffer);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileBase)}.pdf"`);
      res.send(buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

registerDocRoutes('invoice', 'invoices');
registerDocRoutes('delivery', 'delivery-notes');

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log('請求書・納品書管理アプリ: http://localhost:' + PORT));
