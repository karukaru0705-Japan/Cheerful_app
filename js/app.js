// ===== メインアプリ =====
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const yen = (n) => '¥' + (n || 0).toLocaleString('ja-JP');

  // ---------- 集計期間ヘルパー ----------
  // ym: 'YYYY-MM' 文字列に n ヶ月を加算
  function ymAddMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, '0')}`;
  }
  // 設定から現在の期間 {start, end} ('YYYY-MM') を求める
  function getPeriod(settings) {
    const mode = settings.periodMode || 'scale';
    const start = settings.periodStart || defaultFiscalStart();
    if (mode === 'manual') {
      const end = settings.periodEnd || start;
      return { mode, start: minYM(start, end), end: maxYM(start, end) };
    }
    let months = settings.periodScale;
    if (months === 'custom' || months == null) months = Number(settings.periodCustomMonths || 12);
    months = Math.max(1, Number(months) || 12);
    return { mode, start, end: ymAddMonths(start, months - 1), months };
  }
  function minYM(a, b) { return a <= b ? a : b; }
  function maxYM(a, b) { return a >= b ? a : b; }
  function defaultFiscalStart() {
    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${y}-04`;
  }
  function inPeriod(dateStr, period) {
    if (!dateStr) return false;
    const ym = dateStr.slice(0, 7); // 'YYYY-MM'
    return ym >= period.start && ym <= period.end;
  }
  function fmtYM(ym) { const [y, m] = ym.split('-'); return `${y}年${Number(m)}月`; }
  function periodLabel(period) { return `${fmtYM(period.start)}〜${fmtYM(period.end)}`; }

  let state = {
    type: '支出',          // 入力フォームの収入/支出
    editingId: null,       // 編集中の取引id
    pendingPhoto: null,    // 追加予定の写真Blob
    pendingPhotoUrl: null, // プレビューURL
    removePhoto: false,    // 編集時に既存写真を削除するか
    settings: {},
    objectUrls: [],        // 解放用
    listScope: 'period',   // 取引一覧の表示範囲: 'period' | 'all'
    feeTarget: null,
    bulkPayTarget: null
  };

  // ---------- 初期化 ----------
  async function boot() {
    await DB.init();
    state.settings = await DB.getAllSettings();
    bindNav();
    bindEntryForm();
    bindSettings();
    bindSummary();
    bindFee();
    bindList();
    $('#entryDate').value = todayStr();
    await refreshCategories();
    await refreshHeader();
    await renderList();
    registerSW();
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------- ナビゲーション ----------
  function bindNav() {
    $$('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }
  function switchView(view) {
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    if (view === 'list') renderList();
    if (view === 'fee') renderFee();
    if (view === 'summary') renderSummary();
    if (view === 'settings') renderSettings();
    refreshHeader();
    window.scrollTo(0, 0);
  }

  // ---------- ヘッダー ----------
  async function refreshHeader() {
    state.settings = await DB.getAllSettings();
    const period = getPeriod(state.settings);
    const label = state.settings.year ? `${state.settings.year}（${periodLabel(period)}）` : periodLabel(period);
    $('#headerYear').textContent = label;
    const { balance } = await computeBalances();
    $('#headerBalance').textContent = yen(balance);
  }

  // ---------- カテゴリ ----------
  async function refreshCategories() {
    // 部費は「部費」タブで管理するため、入力フォームの収入カテゴリからは除外
    const cats = (await DB.getCategories(state.type)).filter((c) => !(state.type === '収入' && c.name === '部費'));
    const sel = $('#entryCategory');
    sel.innerHTML = '';
    cats.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.name; o.textContent = c.name;
      sel.appendChild(o);
    });
  }

  // ---------- 入力フォーム ----------
  function bindEntryForm() {
    $('#segExpense').addEventListener('click', () => setType('支出'));
    $('#segIncome').addEventListener('click', () => setType('収入'));

    $('#entryPhoto').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (state.pendingPhotoUrl) URL.revokeObjectURL(state.pendingPhotoUrl);
      state.pendingPhoto = file;
      state.removePhoto = false;
      state.pendingPhotoUrl = URL.createObjectURL(file);
      $('#photoPreviewImg').src = state.pendingPhotoUrl;
      $('#photoPreview').classList.remove('hidden');
    });
    $('#photoRemove').addEventListener('click', clearPhotoInput);

    $('#entryForm').addEventListener('submit', onSubmitEntry);
    $('#entryCancel').addEventListener('click', resetEntryForm);
  }

  function setType(type) {
    state.type = type;
    const isExp = type === '支出';
    $('#segExpense').classList.toggle('active', isExp);
    $('#segIncome').classList.toggle('active', !isExp);
    $('#descLabel').textContent = isExp ? '支出内訳（任意入力）' : '収入内訳（任意入力）';
    $('#entryDesc').placeholder = isExp ? '例：体育館使用料、交流大会参加費、忘年会' : '例：学校開放当番、雑収入、寄付';
    refreshCategories();
  }

  function clearPhotoInput() {
    if (state.pendingPhotoUrl) URL.revokeObjectURL(state.pendingPhotoUrl);
    state.pendingPhoto = null;
    state.pendingPhotoUrl = null;
    state.removePhoto = true;
    $('#entryPhoto').value = '';
    $('#photoPreviewImg').src = '';
    $('#photoPreview').classList.add('hidden');
  }

  async function onSubmitEntry(e) {
    e.preventDefault();
    const amount = parseInt($('#entryAmount').value, 10);
    if (isNaN(amount) || amount < 0) { toast('金額を正しく入力してください'); return; }

    const data = {
      date: $('#entryDate').value,
      type: state.type,
      category: $('#entryCategory').value,
      amount,
      desc: $('#entryDesc').value.trim(),
      note: ''
    };

    // 写真処理
    let photoId = null;
    if (state.editingId) {
      const existing = await DB.getTransaction(state.editingId);
      photoId = existing ? existing.photoId || null : null;
      if (state.removePhoto && photoId) { await DB.deletePhoto(photoId); photoId = null; }
    }
    if (state.pendingPhoto) {
      if (photoId) await DB.deletePhoto(photoId);
      photoId = await DB.addPhoto(state.pendingPhoto);
    }
    if (photoId) data.photoId = photoId;

    if (state.editingId) {
      data.id = state.editingId;
      await DB.updateTransaction(data);
      toast('更新しました');
    } else {
      await DB.addTransaction(data);
      toast('追加しました');
    }
    resetEntryForm();
    await refreshHeader();
    await renderList();
  }

  function resetEntryForm() {
    state.editingId = null;
    $('#entryId').value = '';
    $('#entryForm').reset();
    $('#entryDate').value = todayStr();
    clearPhotoInput();
    state.removePhoto = false;
    $('#entrySubmit').textContent = '追加する';
    $('#entryCancel').classList.add('hidden');
    $('.view-title', $('#view-entry')) && ($('#view-entry .view-title').textContent = '収支を入力');
    setType('支出');
  }

  async function editTransaction(id) {
    const t = await DB.getTransaction(id);
    if (!t) return;
    state.editingId = id;
    setType(t.type);
    await refreshCategories();
    $('#entryDate').value = t.date;
    $('#entryCategory').value = t.category;
    $('#entryAmount').value = t.amount;
    $('#entryDesc').value = t.desc || '';
    state.pendingPhoto = null; state.removePhoto = false;
    if (t.photoId) {
      const blob = await DB.getPhoto(t.photoId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        state.objectUrls.push(url);
        $('#photoPreviewImg').src = url;
        $('#photoPreview').classList.remove('hidden');
      }
    } else {
      $('#photoPreview').classList.add('hidden');
    }
    $('#entrySubmit').textContent = '更新する';
    $('#entryCancel').classList.remove('hidden');
    $('#view-entry .view-title').textContent = '取引を編集';
    switchView('entry');
  }

  // ---------- 残高計算 ----------
  async function computeBalances() {
    const settings = await DB.getAllSettings();
    const carryover = Number(settings.carryover || 0);
    const period = getPeriod(settings);
    const allTxs = await DB.getAllTransactions();
    const txs = allTxs.filter((t) => inPeriod(t.date, period));
    let incomeSum = 0, expenseSum = 0;
    txs.forEach((t) => {
      if (t.type === '収入') { if (t.category === '部費') return; incomeSum += t.amount; } // 部費はグリッド管理
      else expenseSum += t.amount;
    });
    const fee = await computeFeeTotals();
    const incomeTotal = carryover + incomeSum + fee.done;
    const balance = incomeTotal - expenseSum;
    return { carryover, incomeSum, expenseSum, incomeTotal, expenseTotal: expenseSum, balance, txs, allCount: allTxs.length, period, feeDone: fee.done };
  }

  // ---------- 取引一覧 ----------
  // 部費納付イベント（feeCellsをpaidDate単位にまとめた仮想取引）
  async function buildFeeEvents() {
    const members = await DB.getMembers();
    const cells = await DB.getFeeCells();
    const settings = await DB.getAllSettings();
    const fee = Number(settings.monthlyFee || 1000);
    const memberMap = {};
    members.forEach((m) => { memberMap[m.id] = m.name; });
    const grouped = {}; // key: memberId + '|' + paidDate
    cells.forEach((c) => {
      if (c.status !== 'done1') return;
      const [mid, ym] = c.key.split('|');
      if (!memberMap[mid]) return;
      const dateKey = c.paidDate || '0000-00-00';
      const k = `${mid}|${dateKey}`;
      (grouped[k] = grouped[k] || []).push(ym);
    });
    const events = [];
    for (const [k, ymList] of Object.entries(grouped)) {
      const [mid, dateKey] = k.split('|');
      ymList.sort();
      const known = dateKey !== '0000-00-00';
      const amount = ymList.length * fee;
      events.push({
        date: dateKey,
        type: '収入',
        category: '部費',
        amount,
        desc: formatFeeMonths(memberMap[mid], ymList) + (known ? '' : '（納付日未記録）'),
        source: 'fee',
        memberId: mid,
        ymList,
        known
      });
    }
    return events;
  }
  function formatFeeMonths(name, ymList) {
    if (ymList.length === 1) return `${name}：${monthLabelShort(ymList[0])}分`;
    let consecutive = true;
    for (let i = 1; i < ymList.length; i++) {
      if (ymAddMonths(ymList[i - 1], 1) !== ymList[i]) { consecutive = false; break; }
    }
    if (consecutive) return `${name}：${monthLabelShort(ymList[0])}〜${monthLabelShort(ymList[ymList.length - 1])}分（${ymList.length}ヶ月）`;
    return `${name}：${ymList.map(monthLabelShort).join('・')}分（${ymList.length}ヶ月）`;
  }
  function monthLabelShort(ym) { return `${Number(ym.split('-')[1])}月`; }

  async function renderList() {
    const settings = await DB.getAllSettings();
    const carryover = Number(settings.carryover || 0);
    const period = getPeriod(settings);
    const scope = state.listScope || 'period';

    const allTxs = await DB.getAllTransactions();
    // 部費はグリッド管理なので、入力タブで誤って「部費」カテゴリの取引があっても二重計上を避けて除外
    const txs = allTxs.filter((t) => !(t.type === '収入' && t.category === '部費'));
    const feeEvents = await buildFeeEvents();
    let items = [
      ...txs.map((t) => ({ ...t, source: 'tx' })),
      ...feeEvents
    ];
    const totalAll = items.length;
    if (scope === 'period') {
      items = items.filter((it) => {
        if (it.source === 'tx') return inPeriod(it.date, period);
        // 部費イベントは「対象月のいずれかが期間内」なら表示（後日納付・前納に対応）
        if (it.source === 'fee') return (it.ymList || []).some((ym) => ym >= period.start && ym <= period.end);
        return false;
      });
    }
    items.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    let run = carryover;
    const withBalance = items.map((it) => {
      run += (it.type === '収入' ? it.amount : -it.amount);
      return { ...it, runningBalance: run };
    });

    $('#listCarryover').textContent = yen(carryover);
    $('#listEndBalance').textContent = yen(run);
    $('#listPeriod').textContent = scope === 'period'
      ? `期間：${periodLabel(period)}　（${items.length}件${totalAll > items.length ? ` / 全${totalAll}件中` : ''}）`
      : `全期間（${items.length}件、古い順）`;

    const list = $('#txList');
    list.innerHTML = '';
    if (withBalance.length === 0) {
      const empty = $('#txEmpty');
      empty.textContent = totalAll > 0
        ? 'この期間の取引はありません。「全期間」に切替えるか期間を変えてください。'
        : 'まだ取引がありません。「入力」または「部費」から追加してください。';
      empty.classList.remove('hidden');
      return;
    }
    $('#txEmpty').classList.add('hidden');

    let currentMonth = null;
    for (const t of withBalance) {
      const ym = t.date.slice(0, 7);
      if (ym !== currentMonth) {
        currentMonth = ym;
        const h = document.createElement('div');
        h.className = 'tx-month';
        h.textContent = ym === '0000-00' ? '（納付日未記録）' : `${ym.split('-')[0]}年${Number(ym.split('-')[1])}月`;
        list.appendChild(h);
      }
      const el = document.createElement('div');
      el.className = 'tx-item' + (t.source === 'fee' ? ' fee-event' : '');
      const photoIco = t.photoId ? '<span class="tx-photo-ico">📷</span>' : '';
      const editButtons = t.source === 'tx' ? `
        <div class="tx-actions">
          <button data-act="edit" title="編集">✎</button>
          <button data-act="del" title="削除">🗑</button>
        </div>` : '';
      const dateLabel = t.date === '0000-00-00' ? '（日付未記録）' : t.date;
      el.innerHTML = `
        <div class="tx-main">
          <div class="tx-desc">${esc(t.desc || t.category)}</div>
          <div class="tx-meta"><span class="tx-cat-badge">${esc(t.category)}</span>${dateLabel} ${photoIco}</div>
        </div>
        <div class="tx-right">
          <div class="tx-amount ${t.type}">${t.type === '収入' ? '+' : '−'}${yen(t.amount)}</div>
          <div class="tx-balance">残 ${yen(t.runningBalance)}</div>
        </div>
        ${editButtons}`;
      if (t.source === 'tx') {
        el.querySelector('[data-act="edit"]').addEventListener('click', () => editTransaction(t.id));
        el.querySelector('[data-act="del"]').addEventListener('click', () => onDelete(t.id, t.desc));
        if (t.photoId) {
          el.querySelector('.tx-main').addEventListener('click', () => showPhoto(t.photoId));
          el.querySelector('.tx-main').style.cursor = 'zoom-in';
        }
      }
      list.appendChild(el);
    }
  }

  async function onDelete(id, desc) {
    if (!confirm(`「${desc || 'この取引'}」を削除しますか？`)) return;
    await DB.deleteTransaction(id);
    toast('削除しました');
    await refreshHeader();
    await renderList();
  }

  async function showPhoto(photoId) {
    const blob = await DB.getPhoto(photoId);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    $('#imgModalImg').src = url;
    $('#imgModal').classList.remove('hidden');
  }
  $('#imgModal').addEventListener('click', () => $('#imgModal').classList.add('hidden'));

  // ---------- 集計 ----------
  async function aggregate() {
    const settings = await DB.getAllSettings();
    const carryover = Number(settings.carryover || 0);
    const period = getPeriod(settings);
    const txs = (await DB.getAllTransactions()).filter((t) => inPeriod(t.date, period));
    const incomeCats = (await DB.getCategories('収入')).map((c) => c.name);
    const expenseCats = (await DB.getCategories('支出')).map((c) => c.name);

    const group = (type, catList) => {
      const map = {};
      catList.forEach((c) => { map[c] = { cat: c, amount: 0, details: [] }; });
      txs.filter((t) => t.type === type).forEach((t) => {
        if (!map[t.category]) map[t.category] = { cat: t.category, amount: 0, details: [] };
        map[t.category].amount += t.amount;
        const d = (t.note || t.desc || '').trim();
        if (d) map[t.category].details.push(`${d}：${t.amount.toLocaleString('ja-JP')}円`);
      });
      return map;
    };

    const incMap = group('収入', incomeCats);
    const expMap = group('支出', expenseCats);

    // 前年度繰越金は設定値を加算
    if (!incMap['前年度繰越金']) incMap['前年度繰越金'] = { cat: '前年度繰越金', amount: 0, details: [] };
    incMap['前年度繰越金'].amount += carryover;

    // 部費はグリッド（済合計）で上書き。内訳は「1,000円×Nヶ月」
    const fee = await computeFeeTotals();
    if (!incMap['部費']) incMap['部費'] = { cat: '部費', amount: 0, details: [] };
    incMap['部費'].amount = fee.done;
    incMap['部費'].details = fee.done1Count
      ? [`${fee.fee.toLocaleString('ja-JP')}円×${fee.done1Count}ヶ月（集金済）`]
      : [];

    const orderedInc = ['前年度繰越金', ...incomeCats.filter((c) => c !== '前年度繰越金'),
      ...Object.keys(incMap).filter((c) => c !== '前年度繰越金' && !incomeCats.includes(c))];
    const orderedExp = [...expenseCats, ...Object.keys(expMap).filter((c) => !expenseCats.includes(c))];

    const incomeRows = orderedInc.map((c) => ({ cat: c, amount: incMap[c].amount, detail: incMap[c].details.join('\n') }));
    const expenseRows = orderedExp.map((c) => ({ cat: c, amount: expMap[c].amount, detail: expMap[c].details.join('\n') }));

    const incomeTotal = incomeRows.reduce((s, r) => s + r.amount, 0);
    const expenseTotal = expenseRows.reduce((s, r) => s + r.amount, 0);

    return { year: settings.year || '', periodText: periodLabel(period), carryover, incomeRows, expenseRows, incomeTotal, expenseTotal, balance: incomeTotal - expenseTotal };
  }

  async function renderSummary() {
    const agg = await aggregate();

    const renderTable = (rows) => rows.map((r) => `
      <tr>
        <td class="cat">${esc(r.cat)}</td>
        <td class="amt">${yen(r.amount)}</td>
      </tr>
      ${r.detail ? `<tr><td colspan="2" class="detail">${esc(r.detail).replace(/\n/g, '<br>')}</td></tr>` : ''}
    `).join('');

    $('#incomeTable').innerHTML = renderTable(agg.incomeRows) +
      `<tr class="subtotal"><td class="cat">収入合計</td><td class="amt">${yen(agg.incomeTotal)}</td></tr>`;
    $('#expenseTable').innerHTML = renderTable(agg.expenseRows) +
      `<tr class="subtotal"><td class="cat">支出合計</td><td class="amt">${yen(agg.expenseTotal)}</td></tr>`;

    $('#sumIncome').textContent = yen(agg.incomeTotal);
    $('#sumExpense').textContent = yen(agg.expenseTotal);
    $('#sumBalance').textContent = yen(agg.balance);

    // 整合チェック
    const settings = await DB.getAllSettings();
    const actual = settings.actualBalance;
    const box = $('#integrityBox');
    box.classList.remove('hidden');
    let inner = `
      <div style="flex:1">
        <div style="font-weight:700;margin-bottom:6px">整合チェック</div>
        <div>計算上の残高：<strong>${yen(agg.balance)}</strong></div>
        <label style="display:block;margin-top:8px;font-size:13px;color:var(--muted)">実際の現金残高（数えた金額）</label>
        <input type="number" id="actualBalanceInput" inputmode="numeric" step="1" value="${actual != null ? actual : ''}"
          placeholder="未入力" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:4px" />
      </div>`;
    box.className = 'integrity card';
    if (actual != null && actual !== '') {
      const diff = Number(actual) - agg.balance;
      if (diff === 0) {
        box.classList.add('ok');
        inner = `<div class="ico">✅</div>` + inner + `<div style="flex-basis:100%;margin-top:6px;font-weight:700">一致しています（差0円）</div>`;
      } else {
        box.classList.add('warn');
        const sign = diff > 0 ? '多い' : '不足';
        inner = `<div class="ico">⚠️</div>` + inner +
          `<div style="flex-basis:100%;margin-top:6px;font-weight:700;color:#b45309">差額 ${yen(Math.abs(diff))}（実残高が${sign}）</div>`;
      }
    } else {
      inner = `<div class="ico">ℹ️</div>` + inner;
    }
    box.innerHTML = inner;
    const ab = $('#actualBalanceInput');
    if (ab) ab.addEventListener('change', async () => {
      const v = ab.value === '' ? null : parseInt(ab.value, 10);
      await DB.setSetting('actualBalance', v);
      renderSummary();
    });
  }

  function bindSummary() {
    $('#exportExcel').addEventListener('click', async () => {
      const agg = await aggregate();
      try { ExcelExport.download(agg); toast('Excelを書き出しました'); }
      catch (err) { console.error(err); toast('書き出しに失敗しました'); }
    });
    $('#openReport').addEventListener('click', async () => { await renderReport(); $('#reportModal').classList.remove('hidden'); });
    $('#reportClose').addEventListener('click', () => $('#reportModal').classList.add('hidden'));
    $('#reportPrint').addEventListener('click', () => window.print());
  }

  // ---------- 会計報告プレビュー（多ページ） ----------
  async function renderReport() {
    const agg = await aggregate();
    const settings = await DB.getAllSettings();
    const actual = settings.actualBalance;
    const team = settings.teamName || 'チアフル';
    const treasurer = settings.treasurerName || '（未設定）';
    const yf = (n) => '¥' + (n || 0).toLocaleString('ja-JP');
    const dtl = (d) => d ? esc(d).replace(/\n/g, '<br>') : '';

    // --- 収支表 ---
    const incN = agg.incomeRows.length;
    const incRows = agg.incomeRows.map((r, i) =>
      `<tr>${i === 0 ? `<td class="vlabel" rowspan="${incN + 1}">収入</td>` : ''}<td>${esc(r.cat)}</td><td class="amt">${yf(r.amount)}</td><td class="dtl">${dtl(r.detail)}</td></tr>`
    ).join('');
    const expN = agg.expenseRows.length;
    const expRows = agg.expenseRows.map((r, i) =>
      `<tr>${i === 0 ? `<td class="vlabel" rowspan="${expN + 1}">支出</td>` : ''}<td>${esc(r.cat)}</td><td class="amt">${yf(r.amount)}</td><td class="dtl">${dtl(r.detail)}</td></tr>`
    ).join('');
    let balanceBlock = `<div class="report-balance">差引残高　${yf(agg.balance)}</div>`;
    if (actual != null && actual !== '') {
      const diff = Number(actual) - agg.balance;
      const note = diff === 0 ? '（一致）' : (diff > 0 ? `（実残高が ${yf(Math.abs(diff))} 多い）` : `（実残高が ${yf(Math.abs(diff))} 不足）`);
      balanceBlock += `<div class="report-sub">実際の現金残高 ${yf(Number(actual))}／差額 ${yf(diff)} ${note}</div>`;
    }

    // --- 部費グリッド（読み取り専用） ---
    const feeT = await computeFeeTotals();
    const cellMap = feeT.cellMap;
    const monthHdr = feeT.months.map((ym) => `<th>${Number(ym.split('-')[1])}月</th>`).join('');
    let feeGridRows = '';
    feeT.members.forEach((m) => {
      let cells = '';
      feeT.months.forEach((ym) => {
        const cell = cellMap[`${m.id}|${ym}`];
        const st = cell && cell.status;
        let inner = '–';
        if (st === 'done1') inner = '●';
        else if (st === 'plan1') inner = '◯';
        cells += `<td>${inner}</td>`;
      });
      feeGridRows += `<tr><td class="name-col">${esc(m.name)}</td>${cells}<td class="sub-col">${yf(feeT.memberSub[m.id].done)}</td></tr>`;
    });
    const feeGridTable = feeT.members.length === 0
      ? '<p>（メンバー未登録）</p>'
      : `<table class="report-fee-grid">
          <tr><th class="name-col">メンバー</th>${monthHdr}<th>済小計</th></tr>
          ${feeGridRows}
          <tr class="tot"><td class="name-col">合計</td><td colspan="${feeT.months.length}">済 ${yf(feeT.done)} ／ 予定 ${yf(feeT.plan)}</td><td class="sub-col">${yf(feeT.done)}</td></tr>
        </table>
        <p class="report-fee-legend">●=参加・集金済 ／ ◯=参加・未集金 ／ – =対象外</p>`;

    // --- 納付履歴（時系列） ---
    const events = (await buildFeeEvents()).sort((a, b) => a.date < b.date ? -1 : 1);
    const eventListHtml = events.length === 0
      ? '<p>（納付履歴はまだありません）</p>'
      : `<table class="report-event-list">
          <tr><th>納付日</th><th>内容</th><th class="amt">金額</th></tr>
          ${events.map((e) => `<tr><td>${e.known ? e.date : '日付未記録'}</td><td>${esc(e.desc)}</td><td class="amt">${yf(e.amount)}</td></tr>`).join('')}
          <tr class="tot"><td colspan="2">納付合計</td><td class="amt">${yf(events.reduce((s, e) => s + e.amount, 0))}</td></tr>
        </table>`;

    const today = todayStr();

    $('#reportBody').innerHTML = `
      <!-- 表紙 -->
      <div class="report-page cover-page">
        <div class="cover-team">${esc(team)}</div>
        <div class="cover-title">${esc(agg.year || '')}　会計報告書</div>
        <div class="cover-meta">
          作成日：${today}<br>
          会計担当者：${esc(treasurer)}
        </div>
      </div>

      <!-- 目次 -->
      <div class="report-page toc-page">
        <h2 class="page-title">目次</h2>
        <ol class="toc-list">
          <li>収支報告</li>
          <li>部費納付一覧（メンバー×月）</li>
          <li>部費納付履歴（日付順）</li>
          <li>監査確認</li>
        </ol>
      </div>

      <!-- 1. 収支報告 -->
      <div class="report-page">
        <h2 class="page-title">1. 収支報告</h2>
        <div class="page-sub">${esc(agg.year || '')}　${esc(agg.periodText)}</div>
        <table class="report-table">
          <tr><th></th><th>摘要</th><th>金額</th><th>内訳</th></tr>
          ${incRows}
          <tr class="tot"><td>収入合計</td><td class="amt">${yf(agg.incomeTotal)}</td><td></td></tr>
        </table>
        <table class="report-table">
          <tr><th></th><th>摘要</th><th>金額</th><th>内訳</th></tr>
          ${expRows}
          <tr class="tot"><td>支出合計</td><td class="amt">${yf(agg.expenseTotal)}</td><td></td></tr>
        </table>
        ${balanceBlock}
      </div>

      <!-- 2. 部費納付一覧 -->
      <div class="report-page">
        <h2 class="page-title">2. 部費納付一覧（メンバー×月）</h2>
        ${feeGridTable}
      </div>

      <!-- 3. 部費納付履歴 -->
      <div class="report-page">
        <h2 class="page-title">3. 部費納付履歴（日付順）</h2>
        ${eventListHtml}
      </div>

      <!-- 4. 監査確認 -->
      <div class="report-page">
        <h2 class="page-title">4. 監査確認</h2>
        <p>本会計報告書の内容を確認しました。</p>
        <div class="audit-block">
          <div class="audit-row">
            <span class="audit-label">会計担当者</span>
            <span class="audit-sign">${esc(treasurer || '　　　　　　　')}　　自署：__________________</span>
            <span class="audit-date">日付：　　年　月　日</span>
          </div>
          <div class="audit-row">
            <span class="audit-label">監査者①</span>
            <span class="audit-sign">自署：__________________</span>
            <span class="audit-date">日付：　　年　月　日</span>
          </div>
          <div class="audit-row">
            <span class="audit-label">監査者②</span>
            <span class="audit-sign">自署：__________________</span>
            <span class="audit-date">日付：　　年　月　日</span>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- 部費（メンバー×月グリッド） ----------
  function monthsInPeriod(period) {
    const months = [];
    let ym = period.start;
    for (let i = 0; i < 600 && ym <= period.end; i++) { months.push(ym); ym = ymAddMonths(ym, 1); }
    return months;
  }

  async function computeFeeTotals() {
    const settings = await DB.getAllSettings();
    const fee = Number(settings.monthlyFee || 1000);
    const period = getPeriod(settings);
    const months = monthsInPeriod(period);
    const members = await DB.getMembers();
    const cellMap = await DB.getFeeCellMap();
    const amt = (st) => (st === 'done1' || st === 'plan1') ? fee : 0;
    const isDone = (st) => st === 'done1';
    let done = 0, plan = 0, done1Count = 0, plan1Count = 0;
    const memberSub = {};
    members.forEach((m) => {
      let sd = 0, sp = 0;
      months.forEach((ym) => {
        const cell = cellMap[`${m.id}|${ym}`];
        const st = cell && cell.status;
        const a = amt(st); if (!a) return;
        sp += a; if (isDone(st)) sd += a;
        if (st === 'done1') done1Count++;
        else if (st === 'plan1') plan1Count++;
      });
      memberSub[m.id] = { done: sd, plan: sp };
      done += sd; plan += sp;
    });
    return { fee, period, months, members, cellMap, done, plan, unpaid: plan - done,
      memberSub, done1Count, plan1Count };
  }

  function feeCellInner(st, fee) {
    if (st === 'done1') return `<span class="fee-mark done">●</span><span class="fee-amt">${fee.toLocaleString('ja-JP')}</span>`;
    if (st === 'plan1') return `<span class="fee-mark plan">◯</span><span class="fee-amt">${fee.toLocaleString('ja-JP')}</span>`;
    return `<span class="fee-dash">–</span>`;
  }

  function buildFeeGrid(t) {
    const monthHdr = t.months.map((ym) => `<th>${Number(ym.split('-')[1])}月</th>`).join('');
    let html = `<table class="fee-grid"><tr><th class="name-col">メンバー</th>${monthHdr}<th>小計</th></tr>`;
    t.members.forEach((m) => {
      let cells = '';
      t.months.forEach((ym) => {
        const cell = t.cellMap[`${m.id}|${ym}`];
        const st = cell && cell.status;
        cells += `<td><div class="fee-cell" data-member="${m.id}" data-ym="${ym}">${feeCellInner(st, t.fee)}</div></td>`;
      });
      html += `<tr><td class="name-col">${esc(m.name)}<button class="bulk-pay-btn" data-member="${m.id}" title="まとめて納付">💰</button></td>${cells}<td class="sub-col">${yen(t.memberSub[m.id].done)}</td></tr>`;
    });
    html += `<tr class="fee-total"><td class="name-col">合計</td><td colspan="${t.months.length}">済 ${yen(t.done)} ／ 予定 ${yen(t.plan)}</td><td class="sub-col">${yen(t.done)}</td></tr>`;
    html += `</table>`;
    return html;
  }

  async function renderFee() {
    const t = await computeFeeTotals();
    $('#feePeriod').textContent = `期間：${periodLabel(t.period)}（${t.months.length}ヶ月）　月会費 ${yen(t.fee)}／お休み ${yen(t.half)}`;

    const ul = $('#memberList');
    ul.innerHTML = '';
    t.members.forEach((m) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${esc(m.name)}</span><button title="削除">✕</button>`;
      li.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`メンバー「${m.name}」を削除しますか？（このメンバーの部費入力も消えます）`)) return;
        await DB.deleteMember(m.id);
        await renderFee();
        await refreshHeader();
        toast('メンバーを削除しました');
      });
      ul.appendChild(li);
    });

    const wrap = $('#feeGridWrap');
    if (t.members.length === 0) {
      wrap.innerHTML = '';
      $('#feeHint').classList.remove('hidden');
    } else {
      $('#feeHint').classList.add('hidden');
      wrap.innerHTML = buildFeeGrid(t);
      wrap.querySelectorAll('.fee-cell').forEach((cell) => {
        cell.addEventListener('click', () => {
          const mid = cell.dataset.member;
          const member = t.members.find((x) => String(x.id) === String(mid));
          openFeeSheet(mid, cell.dataset.ym, member ? member.name : '');
        });
      });
      wrap.querySelectorAll('.bulk-pay-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mid = btn.dataset.member;
          const m = t.members.find((x) => String(x.id) === String(mid));
          openBulkPaySheet(mid, m ? m.name : '');
        });
      });
    }

    $('#feeDone').textContent = yen(t.done);
    $('#feePlan').textContent = yen(t.plan);
    $('#feeUnpaid').textContent = yen(t.unpaid);

    // 納付履歴（部費イベントを古い順）
    const events = (await buildFeeEvents()).sort((a, b) => a.date < b.date ? -1 : 1);
    const ev = $('#feeEventList');
    if (events.length === 0) {
      ev.innerHTML = '<p class="empty-msg" style="padding:8px">納付履歴はまだありません。</p>';
    } else {
      ev.innerHTML = events.map((e) => {
        const date = e.known ? e.date : '日付未記録';
        return `<div class="fee-event-row${e.known ? '' : ' unknown'}">
          <span class="ev-date">${date}</span>
          <span class="ev-desc">${esc(e.desc)}</span>
          <span class="ev-amount">${yen(e.amount)}</span>
        </div>`;
      }).join('');
    }
  }

  function openFeeSheet(memberId, ym, name) {
    state.feeTarget = { memberId, ym };
    $('#feeSheetTitle').textContent = `${name || ''}　${Number(ym.split('-')[1])}月分`;
    $('#feeSheet').classList.remove('hidden');
  }
  function closeFeeSheet() { $('#feeSheet').classList.add('hidden'); state.feeTarget = null; }

  // ---------- まとめて納付 ----------
  async function openBulkPaySheet(memberId, name) {
    const settings = await DB.getAllSettings();
    const period = getPeriod(settings);
    state.bulkPayTarget = { memberId, name };
    $('#bulkPayTitle').textContent = `${name}さん：まとめて納付`;
    $('#bulkPayStart').value = period.start;
    $('#bulkPayEnd').value = period.end;
    $('#bulkPayDate').value = todayStr();
    updateBulkPayAmount();
    $('#bulkPaySheet').classList.remove('hidden');
  }
  function closeBulkPaySheet() { $('#bulkPaySheet').classList.add('hidden'); state.bulkPayTarget = null; }

  async function updateBulkPayAmount() {
    const start = $('#bulkPayStart').value;
    const end = $('#bulkPayEnd').value;
    const box = $('#bulkPayAmount');
    if (!start || !end || start > end) { box.textContent = '開始月と終了月を選んでください'; return; }
    const months = monthsInPeriod({ start, end });
    const settings = await DB.getAllSettings();
    const fee = Number(settings.monthlyFee || 1000);
    const amount = months.length * fee;
    box.textContent = `合計：${yen(amount)}（${months.length}ヶ月 × ${yen(fee)}）`;
  }

  async function confirmBulkPay() {
    const t = state.bulkPayTarget;
    if (!t) return;
    const start = $('#bulkPayStart').value;
    const end = $('#bulkPayEnd').value;
    const paidDate = $('#bulkPayDate').value || todayStr();
    if (!start || !end || start > end) { toast('期間を正しく指定してください'); return; }
    const months = monthsInPeriod({ start, end });
    for (const ym of months) {
      await DB.setFeeCell(`${t.memberId}|${ym}`, 'done1', paidDate);
    }
    closeBulkPaySheet();
    await renderFee();
    await refreshHeader();
    toast(`${months.length}ヶ月分を集金済として登録しました`);
  }

  async function addMemberHandler() {
    const name = $('#newMember').value.trim();
    if (!name) return;
    const id = await DB.addMember(name);
    // 期間の全月を「参加・未集金」で初期セット
    const months = monthsInPeriod(getPeriod(await DB.getAllSettings()));
    for (const ym of months) await DB.setFeeCell(`${id}|${ym}`, 'plan1');
    $('#newMember').value = '';
    await renderFee();
    await refreshHeader();
    toast('メンバーを追加（全月を参加・未集金にしました）');
  }

  function bindList() {
    $$('.list-scope').forEach((b) => b.addEventListener('click', () => {
      $$('.list-scope').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.listScope = b.dataset.scope;
      renderList();
    }));
  }

  function bindFee() {
    $('#addMember').addEventListener('click', addMemberHandler);
    $('#newMember').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMemberHandler(); } });
    $('#feeSheet').addEventListener('click', (e) => { if (e.target.id === 'feeSheet') closeFeeSheet(); });
    // まとめて納付
    $('#bulkPaySheet').addEventListener('click', (e) => { if (e.target.id === 'bulkPaySheet') closeBulkPaySheet(); });
    $('#bulkPayCancel').addEventListener('click', closeBulkPaySheet);
    $('#bulkPayConfirm').addEventListener('click', confirmBulkPay);
    ['#bulkPayStart', '#bulkPayEnd', '#bulkPayDate'].forEach((sel) => $(sel).addEventListener('input', updateBulkPayAmount));
    $$('#feeSheet .sheet-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const status = btn.dataset.status;
      if (status === 'cancel') { closeFeeSheet(); return; }
      if (state.feeTarget) {
        // 集金済にする時は今日の日付を納付日として記録（後でまとめて納付UIで上書き可）
        const paidDate = status === 'done1' ? todayStr() : null;
        await DB.setFeeCell(`${state.feeTarget.memberId}|${state.feeTarget.ym}`, status, paidDate);
        closeFeeSheet();
        await renderFee();
        await refreshHeader();
      }
    }));
  }

  // ---------- 設定 ----------
  function bindSettings() {
    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await DB.setSetting('teamName', $('#setTeam').value.trim() || 'チアフル');
      await DB.setSetting('year', $('#setYear').value.trim());
      await DB.setSetting('treasurerName', $('#setTreasurer').value.trim());
      await DB.setSetting('carryover', parseInt($('#setCarryover').value, 10) || 0);
      await DB.setSetting('monthlyFee', parseInt($('#setFee').value, 10) || 1000);
      toast('設定を保存しました');
      await refreshHeader();
    });
    // 集計期間
    $$('.period-mode').forEach((b) => b.addEventListener('click', () => {
      $$('.period-mode').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const mode = b.dataset.mode;
      $('#scaleFields').classList.toggle('hidden', mode !== 'scale');
      $('#manualFields').classList.toggle('hidden', mode !== 'manual');
      updatePeriodPreview();
    }));
    $('#periodScale').addEventListener('change', () => {
      $('#customMonthsField').classList.toggle('hidden', $('#periodScale').value !== 'custom');
      updatePeriodPreview();
    });
    ['#periodCustomMonths', '#periodStartScale', '#periodStartManual', '#periodEndManual'].forEach((sel) => {
      $(sel).addEventListener('input', updatePeriodPreview);
    });
    $('#savePeriod').addEventListener('click', savePeriodSettings);

    $('#addIncomeCat').addEventListener('click', () => addCat('収入', '#newIncomeCat'));
    $('#addExpenseCat').addEventListener('click', () => addCat('支出', '#newExpenseCat'));

    $('#exportJson').addEventListener('click', exportBackup);
    $('#importJson').addEventListener('change', importBackup);
    $('#resetData').addEventListener('click', resetData);
  }

  async function renderSettings() {
    const s = await DB.getAllSettings();
    $('#setTeam').value = s.teamName || 'チアフル';
    $('#setYear').value = s.year || '';
    $('#setTreasurer').value = s.treasurerName || '';
    $('#setCarryover').value = s.carryover != null ? s.carryover : '';
    $('#setFee').value = s.monthlyFee != null ? s.monthlyFee : 1000;
    renderPeriodFields(s);
    await renderCatLists();
    renderBackupStatus(s);
  }

  function renderBackupStatus(s) {
    const lastEl = $('#lastBackup');
    const notice = $('#backupNotice');
    notice.classList.add('hidden');
    if (s.lastBackupDate) {
      const last = new Date(s.lastBackupDate + 'T00:00');
      const days = Math.floor((Date.now() - last.getTime()) / 86400000);
      lastEl.textContent = `最終バックアップ：${s.lastBackupDate}（${days}日前）`;
    } else {
      lastEl.textContent = '最終バックアップ：未取得';
    }
    // 年度末リマインダー：期間が終了済み（または残り30日以内）でバックアップが古い場合
    const period = getPeriod(s);
    const today = todayStr();
    const periodEndDate = period.end + '-28';
    const lastBk = s.lastBackupDate || '0000-00-00';
    let warn = null;
    if (today > period.end + '-31') {
      if (lastBk < period.end + '-01') warn = `🔔 期間が終了しています（${periodLabel(period)}）。年度のバックアップを取り、共有Driveに保存しましょう。`;
    } else if (today >= period.end + '-01') {
      warn = `📅 期間の最終月です（〜${period.end}）。年度末バックアップの準備をお忘れなく。`;
    }
    if (warn) {
      notice.className = 'integrity warn';
      notice.innerHTML = `<div class="ico">⚠️</div><div style="flex:1;font-weight:600">${esc(warn)}</div>`;
      notice.classList.remove('hidden');
    }
  }

  // ---------- 集計期間UI ----------
  function readPeriodForm() {
    const mode = ($('.period-mode.active') || {}).dataset ? $('.period-mode.active').dataset.mode : 'scale';
    if (mode === 'manual') {
      return { periodMode: 'manual', periodStart: $('#periodStartManual').value, periodEnd: $('#periodEndManual').value };
    }
    const scaleVal = $('#periodScale').value;
    return {
      periodMode: 'scale',
      periodScale: scaleVal === 'custom' ? 'custom' : Number(scaleVal),
      periodCustomMonths: Number($('#periodCustomMonths').value || 12),
      periodStart: $('#periodStartScale').value
    };
  }
  function updatePeriodPreview() {
    const form = readPeriodForm();
    const box = $('#periodPreview');
    if (!form.periodStart) { box.textContent = '開始年月を選択してください'; return; }
    if (form.periodMode === 'manual' && !form.periodEnd) { box.textContent = '終了年月を選択してください'; return; }
    box.textContent = `集計期間：${periodLabel(getPeriod(form))}`;
  }
  function renderPeriodFields(s) {
    const mode = s.periodMode || 'scale';
    $$('.period-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#scaleFields').classList.toggle('hidden', mode !== 'scale');
    $('#manualFields').classList.toggle('hidden', mode !== 'manual');
    const scale = (s.periodScale == null) ? 12 : s.periodScale;
    $('#periodScale').value = String(scale);
    $('#periodCustomMonths').value = s.periodCustomMonths != null ? s.periodCustomMonths : 12;
    $('#customMonthsField').classList.toggle('hidden', String(scale) !== 'custom');
    const start = s.periodStart || defaultFiscalStart();
    $('#periodStartScale').value = start;
    $('#periodStartManual').value = start;
    $('#periodEndManual').value = s.periodEnd || ymAddMonths(start, 11);
    updatePeriodPreview();
  }
  async function savePeriodSettings() {
    const form = readPeriodForm();
    if (!form.periodStart) { toast('開始年月を選択してください'); return; }
    if (form.periodMode === 'manual' && !form.periodEnd) { toast('終了年月を選択してください'); return; }
    const p = getPeriod(form);
    await DB.setSetting('periodMode', form.periodMode);
    await DB.setSetting('periodStart', p.start);
    await DB.setSetting('periodEnd', p.end);
    if (form.periodMode === 'scale') {
      await DB.setSetting('periodScale', form.periodScale);
      await DB.setSetting('periodCustomMonths', form.periodCustomMonths);
    }
    toast('期間を保存しました');
    await refreshHeader();
    await renderList();
    renderPeriodFields(await DB.getAllSettings());
  }

  async function renderCatLists() {
    const render = async (type, ul) => {
      const cats = await DB.getCategories(type);
      ul.innerHTML = '';
      cats.forEach((c) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(c.name)}</span><button title="削除">✕</button>`;
        li.querySelector('button').addEventListener('click', async () => {
          if (!confirm(`カテゴリ「${c.name}」を削除しますか？（過去の取引は残ります）`)) return;
          await DB.deleteCategory(c.id);
          await renderCatLists();
          await refreshCategories();
        });
        ul.appendChild(li);
      });
    };
    await render('収入', $('#incomeCatList'));
    await render('支出', $('#expenseCatList'));
  }

  async function addCat(type, inputSel) {
    const input = $(inputSel);
    const name = input.value.trim();
    if (!name) return;
    await DB.addCategory(type, name, false);
    input.value = '';
    await renderCatLists();
    await refreshCategories();
    toast('カテゴリを追加しました');
  }

  // ---------- バックアップ ----------
  async function exportBackup() {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `チアフル会計バックアップ_${(data.settings.year || '').replace(/[\/\\:*?"<>|]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    await DB.setSetting('lastBackupDate', todayStr());
    toast('バックアップを書き出しました（共有Driveに保存もご検討ください）');
    if ($('#view-settings').classList.contains('active')) renderSettings();
  }

  async function importBackup(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('現在のデータを上書きして読み込みます。よろしいですか？')) { e.target.value = ''; return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await DB.importAll(data);
      state.settings = await DB.getAllSettings();
      await refreshCategories();
      await refreshHeader();
      await renderList();
      await renderSettings();
      toast('読み込みました');
    } catch (err) {
      console.error(err);
      toast('読み込みに失敗しました');
    }
    e.target.value = '';
  }

  async function resetData() {
    if (!confirm('本当に全データを削除しますか？元に戻せません。')) return;
    if (!confirm('最終確認：すべての取引・設定が消えます。よろしいですか？')) return;
    await DB.clearAll();
    await DB.init();
    state.settings = await DB.getAllSettings();
    await refreshCategories();
    await refreshHeader();
    await renderList();
    await renderSettings();
    toast('全データを削除しました');
  }

  // ---------- ユーティリティ ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
