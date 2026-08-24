const mainEl = document.getElementById('main');
const modalRoot = document.getElementById('modal-root');

// ---------- helpers ----------

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `リクエストに失敗しました (${res.status})`);
  return data;
}

function yen(n) {
  return '¥' + Math.round(n || 0).toLocaleString('ja-JP');
}

function computeTotalsClient(items) {
  const subtotalRaw = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0);
  const subtotal = Math.floor(subtotalRaw);
  const tax = Math.floor(subtotal * 0.1);
  return { subtotal, tax, total: subtotal + tax };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function closeModal() {
  modalRoot.innerHTML = '';
}

function showModal(html, { wide } = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'modal-wide' : ''}">${html}</div></div>`;
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
}

// ---------- router ----------

function parseHash() {
  const hash = location.hash.replace(/^#/, '') || '/companies';
  const [pathPart, queryPart] = hash.split('?');
  const params = new URLSearchParams(queryPart || '');
  const segs = pathPart.split('/').filter(Boolean);
  return { segs, params };
}

async function route() {
  const { segs, params } = parseHash();
  try {
    if (segs.length <= 1) {
      await renderCompanyList();
    } else if (segs[0] === 'companies' && segs.length === 2) {
      await renderCompanyDetail(segs[1], params.get('tab') || 'invoices');
    } else {
      await renderCompanyList();
    }
  } catch (e) {
    mainEl.innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

// ---------- company list ----------

let allCompaniesCache = [];

async function renderCompanyList() {
  mainEl.innerHTML = `
    <h1>請求書・納品書管理</h1>
    <div class="subtitle">取引先を選択すると、請求書・納品書の一覧や新規作成ができます。</div>
    <div class="toolbar">
      <input type="text" class="search-input" id="company-search" placeholder="取引先名で検索...">
      <button class="btn-primary" id="btn-new-company">+ 新規取引先</button>
    </div>
    <div class="card-grid" id="company-grid"></div>
  `;

  allCompaniesCache = await api('/api/companies');
  renderCompanyGrid(allCompaniesCache);

  document.getElementById('company-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q ? allCompaniesCache.filter((c) => c.name.toLowerCase().includes(q)) : allCompaniesCache;
    renderCompanyGrid(filtered);
  });
  document.getElementById('btn-new-company').addEventListener('click', () => openCompanyForm());
}

function renderCompanyGrid(companies) {
  const grid = document.getElementById('company-grid');
  if (companies.length === 0) {
    grid.innerHTML = `<div class="empty-state">該当する取引先がありません</div>`;
    return;
  }
  grid.innerHTML = companies.map((c) => {
    const isBrand = c.billing_name && c.billing_name !== c.name;
    return `
    <div class="company-card" data-id="${c.id}">
      <div class="name">${escapeHtml(c.name)}${c.is_self ? '<span class="badge">自社</span>' : ''}${isBrand ? '<span class="badge badge-brand">ブランド/案件</span>' : ''}</div>
      <div class="meta">
        ${isBrand ? `請求先: ${escapeHtml(c.billing_name)}<br>` : ''}
        ${c.contact_person ? `ご担当: ${escapeHtml(c.contact_person)}<br>` : ''}
        ${c.address ? escapeHtml(c.address) + '<br>' : ''}
        ${c.invoice_registration_number ? '登録番号 ' + escapeHtml(c.invoice_registration_number) : ''}
      </div>
    </div>
  `;
  }).join('');
  grid.querySelectorAll('.company-card').forEach((card) => {
    card.addEventListener('click', () => {
      location.hash = `#/companies/${card.dataset.id}`;
    });
  });
}

function companyFormFields(c = {}) {
  return `
    <div class="form-grid">
      <div class="form-field full"><label>会社名 *</label><input type="text" id="f-name" value="${escapeHtml(c.name || '')}" required></div>
      <div class="form-field"><label>郵便番号</label><input type="text" id="f-postal_code" value="${escapeHtml(c.postal_code || '')}"></div>
      <div class="form-field"><label>担当者</label><input type="text" id="f-contact_person" value="${escapeHtml(c.contact_person || '')}"></div>
      <div class="form-field full"><label>住所</label><input type="text" id="f-address" value="${escapeHtml(c.address || '')}"></div>
      <div class="form-field full"><label>建物名・TEL/FAX</label><input type="text" id="f-building_tel_fax" value="${escapeHtml(c.building_tel_fax || '')}"></div>
      <div class="form-field"><label>メールアドレス</label><input type="email" id="f-email" value="${escapeHtml(c.email || '')}"></div>
      <div class="form-field"><label>支払条件</label><input type="text" id="f-payment_terms" value="${escapeHtml(c.payment_terms || '')}"></div>
      <div class="form-field full"><label>振込先</label><input type="text" id="f-bank_info" value="${escapeHtml(c.bank_info || '')}"></div>
      <div class="form-field"><label>インボイス登録番号</label><input type="text" id="f-invoice_registration_number" value="${escapeHtml(c.invoice_registration_number || '')}"></div>
      <div class="form-field"><label>書面上の宛名(未入力なら会社名)</label><input type="text" id="f-billing_name" value="${escapeHtml(c.billing_name || '')}"></div>
      <div class="form-field full"><label>備考</label><textarea id="f-notes">${escapeHtml(c.notes || '')}</textarea></div>
      <div class="form-field"><label><input type="checkbox" id="f-is_self" ${c.is_self ? 'checked' : ''} style="width:auto;display:inline-block;margin-right:6px;">自社(発行元として使う)</label></div>
      <div class="form-field" id="wrap-next_invoice_no"><label>次回請求書番号(INV-)</label><input type="number" id="f-next_invoice_no" value="${c.next_invoice_no ?? ''}"></div>
      <div class="form-field" id="wrap-next_delivery_no"><label>次回納品書番号(DEL-)</label><input type="number" id="f-next_delivery_no" value="${c.next_delivery_no ?? ''}"></div>
    </div>
  `;
}

function readCompanyForm() {
  const val = (id) => document.getElementById(id).value.trim();
  return {
    name: val('f-name'),
    postal_code: val('f-postal_code'),
    contact_person: val('f-contact_person'),
    address: val('f-address'),
    building_tel_fax: val('f-building_tel_fax'),
    email: val('f-email'),
    payment_terms: val('f-payment_terms'),
    bank_info: val('f-bank_info'),
    invoice_registration_number: val('f-invoice_registration_number'),
    billing_name: val('f-billing_name'),
    notes: document.getElementById('f-notes').value.trim(),
    is_self: document.getElementById('f-is_self').checked ? 1 : 0,
    next_invoice_no: val('f-next_invoice_no') === '' ? null : Number(val('f-next_invoice_no')),
    next_delivery_no: val('f-next_delivery_no') === '' ? null : Number(val('f-next_delivery_no')),
  };
}

function openCompanyForm(existing, onSaved) {
  showModal(`
    <h2>${existing ? '取引先を編集' : '新規取引先'}</h2>
    <div id="company-form-error"></div>
    <form id="company-form">${companyFormFields(existing || {})}</form>
    <div class="modal-actions">
      ${existing ? '<button type="button" class="btn-danger" id="btn-delete-company">削除</button>' : ''}
      <button type="button" id="btn-cancel">キャンセル</button>
      <button type="button" class="btn-primary" id="btn-save-company">保存</button>
    </div>
  `);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-save-company').addEventListener('click', async () => {
    try {
      const body = readCompanyForm();
      if (!body.name) throw new Error('会社名は必須です');
      if (existing) await api(`/api/companies/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/companies', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      if (onSaved) await onSaved(); else await route();
    } catch (e) {
      document.getElementById('company-form-error').innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
    }
  });
  const delBtn = document.getElementById('btn-delete-company');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`「${existing.name}」を削除しますか？`)) return;
      try {
        await api(`/api/companies/${existing.id}`, { method: 'DELETE' });
        closeModal();
        location.hash = '#/companies';
        await route();
      } catch (e) {
        document.getElementById('company-form-error').innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
      }
    });
  }
}

// ---------- company detail ----------

async function renderCompanyDetail(id, tab) {
  const [company, invoices, deliveryNotes] = await Promise.all([
    api(`/api/companies/${id}`),
    api(`/api/companies/${id}/invoices`),
    api(`/api/companies/${id}/delivery-notes`),
  ]);

  mainEl.innerHTML = `
    <div class="breadcrumb"><a href="#/companies">請求書・納品書管理</a> / ${escapeHtml(company.name)}</div>
    <div class="company-header">
      <div>
        <h1>${escapeHtml(company.name)}${company.is_self ? '<span class="badge">自社</span>' : ''}${company.billing_name && company.billing_name !== company.name ? '<span class="badge badge-brand">ブランド/案件</span>' : ''}</h1>
        <div class="info-line">
          ${[company.postal_code, company.address].filter(Boolean).map(escapeHtml).join(' ')}
          ${company.building_tel_fax ? ' ・ ' + escapeHtml(company.building_tel_fax) : ''}
        </div>
        <div class="info-line">
          ${company.contact_person ? 'ご担当: ' + escapeHtml(company.contact_person) + ' ' : ''}
          ${company.email ? escapeHtml(company.email) : ''}
        </div>
        ${company.billing_name && company.billing_name !== company.name ? `<div class="info-line">会社ではなくブランド/案件名です。請求書・納品書の宛名は正式法人名「${escapeHtml(company.billing_name)}」になります。</div>` : ''}
        ${company.notes ? `<div class="info-line">${escapeHtml(company.notes)}</div>` : ''}
      </div>
      <div class="company-actions">
        <button id="btn-edit-company">取引先情報を編集</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn ${tab === 'invoices' ? 'active' : ''}" data-tab="invoices">請求書一覧 (${invoices.length})</button>
      <button class="tab-btn ${tab === 'delivery-notes' ? 'active' : ''}" data-tab="delivery-notes">納品書一覧 (${deliveryNotes.length})</button>
    </div>
    <div id="tab-content"></div>
  `;

  document.getElementById('btn-edit-company').addEventListener('click', () => {
    openCompanyForm(company, async () => { await renderCompanyDetail(id, tab); });
  });

  mainEl.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = `#/companies/${id}?tab=${btn.dataset.tab}`;
    });
  });

  if (tab === 'delivery-notes') renderDocTable('delivery', id, deliveryNotes, company);
  else renderDocTable('invoice', id, invoices, company);
}

