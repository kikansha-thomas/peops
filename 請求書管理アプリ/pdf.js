const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// システムにインストール済みのヒラギノ角ゴシックを使う(日本語フォント埋め込み用)。
// Excel/Pagesが印刷→PDF保存する際に使うのと同じライセンス済みシステムフォントを、
// このアプリでも同様にPDF生成(=ユーザー自身の請求書という自社文書の作成)に使う。
const JP_FONT_PATH = '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc';
const JP_FONT_NAME = 'HiraKakuProN-W3';

const fmt = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const fmtPlain = (n) => Math.round(n).toLocaleString('ja-JP');

const COMPANY_SEAL_PATH = path.join(__dirname, 'assets', 'company_seal.png');
const hasCompanySeal = fs.existsSync(COMPANY_SEAL_PATH);

function drawHeaderBlock(doc, { title, intro, number, numberLabel, issueDate, dateLabel, subject, issuer, client }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  doc.font(JP_FONT_PATH, JP_FONT_NAME).fontSize(26).text(title, left, doc.y, { width, align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).text(intro, left, doc.y, { width, align: 'center' });
  doc.moveDown(1.2);

  const colY = doc.y;
  const colWidth = width / 2 - 10;

  // 左カラム: 請求先/納品先
  doc.fontSize(13).text((client.billing_name || client.name) + ' 御中', left, colY, { width: colWidth });
  let cy = doc.y + 4;
  doc.fontSize(9);
  if (client.postal_code || client.address) {
    doc.text([client.postal_code, client.address].filter(Boolean).join(' '), left, cy, { width: colWidth });
    cy = doc.y + 2;
  }
  if (client.building_tel_fax) {
    doc.text(client.building_tel_fax, left, cy, { width: colWidth });
    cy = doc.y + 2;
  }

  // 右カラム: 発行元(自社)
  const rx = left + colWidth + 20;
  doc.fontSize(13).text(issuer.name, rx, colY, { width: colWidth });

  // 社印(自社が発行元の場合のみ、会社名の右側に少し重ねて押す)
  if (hasCompanySeal && issuer.is_self) {
    const sealSize = 50;
    doc.image(COMPANY_SEAL_PATH, rx + colWidth - sealSize + 6, colY - 8, { width: sealSize, height: sealSize });
  }

  let ry = doc.y + 4;
  doc.fontSize(9);
  if (issuer.invoice_registration_number) {
    doc.text('登録番号 ' + issuer.invoice_registration_number, rx, ry, { width: colWidth });
    ry = doc.y + 2;
  }
  if (issuer.postal_code || issuer.address) {
    doc.text([issuer.postal_code, issuer.address].filter(Boolean).join(' '), rx, ry, { width: colWidth });
    ry = doc.y + 2;
  }
  if (issuer.building_tel_fax) {
    doc.text(issuer.building_tel_fax, rx, ry, { width: colWidth });
    ry = doc.y + 2;
  }

  doc.y = Math.max(cy, ry) + 14;

  // 発行日・番号・件名
  const infoY = doc.y;
  doc.fontSize(10);
  doc.text(dateLabel, left, infoY, { continued: false });
  doc.text(issueDate, left + 55, infoY);
  doc.text(numberLabel, left + 180, infoY);
  doc.text(number, left + 240, infoY);
  if (subject) {
    doc.text('件名', left + 400, infoY);
    doc.text(subject, left + 430, infoY, { width: right - (left + 430) });
  }
  doc.y = infoY + 24;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#333').stroke();
  doc.moveDown(0.5);
}

function drawItemsTable(doc, items) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  const cols = [
    { key: 'no', label: 'No', w: 0.06 },
    { key: 'date', label: '取引日', w: 0.16 },
    { key: 'desc', label: '摘要', w: 0.44 },
    { key: 'qty', label: '数量', w: 0.10 },
    { key: 'price', label: '単価', w: 0.12 },
    { key: 'amount', label: '金額', w: 0.12 },
  ].map((c) => ({ ...c, w: c.w * width }));

  const baseRowHeight = 22;
  let x = left;
  const headerY = doc.y;
  doc.fontSize(10).fillColor('#000');
  cols.forEach((c) => {
    doc.rect(x, headerY, c.w, baseRowHeight).strokeColor('#999').stroke();
    doc.text(c.label, x + 4, headerY + 6, { width: c.w - 8, align: c.key === 'desc' ? 'left' : 'center' });
    x += c.w;
  });
  let y = headerY + baseRowHeight;

  const descCol = cols.find((c) => c.key === 'desc');
  const minRows = Math.max(items.length, 6);
  for (let i = 0; i < minRows; i++) {
    const it = items[i];
    doc.fontSize(9);
    const descText = it ? (it.description || '') : '';
    const descHeight = descText ? doc.heightOfString(descText, { width: descCol.w - 8 }) : 0;
    const rowHeight = Math.max(baseRowHeight, descHeight + 12);

    x = left;
    cols.forEach((c) => {
      doc.rect(x, y, c.w, rowHeight).strokeColor('#ccc').stroke();
      let val = '';
      if (it) {
        if (c.key === 'no') val = String(i + 1);
        else if (c.key === 'date') val = it.transaction_date || '';
        else if (c.key === 'desc') val = it.description || '';
        else if (c.key === 'qty') val = it.quantity != null ? String(it.quantity) : '';
        else if (c.key === 'price') val = it.unit_price != null ? fmtPlain(it.unit_price) : '';
        else if (c.key === 'amount') val = it.quantity != null && it.unit_price != null ? fmtPlain(it.quantity * it.unit_price) : '';
      }
      doc.fontSize(9).text(val, x + 4, y + 6, {
        width: c.w - 8,
        align: c.key === 'desc' ? 'left' : (c.key === 'no' ? 'center' : 'right'),
      });
      x += c.w;
    });
    y += rowHeight;
  }
  doc.y = y + 10;
}

