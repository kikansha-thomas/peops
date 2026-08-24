// 初回起動時(data/app.dbが存在しない場合)のみ実行される初期データ投入。
// メモリファイル(project_invoice_migration.md)で実データとして確認できた内容のみを転記し、
// 未確認の金額・明細は捏造しない。

module.exports = function seed(db) {
  const now = new Date().toISOString();

  const insertCompany = db.prepare(`
    INSERT INTO companies
      (name, billing_name, postal_code, address, building_tel_fax, contact_person, email,
       payment_terms, bank_info, invoice_registration_number, notes, is_self,
       next_invoice_no, next_delivery_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const peopsId = insertCompany.run(
    '株式会社peops', null,
    '215-0003', '神奈川県川崎市麻生区高石3-21-1-1', 'TEL 090-5663-9892',
    null, null, null,
    'りそな銀行 祖師谷支店 普通 1594948',
    'T3010901040009', null, 1,
    195, 75, now, now
  ).lastInsertRowid;

  const sunistaId = insertCompany.run(
    '株式会社sunista', null,
    '215-0003', '神奈川県川崎市麻生区高石3-21-1-1', 'TEL 090-5663-9892',
    null, null, null,
    'りそな銀行 祖師谷支店 普通 1607104',
    'T4010901042961', 'sunista側は別のfreeeアカウントで、納品書番号の連番は未確認。発行前に必ず最新番号を確認すること。', 1,
    38, null, now, now
  ).lastInsertRowid;

  const srUnitedId = insertCompany.run(
    'SRユナイテッド株式会社', null,
    '151-0002', '東京都渋谷区渋谷3-27-11', 'YUSHIN BLDG. 本館9F　TEL 03-5771-7147 FAX 03-5771-7160',
    '待井様', 'h.machii@sr-united.co.jp', null,
    null, null, 'ADAM PATEK関連の項目が中心。', 0,
    null, null, now, now
  ).lastInsertRowid;

  const oneId = insertCompany.run(
    'ONE', 'SRユナイテッド株式会社',
    '151-0002', '東京都渋谷区渋谷3-27-11', 'YUSHIN BLDG. 本館9F　TEL 03-5771-7147 FAX 03-5771-7160',
    '久保田様・岡本様', null, null,
    null, null, 'SRユナイテッド株式会社内の別窓口(久保田さん・岡本さんチーム)へのONE.関連請求。書面の宛名は正式法人名(SRユナイテッド株式会社)を使用。', 0,
    null, null, now, now
  ).lastInsertRowid;

  const slcId = insertCompany.run(
    '有限会社SLC', null,
    '153-0063', '東京都目黒区目黒2-15-14', '日置FSDビル5F　TEL 03-6411-6192',
    null, null, '月2回請求(月初=前月分HIKA精算書、月末=もう1回)',
    '東北銀行 鹿角支店 普通3126942(有)エスエルシー',
    'T5-4100-0200-9654', 'エス・エル・シー東京支店。ZOZO HIKA分の売上精算「〇月HIKA精算書」。請求書の発行者は株式会社peops側。', 0,
    null, null, now, now
  ).lastInsertRowid;

  const insertInvoice = db.prepare(`
    INSERT INTO invoices
      (invoice_number, issuer_company_id, client_company_id, issue_date, due_date, subject, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, sort_order, transaction_date, description, quantity, unit_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  function seedInvoice(number, clientId, issueDate, dueDate, subject, notes, items) {
    const invId = insertInvoice.run(
      number, peopsId, clientId, issueDate, dueDate, subject || null, notes || null, now, now
    ).lastInsertRowid;
    items.forEach((it, idx) => {
      insertItem.run(invId, idx + 1, it.date, it.desc, it.qty, it.price);
    });
  }

  // INV-0000000192: SRユナイテッド(待井さん、ADAM PATEK関連)、小計307,855円(実データ確認済み)
  seedInvoice(
    'INV-0000000192', srUnitedId, '2026-08-01', '2026-08-31', null, 'ご担当:待井様',
    [
      { date: '2026-07-31', desc: 'SAMPLE代', qty: 5, price: 10000 },
      { date: '2026-07-31', desc: 'ADAM PATEK SNS運行代行', qty: 1, price: 150000 },
      { date: '2026-07-31', desc: 'ADAM PATEK 自社サイト運営代', qty: 1, price: 50000 },
      { date: '2026-07-01', desc: 'ADAM leatherネーム', qty: 1, price: 34680 },
      { date: '2026-07-01', desc: 'ADAM PATEK 自社サイト売上げ 税抜き¥463,500の5%', qty: 1, price: 23175 },
    ]
  );

  // INV-0000000193: 有限会社SLC、7月HIKA精算書、税込¥2,323,959(実データ確認済み)
  seedInvoice(
    'INV-0000000193', slcId, '2026-08-04', '2026-08-31', '7月HIKA精算書', null,
    [
      { date: '2026-07-01', desc: '7月HIKA精算書', qty: 1, price: 2112690 },
    ]
  );

  // INV-0000000194: ONE(SRユナイテッド久保田さん・岡本さんチーム)、2026-08-06作成、7月締め(実データ確認済み)
  seedInvoice(
    'INV-0000000194', oneId, '2026-08-01', '2026-08-31', null, null,
    [
      { date: '2026-07-31', desc: 'ONE.boraboraPOP UPパネル+送料', qty: 1, price: 2819 },
      { date: '2026-07-31', desc: 'ONE.ディレクション代', qty: 1, price: 150000 },
      { date: '2026-07-01', desc: 'DEL-0000000073納品書分', qty: 1, price: 3219603 },
    ]
  );
};