function renderDocTable(kind, companyId, docs, company) {
  const container = document.getElementById('tab-content');
  const isInvoice = kind === 'invoice';
  const label = isInvoice ? '請求書' : '納品書';

  container.innerHTML = `
    <div class="toolbar">
      <div style="flex:1"></div>
      <button class="btn-primary" id="btn-new-doc">+ 新規${label}</button>
    </div>
    ${docs.length === 0 ? `<div class="empty-state">まだ${label}がありません</div>` : `
    <table>
      <thead><tr>
        <th>${label}番号</th><th>${isInvoice ? '請求日' : '納品日'}</th><th>件名</th><th>金額</th><th></th>
      </tr></thead>
      <tbody>
        ${docs.map((d) => `
          <tr data-id="${d.id}">
            <td>${escapeHtml(isInvoice ? d.invoice_number : d.delivery_number)}</td>
            <td>${escapeHtml(isInvoice ? d.issue_date : d.delivery_date)}</td>
            <td>${escapeHtml(d.subject || '')}</td>
            <td class="num">${yen(d.totals.total)}</td>
            <td>
              <div class="row-actions">
                <button class="btn-small" data-action="edit">編集</button>
                <button class="btn-small" data-action="duplicate">複製</button>
                <button class="btn-small" data-action="pdf">PDF</button>
                <button class="btn-small btn-danger" data-action="delete">削除</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    `}
  `;

  document.getElementById('btn-new-doc').addEventListener('click', () => {
    openDocForm(kind, companyId, company, null, () => renderCompanyDetail(companyId, isInvoice ? 'invoices' : 'delivery-notes'));
  });

  container.querySelectorAll('tr[data-id]').forEach((row) => {
    const docId = row.dataset.id;
    row.querySelector('[data-action="edit"]').addEventListener('click', async () => {
      const doc = await api(`/api/${isInvoice ? 'invoices' : 'delivery-notes'}/${docId}`);
      openDocForm(kind, companyId, company, doc, () => renderCompanyDetail(companyId, isInvoice ? 'invoices' : 'delivery-notes'));
    });
    row.querySelector('[data-action="duplicate"]').addEventListener('click', async () => {
      try {
        await api(`/api/${isInvoice ? 'invoices' : 'delivery-notes'}/${docId}/duplicate`, { method: 'POST' });
        await renderCompanyDetail(companyId, isInvoice ? 'invoices' : 'delivery-notes');
      } catch (e) {
        alert(e.message);
      }
    });
    row.querySelector('[data-action="pdf"]').addEventListener('click', () => {
      window.open(`/api/${isInvoice ? 'invoices' : 'delivery-notes'}/${docId}/pdf`, '_blank');
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`この${label}を削除しますか？`)) return;
      await api(`/api/${isInvoice ? 'invoices' : 'delivery-notes'}/${docId}`, { method: 'DELETE' });
      await renderCompanyDetail(companyId, isInvoice ? 'invoices' : 'delivery-notes');
    });
  });
}

// ---------- doc (invoice / delivery note) form ----------

async function openDocForm(kind, companyId, company, existing, onSaved) {
  const isInvoice = kind === 'invoice';
  const issuers = await api('/api/companies?role=self');
  const items = existing ? existing.items.map((it) => ({ ...it })) : [{ transaction_date: '', description: '', quantity: 1, unit_price: 0 }];
  const dateField = isInvoice ? 'issue_date' : 'delivery_date';
  const today = new Date().toISOString().slice(0, 10);

  function itemsRowsHtml() {
    return items.map((it, idx) => `
      <tr data-idx="${idx}">
        <td><input type="date" class="it-date" value="${escapeHtml(it.transaction_date || '')}"></td>
        <td><input type="text" class="it-desc" value="${escapeHtml(it.description || '')}" placeholder="摘要"></td>
        <td style="width:70px"><input type="number" class="it-qty" value="${it.quantity ?? 1}" min="0" step="any"></td>
        <td style="width:110px"><input type="number" class="it-price" value="${it.unit_price ?? 0}" min="0" step="any"></td>
        <td class="amount-cell it-amount">${yen((it.quantity || 0) * (it.unit_price || 0))}</td>
        <td class="remove-cell"><button type="button" class="btn-link it-remove">✕</button></td>
      </tr>
    `).join('');
  }

  showModal(`
    <h2>${existing ? '' : '新規'}${isInvoice ? '請求書' : '納品書'}${existing ? '編集' : ''}</h2>
    <div id="doc-form-error"></div>
    <div class="form-grid">
      <div class="form-field">
        <label>発行元</label>
        <select id="f-issuer">
          ${issuers.map((i) => `<option value="${i.id}" ${existing ? (existing.issuer_company_id === i.id ? 'selected' : '') : (i.name === '株式会社peops' ? 'selected' : '')}>${escapeHtml(i.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-field"><label>${isInvoice ? '請求先' : '納品先'}</label><input type="text" value="${escapeHtml(company.name)}" disabled></div>
      <div class="form-field"><label>${isInvoice ? '請求日' : '納品日'}</label><input type="date" id="f-date" value="${existing ? existing[dateField] : today}"></div>
      ${isInvoice ? `<div class="form-field"><label>入金期日</label><input type="date" id="f-due" value="${existing && existing.due_date ? existing.due_date : ''}"></div>` : '<div></div>'}
      <div class="form-field full"><label>件名</label><input type="text" id="f-subject" value="${escapeHtml(existing ? existing.subject || '' : '')}"></div>
    </div>

    <table class="items-table">
      <thead><tr><th>取引日</th><th>摘要</th><th>数量</th><th>単価</th><th style="text-align:right">金額</th><th></th></tr></thead>
      <tbody id="items-body">${itemsRowsHtml()}</tbody>
    </table>
    <button type="button" id="btn-add-item" class="btn-small">+ 行を追加</button>

    <div class="totals-box" id="totals-box"></div>

    <div class="form-field full" style="margin-top:12px"><label>備考</label><textarea id="f-notes">${escapeHtml(existing ? existing.notes || '' : '')}</textarea></div>

    <div class="modal-actions">
      <button type="button" id="btn-cancel">キャンセル</button>
      <button type="button" class="btn-primary" id="btn-save-doc">保存</button>
    </div>
  `, { wide: true });

  function readItemsFromDom() {
    return Array.from(document.querySelectorAll('#items-body tr')).map((row) => ({
      transaction_date: row.querySelector('.it-date').value,
      description: row.querySelector('.it-desc').value,
      quantity: Number(row.querySelector('.it-qty').value) || 0,
      unit_price: Number(row.querySelector('.it-price').value) || 0,
    }));
  }

  function refreshTotals() {
    const current = readItemsFromDom();
    const t = computeTotalsClient(current);
    document.getElementById('totals-box').innerHTML = `
      <div class="line"><span>小計</span><span>${yen(t.subtotal)}</span></div>
      <div class="line"><span>消費税(10%)</span><span>${yen(t.tax)}</span></div>
      <div class="line total"><span>${isInvoice ? '請求金額' : '合計金額'}</span><span>${yen(t.total)}</span></div>
    `;
    document.querySelectorAll('#items-body tr').forEach((row, idx) => {
      const q = Number(row.querySelector('.it-qty').value) || 0;
      const p = Number(row.querySelector('.it-price').value) || 0;
      row.querySelector('.it-amount').textContent = yen(q * p);
    });
  }

  function bindRowEvents() {
    document.querySelectorAll('#items-body tr').forEach((row) => {
      row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', refreshTotals));
      row.querySelector('.it-remove').addEventListener('click', () => {
        if (document.querySelectorAll('#items-body tr').length <= 1) return;
        row.remove();
        refreshTotals();
      });
    });
  }

  bindRowEvents();
  refreshTotals();

  document.getElementById('btn-add-item').addEventListener('click', () => {
    const tbody = document.getElementById('items-body');
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td><input type="date" class="it-date" value=""></td>
        <td><input type="text" class="it-desc" value="" placeholder="摘要"></td>
        <td style="width:70px"><input type="number" class="it-qty" value="1" min="0" step="any"></td>
        <td style="width:110px"><input type="number" class="it-price" value="0" min="0" step="any"></td>
        <td class="amount-cell it-amount">¥0</td>
        <td class="remove-cell"><button type="button" class="btn-link it-remove">✕</button></td>
      </tr>
    `);
    bindRowEvents();
    refreshTotals();
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-save-doc').addEventListener('click', async () => {
    try {
      const body = {
        issuer_company_id: Number(document.getElementById('f-issuer').value),
        client_company_id: Number(companyId),
        subject: document.getElementById('f-subject').value.trim(),
        notes: document.getElementById('f-notes').value.trim(),
        items: readItemsFromDom().filter((it) => it.description || it.quantity || it.unit_price),
      };
      body[dateField] = document.getElementById('f-date').value;
      if (isInvoice) body.due_date = document.getElementById('f-due').value || null;

      if (existing) {
        await api(`/api/${isInvoice ? 'invoices' : 'delivery-notes'}/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api(`/api/${isInvoice ? 'invoices' : 'delivery-notes'}`, { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      if (onSaved) await onSaved();
    } catch (e) {
      document.getElementById('doc-form-error').innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
    }
  });
}