function drawTotalsBox(doc, { subtotal, tax, total, totalLabel }) {
  const right = doc.page.width - doc.page.margins.right;
  const boxWidth = 220;
  const left = right - boxWidth;
  let y = doc.y;
  const rows = [
    ['小計', fmt(subtotal), false],
    ['消費税(10%)', fmt(tax), false],
    [totalLabel, fmt(total), true],
  ];
  rows.forEach(([label, val, emphasize]) => {
    const h = emphasize ? 26 : 20;
    doc.rect(left, y, boxWidth, h).strokeColor('#333').stroke();
    doc.fontSize(emphasize ? 13 : 10).text(label, left + 8, y + (emphasize ? 6 : 5));
    doc.fontSize(emphasize ? 15 : 10).text(val, left, y + (emphasize ? 5 : 5), { width: boxWidth - 8, align: 'right' });
    y += h;
  });
  doc.y = y + 16;
}

function drawInfoPanel(doc, rows) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const boxTop = doc.y;
  let y = boxTop + 8;
  doc.fontSize(9);
  rows.forEach(([label, value]) => {
    if (!value) return;
    doc.text(label, left + 8, y, { width: 70 });
    doc.text(value, left + 80, y, { width: width - 90 });
    y += 16;
  });
  doc.rect(left, boxTop, width, Math.max(y - boxTop + 6, 20)).strokeColor('#999').stroke();
  doc.y = y + 10;
}

const KIND_LABELS = {
  invoice: { title: '請求書', intro: '下記の通りご請求申し上げます。', numberLabel: '請求書番号', dateLabel: '請求日', totalLabel: '請求金額' },
  delivery: { title: '納品書', intro: '下記の通り納品致します。', numberLabel: '納品書番号', dateLabel: '納品日', totalLabel: '合計金額' },
  purchase_order: { title: '発注書', intro: '下記の通り発注いたします。', numberLabel: '発注書番号', dateLabel: '発注日', totalLabel: '発注金額' },
};

function generatePdf({ kind, number, issueDate, dueDate, subject, issuer, client, items, notes }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const labels = KIND_LABELS[kind];
    drawHeaderBlock(doc, {
      title: labels.title,
      intro: labels.intro,
      number,
      numberLabel: labels.numberLabel,
      issueDate,
      dateLabel: labels.dateLabel,
      subject,
      issuer,
      client,
    });

    drawItemsTable(doc, items);

    const totals = require('./db.js').computeTotals(items);
    drawTotalsBox(doc, { ...totals, totalLabel: labels.totalLabel });

    const infoRows = [];
    if (kind === 'invoice') {
      infoRows.push(['入金期日', dueDate]);
      infoRows.push(['振込先', issuer.bank_info]);
    } else if (kind === 'purchase_order') {
      infoRows.push(['希望納期', dueDate]);
    }
    infoRows.push(['備考', notes]);
    drawInfoPanel(doc, infoRows);

    doc.end();
  });
}

// 実際の長期アーカイブはDesktop直下に会社ごとに別フォルダで運用されている
// (Desktop/2020 peops請求書, Desktop/KMC/納品書, Desktop/sunista 請求書 など。
//  「peops office/請求書_納品書テンプレート/発行済み」は2026-08に誤って作った別ツリーだったため廃止)。
// 月フォルダの命名は「YYYY M月」(半角スペース1個、月は0埋めなし)。
function archiveDir(desktopDir, kind, issuerName, dateStr) {
  const [y, m] = dateStr.split('-');
  const monthLabel = `${y} ${Number(m)}月`;
  if (kind === 'invoice') {
    if (issuerName === '株式会社peops') return path.join(desktopDir, '2020 peops請求書', monthLabel, 'pdf');
    if (issuerName === '株式会社sunista') return path.join(desktopDir, 'sunista 請求書', monthLabel);
  } else if (kind === 'delivery') {
    if (issuerName === '株式会社peops') {
      // 2026-09-01よりユーザー指定で、このアプリが作る納品書は新フォルダに保存する
      // (過去分はDesktop/KMC/納品書に残したまま、今後の分だけこちらに切り替え)
      return path.join(desktopDir, '納品書_返品伝票', '納品書', monthLabel);
    }
  } else if (kind === 'purchase_order') {
    // 2026-09-17よりユーザー指定でDesktop直下に発注書専用フォルダを新設(請求書・納品書と同じ運用)
    return path.join(desktopDir, '発注書', monthLabel);
  }
  // 該当する既知アーカイブが無い場合のフォールバック(例: sunistaの納品書アーカイブ未確認)
  const kindLabel = kind === 'invoice' ? '請求書' : kind === 'purchase_order' ? '発注書' : '納品書';
  return path.join(desktopDir, 'peops office', '請求書_納品書テンプレート', '発行済み', kindLabel, monthLabel);
}

function saveInvoicePdfToArchive(desktopDir, kind, issuerName, dateStr, fileBaseName, buffer) {
  const dir = archiveDir(desktopDir, kind, issuerName, dateStr);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileBaseName + '.pdf');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { generatePdf, saveInvoicePdfToArchive, JP_FONT_PATH, JP_FONT_NAME };
