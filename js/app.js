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
  // 期間の開始年から日本式年度ラベルを自動算出（例：2025-04開始 → 「2025年度」）
  function fiscalYearLabel(period) {
    const [y] = period.start.split('-').map(Number);
    return `${y}年度`;
  }

  let state = {
    type: '支出',          // 入力フォームの収入/支出
    editingId: null,       // 編集中の取引id
    pendingPhoto: null,    // 追加予定の写真Blob
    pendingPhotoUrl: null, // プレビューURL
    removePhoto: false,    // 編集時に既存写真を削除するか
    settings: {},
    objectUrls: [],        // 解放用
    listScope: 'period',   // 取引一覧の表示範囲: 'period' | 'all'
    listView: 'cards',     // 取引一覧の表示形式: 'cards' | 'table'
    feeTarget: null,
    bulkPayTarget: null,
    retireTarget: null,
    undoStack: []
  };
  const UNDO_LIMIT = 10;

  // ---------- 初期化 ----------
  async function boot() {
    await DB.init();
    state.settings = await DB.getAllSettings();
    await autoAdvancePeriodIfNeeded();
    bindNav();
    bindEntryForm();
    bindSettings();
    bindSummary();
    bindFee();
    bindList();
    $('#undoBtn').addEventListener('click', undoLast);
    updateUndoButton();
    $('#entryDate').value = defaultEntryDate();
    await updateEntryPeriodHint();
    await refreshCategories();
    await refreshHeader();
    await renderList();
    registerSW();
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 入力フォームの初期日付：今日が集計期間内なら今日、期間外なら期間末
  function defaultEntryDate() {
    const today = todayStr();
    const period = getPeriod(state.settings || {});
    if (inPeriod(today, period)) return today;
    // 期間外: 期間末の日付（または期間内の最後）
    const [py, pm] = period.end.split('-').map(Number);
    const lastDay = new Date(py, pm, 0).getDate();
    return `${period.end}-${String(lastDay).padStart(2, '0')}`;
  }

  // 起動時の自動期間更新：今日が現在の集計期間外で、年度(12ヶ月)スケールなら今期に自動切替
  async function autoAdvancePeriodIfNeeded() {
    const s = state.settings;
    if (!s) return;
    // 年度モード（スケール=12ヶ月、4月始まり）のときのみ自動切替する
    const isFiscalYearScale = (s.periodMode === 'scale') && (Number(s.periodScale) === 12);
    if (!isFiscalYearScale) return;
    // 今期の開始月（既存設定）の月が「4」でなければ年度モードと判断しない（4月始まり前提）
    if (!s.periodStart || s.periodStart.split('-')[1] !== '04') return;
    const period = getPeriod(s);
    const today = todayStr();
    if (inPeriod(today, period)) return; // 期間内ならそのまま
    // 今日を含む新年度に切替
    const now = new Date();
    const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const newStart = `${fy}-04`;
    const newEnd = `${fy + 1}-03`;
    if (s.periodStart === newStart) return;
    await DB.setSetting('periodStart', newStart);
    await DB.setSetting('periodEnd', newEnd);
    state.settings = await DB.getAllSettings();
    setTimeout(() => toast(`📅 新年度（${fy}年度）に自動切替しました`), 800);
  }

  async function updateEntryPeriodHint() {
    const s = await DB.getAllSettings();
    const period = getPeriod(s);
    const hint = $('#entryPeriodHint');
    if (!hint) return;
    const today = todayStr();
    const todayInPeriod = inPeriod(today, period);
    if (todayInPeriod) {
      hint.className = 'entry-period-hint';
      hint.innerHTML = `🗓 集計期間：<strong>${periodLabel(period)}</strong> ／ この期間内の日付の取引が集計に反映されます`;
    } else {
      hint.className = 'entry-period-hint warn';
      hint.innerHTML = `⚠️ 集計期間：<strong>${periodLabel(period)}</strong>（今日 ${today} は<strong>期間外</strong>です）<br>このまま登録すると集計に反映されません。日付を期間内に変更してください`;
    }
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
    const label = `${fiscalYearLabel(period)}（${periodLabel(period)}）`;
    $('#headerYear').textContent = label;
    const { balance } = await computeBalances();
    $('#headerBalance').textContent = yen(balance);
  }

  // ---------- カテゴリ ----------
  async function refreshCategories() {
    // 自動管理されるカテゴリは入力フォームから除外（収入「部費」と支出「ユニフォーム積立金」）
    // 「部費」は部費タブのグリッドで、「ユニフォーム積立金」は集金済月数×単価で自動計上
    const HIDDEN_INCOME = new Set(['部費']);
    const HIDDEN_EXPENSE = new Set(['ユニフォーム積立金']);
    const cats = (await DB.getCategories(state.type)).filter((c) => {
      if (state.type === '収入' && HIDDEN_INCOME.has(c.name)) return false;
      if (state.type === '支出' && HIDDEN_EXPENSE.has(c.name)) return false;
      return true;
    });
    const sel = $('#entryCategory');
    sel.innerHTML = '';
    cats.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.name; o.textContent = c.name;
      sel.appendChild(o);
    });
    // 編集時に隠しカテゴリの取引を編集できるよう、現在の選択値が無ければ追加
    if (state.editingCategory && !cats.some((c) => c.name === state.editingCategory)) {
      const o = document.createElement('option');
      o.value = state.editingCategory;
      o.textContent = `${state.editingCategory}（自動管理）`;
      sel.appendChild(o);
      sel.value = state.editingCategory;
    }
  }

  // ---------- 入力フォーム ----------
  function bindEntryForm() {
    $('#segExpense').addEventListener('click', () => setType('支出'));
    $('#segIncome').addEventListener('click', () => setType('収入'));

    const onPhotoChange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (state.pendingPhotoUrl) URL.revokeObjectURL(state.pendingPhotoUrl);
      state.pendingPhoto = file;
      state.removePhoto = false;
      state.pendingPhotoUrl = URL.createObjectURL(file);
      $('#photoPreviewImg').src = state.pendingPhotoUrl;
      $('#photoPreview').classList.remove('hidden');
    };
    $('#entryPhoto').addEventListener('change', onPhotoChange);
    $('#entryPhotoAlbum').addEventListener('change', onPhotoChange);
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
    $('#entryPhotoAlbum').value = '';
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

    const label = state.editingId ? '取引の更新' : '取引の追加';
    await pushUndoSnapshot(label);
    if (state.editingId) {
      data.id = state.editingId;
      await DB.updateTransaction(data);
    } else {
      await DB.addTransaction(data);
    }
    // 期間外なら警告つきトースト
    const period = getPeriod(state.settings);
    if (!inPeriod(data.date, period)) {
      toastUndo(`⚠️ 保存しました（${data.date}は指定期間外のため集計には反映されません。一覧の「全期間」で確認可能）`);
    } else {
      toastUndo(state.editingId ? '取引を更新しました' : '取引を追加しました');
    }
    resetEntryForm();
    await refreshHeader();
    await renderList();
  }

  function resetEntryForm() {
    state.editingId = null;
    state.editingCategory = null;
    $('#entryId').value = '';
    $('#entryForm').reset();
    $('#entryDate').value = defaultEntryDate();
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
    state.editingCategory = t.category;
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
      if (t.type === '収入') {
        if (t.category === '部費') return; // 部費はグリッド管理（手動入力は二重計上回避のため無視）
        incomeSum += t.amount;
      } else {
        if (t.category === 'ユニフォーム積立金') return; // 自動計算するため手動分は無視
        expenseSum += t.amount;
      }
    });
    const fee = await computeFeeTotals();
    // ユニフォーム積立金（部費からの自動積立）
    const unifondPer = Number(settings.unifondPerMonth || 0);
    const autoUnifond = unifondPer * fee.done1Count;
    const incomeTotal = carryover + incomeSum + fee.done;
    const expenseTotal = expenseSum + autoUnifond;
    const balance = incomeTotal - expenseTotal;
    return { carryover, incomeSum, expenseSum: expenseTotal, incomeTotal, expenseTotal, balance, txs, allCount: allTxs.length, period, feeDone: fee.done, autoUnifond };
  }

  // ---------- 取引一覧 ----------
  // 部費納付イベント（feeCellsをpaidDate単位にまとめた仮想取引）
  // periodFilter を渡すと、各イベントを期間内月のみに切り詰める
  // （期間内月が0なら除外、部分的に重なる場合は金額・月リスト・説明文を期間内分のみに）
  async function buildFeeEvents(periodFilter) {
    const members = await DB.getMembers();
    const cells = await DB.getFeeCells();
    const settings = await DB.getAllSettings();
    const currentFee = Number(settings.monthlyFee || 1000);
    const memberMap = {};
    members.forEach((m) => { memberMap[m.id] = m.name; });
    const cellFee = (c) => (c && c.feeAtSet) ? c.feeAtSet : currentFee;
    // key: memberId + '|' + paidDate → { yms:[], cellByYm:{} }
    const grouped = {};
    cells.forEach((c) => {
      if (c.status !== 'done1') return;
      const [mid, ym] = c.key.split('|');
      if (!memberMap[mid]) return;
      const dateKey = c.paidDate || '0000-00-00';
      const k = `${mid}|${dateKey}`;
      const g = grouped[k] || (grouped[k] = { yms: [], cellByYm: {} });
      g.yms.push(ym);
      g.cellByYm[ym] = c;
    });
    const events = [];
    for (const [k, g] of Object.entries(grouped)) {
      const [mid, dateKey] = k.split('|');
      g.yms.sort();
      const known = dateKey !== '0000-00-00';
      let effectiveYms = g.yms;
      let truncated = false;
      if (periodFilter) {
        effectiveYms = g.yms.filter((ym) => ym >= periodFilter.start && ym <= periodFilter.end);
        if (effectiveYms.length === 0) continue;
        truncated = effectiveYms.length !== g.yms.length;
      }
      // 各セルの個別単価で集計（feeAtSet優先）
      const amount = effectiveYms.reduce((sum, ym) => sum + cellFee(g.cellByYm[ym]), 0);
      let desc = formatFeeMonths(memberMap[mid], effectiveYms);
      if (!known) desc += '（納付日未記録）';
      if (truncated) desc += ' ※指定期間内分のみ';
      events.push({
        date: dateKey, type: '収入', category: '部費', amount, desc,
        source: 'fee', memberId: mid, ymList: effectiveYms, known
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
    // 自動管理カテゴリの手動取引は除外（集計と一覧の残高を整合させるため）
    const txs = allTxs.filter((t) => !(
      (t.type === '収入' && t.category === '部費') ||
      (t.type === '支出' && t.category === 'ユニフォーム積立金')
    ));
    // 指定期間モード: 期間で切り詰めた部費イベント／全期間モード: そのまま
    const feeEvents = await buildFeeEvents(scope === 'period' ? period : null);
    const allFeeEvents = scope === 'period' ? await buildFeeEvents() : feeEvents;
    let items = [
      ...txs.map((t) => ({ ...t, source: 'tx' })),
      ...feeEvents
    ];
    const totalAll = txs.length + allFeeEvents.length;
    if (scope === 'period') {
      items = items.filter((it) => {
        if (it.source === 'tx') return inPeriod(it.date, period);
        return true; // 部費イベントは buildFeeEvents で既に期間絞り込み済み
      });
      // ユニフォーム積立金（自動）を期間末に追加
      const feeT = await computeFeeTotals();
      const unifondPer = Number(settings.unifondPerMonth || 0);
      if (unifondPer > 0 && feeT.done1Count > 0) {
        const [py, pm] = period.end.split('-').map(Number);
        const lastDay = new Date(py, pm, 0).getDate();
        items.push({
          date: `${period.end}-${String(lastDay).padStart(2, '0')}`,
          type: '支出', category: 'ユニフォーム積立金',
          desc: `${unifondPer}円×${feeT.done1Count}ヶ月（部費から自動積立）`,
          amount: unifondPer * feeT.done1Count, source: 'auto'
        });
      }
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
        ? '指定期間内の取引はありません。「全期間」に切替えるか期間を変えてください。'
        : 'まだ取引がありません。「入力」または「部費」から追加してください。';
      empty.classList.remove('hidden');
      return;
    }
    $('#txEmpty').classList.add('hidden');

    if (state.listView === 'table') { renderListTable(list, withBalance); return; }

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

  function renderListTable(container, withBalance) {
    const rows = withBalance.map((t) => {
      const dateLabel = t.date === '0000-00-00' ? '未記録' : t.date;
      const sign = t.type === '収入' ? '+' : '−';
      const cls = t.source === 'fee' ? 'fee' : (t.source === 'auto' ? 'auto' : '');
      const delBtn = t.source === 'auto'
        ? `<button class="row-del" disabled title="自動計上（設定で変更）">⚙</button>`
        : `<button class="row-del" data-src="${t.source}" data-id="${t.id || ''}" data-mem="${t.memberId || ''}" data-yms="${(t.ymList || []).join(',')}" title="削除">🗑</button>`;
      return `<tr class="${cls}">
        <td>${esc(dateLabel)}</td>
        <td class="type-${t.type}">${t.type}</td>
        <td>${esc(t.category)}</td>
        <td>${esc(t.desc || '')}</td>
        <td class="amt type-${t.type}">${sign}${yen(t.amount)}</td>
        <td class="bal">${yen(t.runningBalance)}</td>
        <td>${delBtn}</td>
      </tr>`;
    }).join('');
    container.innerHTML = `<div class="tx-table-wrap"><table class="tx-table">
      <thead><tr><th>日付</th><th>種別</th><th>カテゴリ</th><th>内容</th><th>金額</th><th>残高</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
    container.querySelectorAll('.row-del').forEach((btn) => {
      btn.addEventListener('click', () => onTableRowDelete(btn));
    });
  }

  async function onTableRowDelete(btn) {
    const src = btn.dataset.src;
    if (src === 'tx') {
      const id = parseInt(btn.dataset.id, 10);
      const t = await DB.getTransaction(id);
      if (!t) return;
      if (!confirm(`「${t.desc || t.category}」を削除しますか？`)) return;
      await pushUndoSnapshot('取引の削除');
      await DB.deleteTransaction(id);
      toastUndo('削除しました');
      await refreshHeader();
      await renderList();
    } else if (src === 'fee') {
      const mem = btn.dataset.mem;
      const yms = (btn.dataset.yms || '').split(',').filter(Boolean);
      if (yms.length === 0) return;
      if (!confirm(`この部費納付（${yms.length}ヶ月分）を取り消します。\n該当月は「参加・未集金」に戻ります。\n（退部させる場合はメンバー行の「退部」ボタンをお使いください）`)) return;
      await pushUndoSnapshot('部費イベントの取消');
      for (const ym of yms) await DB.setFeeCell(`${mem}|${ym}`, 'plan1');
      toastUndo(`${yms.length}ヶ月を未集金に戻しました`);
      await refreshHeader();
      await renderList();
    }
  }

  async function onDelete(id, desc) {
    if (!confirm(`「${desc || 'この取引'}」を削除しますか？`)) return;
    await pushUndoSnapshot('取引の削除');
    await DB.deleteTransaction(id);
    toastUndo('削除しました');
    await refreshHeader();
    await renderList();
  }

  async function showPhoto(photoId) {
    const blob = await DB.getPhoto(photoId);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    $('#imgModalImg').src = url;
    openModalEl('imgModal');
  }
  $('#imgModal').addEventListener('click', () => closeModalEl('imgModal'));

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
        // 自動管理されるカテゴリは集約から除外（後で上書き）
        if (type === '収入' && t.category === '部費') return;
        if (type === '支出' && t.category === 'ユニフォーム積立金') return;
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

    // ユニフォーム積立金：集金済月数 × 単価 を自動で支出計上
    const unifondPer = Number(settings.unifondPerMonth || 0);
    if (unifondPer > 0 && fee.done1Count > 0) {
      if (!expMap['ユニフォーム積立金']) expMap['ユニフォーム積立金'] = { cat: 'ユニフォーム積立金', amount: 0, details: [] };
      expMap['ユニフォーム積立金'].amount = unifondPer * fee.done1Count;
      expMap['ユニフォーム積立金'].details = [`${unifondPer.toLocaleString('ja-JP')}円×${fee.done1Count}ヶ月（部費から積立）`];
    }

    const orderedInc = ['前年度繰越金', ...incomeCats.filter((c) => c !== '前年度繰越金'),
      ...Object.keys(incMap).filter((c) => c !== '前年度繰越金' && !incomeCats.includes(c))];
    const orderedExp = [...expenseCats, ...Object.keys(expMap).filter((c) => !expenseCats.includes(c))];

    const incomeRows = orderedInc.map((c) => ({ cat: c, amount: incMap[c].amount, detail: incMap[c].details.join('\n') }));
    const expenseRows = orderedExp.map((c) => ({ cat: c, amount: expMap[c].amount, detail: expMap[c].details.join('\n') }));

    const incomeTotal = incomeRows.reduce((s, r) => s + r.amount, 0);
    const expenseTotal = expenseRows.reduce((s, r) => s + r.amount, 0);

    // 全取引リスト（古い順・残高付き）※部費イベントは期間内分のみに切り詰め
    // 自動管理カテゴリ（収入「部費」/支出「ユニフォーム積立金」）の手動取引は集計と整合させるため除外
    const txsForList = txs.filter((t) => !(
      (t.type === '収入' && t.category === '部費') ||
      (t.type === '支出' && t.category === 'ユニフォーム積立金')
    ));
    const feeEvents = await buildFeeEvents(period);
    const itemsAll = [
      ...txsForList.map((t) => ({ date: t.date, type: t.type, category: t.category, desc: t.desc || '', amount: t.amount, source: 'tx', id: t.id })),
      ...feeEvents.map((e) => ({ date: e.date, type: e.type, category: e.category, desc: e.desc, amount: e.amount, source: 'fee', memberId: e.memberId, ymList: e.ymList }))
    ];
    if (unifondPer > 0 && fee.done1Count > 0) {
      const [py, pm] = period.end.split('-').map(Number);
      const lastDay = new Date(py, pm, 0).getDate();
      itemsAll.push({
        date: `${period.end}-${String(lastDay).padStart(2, '0')}`,
        type: '支出', category: 'ユニフォーム積立金',
        desc: `${unifondPer}円×${fee.done1Count}ヶ月（部費から自動積立）`,
        amount: unifondPer * fee.done1Count, source: 'auto'
      });
    }
    itemsAll.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    let run = carryover;
    const allItems = itemsAll.map((it) => {
      run += (it.type === '収入' ? it.amount : -it.amount);
      return { ...it, runningBalance: run };
    });

    return { year: fiscalYearLabel(period), periodText: periodLabel(period), carryover, incomeRows, expenseRows, incomeTotal, expenseTotal, balance: incomeTotal - expenseTotal, allItems };
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
    $('#openReport').addEventListener('click', async () => { await renderReport(); openModalEl('reportModal'); });
    $('#reportClose').addEventListener('click', () => closeModalEl('reportModal'));
    $('#reportPrint').addEventListener('click', () => window.print());
  }

  // ---------- 会計報告プレビュー（多ページ） ----------
  async function renderReport() {
    const agg = await aggregate();
    const settings = await DB.getAllSettings();
    const period = getPeriod(settings);
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

    // --- 納付履歴（時系列・指定期間内のみ） ---
    const events = (await buildFeeEvents(period)).sort((a, b) => a.date < b.date ? -1 : 1);
    const eventListHtml = events.length === 0
      ? '<p>（納付履歴はまだありません）</p>'
      : `<table class="report-event-list">
          <thead><tr><th>納付日</th><th>内容</th><th class="amt">金額</th></tr></thead>
          <tbody>
          ${events.map((e) => `<tr><td>${e.known ? e.date : '日付未記録'}</td><td>${esc(e.desc)}</td><td class="amt">${yf(e.amount)}</td></tr>`).join('')}
          <tr class="tot"><td colspan="2">納付合計</td><td class="amt">${yf(events.reduce((s, e) => s + e.amount, 0))}</td></tr>
          </tbody>
        </table>`;

    // --- 全取引一覧（古い順・残高付き）---
    const txListHtml = (agg.allItems && agg.allItems.length > 0)
      ? `<table class="report-tx-list">
          <thead>
            <tr><th class="tx-list-caption" colspan="6">全取引一覧（前ページからの続き／古い順・残高付き）</th></tr>
            <tr><th>日付</th><th>種別</th><th>カテゴリ</th><th>内容</th><th class="amt">金額</th><th class="amt">残高</th></tr>
          </thead>
          <tbody>
          ${agg.allItems.map((it) => {
            const sign = it.type === '収入' ? '+' : '−';
            const rowCls = it.source === 'fee' ? 'fee' : (it.source === 'auto' ? 'auto' : '');
            return `<tr class="${rowCls}">
              <td>${esc(it.date || '')}</td>
              <td>${it.type}</td>
              <td>${esc(it.category)}</td>
              <td>${esc(it.desc || '')}</td>
              <td class="amt">${sign}${yf(it.amount)}</td>
              <td class="amt">${yf(it.runningBalance)}</td>
            </tr>`;
          }).join('')}
          <tr class="tot"><td colspan="5">期末残高</td><td class="amt">${yf(agg.balance)}</td></tr>
          </tbody>
        </table>`
      : '<p>（取引はまだありません）</p>';

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
          <li>全取引一覧（古い順・残高付き）</li>
          <li>監査確認</li>
        </ol>
      </div>

      <!-- 1. 収支報告 -->
      <div class="report-page">
        <h2 class="page-title">1. 収支報告</h2>
        <div class="page-sub">期間：${esc(agg.periodText)}</div>
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

      <!-- 4. 全取引一覧（複数ページOK） -->
      <div class="report-page tx-page">
        <h2 class="page-title">4. 全取引一覧（古い順・残高付き）</h2>
        ${txListHtml}
      </div>

      <!-- 5. 監査確認 -->
      <div class="report-page">
        <h2 class="page-title">5. 監査確認</h2>
        <p>本会計報告書の内容を確認しました。</p>
        <div class="audit-block">
          <div class="audit-row-big">
            <div class="audit-label-big">会計担当者　自署</div>
            <div class="audit-sign-box"></div>
            <div class="audit-date-line">日付：　　　　　年　　　月　　　日</div>
          </div>
          <div class="audit-row-big">
            <div class="audit-label-big">監査者①　自署</div>
            <div class="audit-sign-box"></div>
            <div class="audit-date-line">日付：　　　　　年　　　月　　　日</div>
          </div>
          <div class="audit-row-big">
            <div class="audit-label-big">監査者②　自署</div>
            <div class="audit-sign-box"></div>
            <div class="audit-date-line">日付：　　　　　年　　　月　　　日</div>
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
    const currentFee = Number(settings.monthlyFee || 1000);
    const period = getPeriod(settings);
    const months = monthsInPeriod(period);
    const members = await DB.getMembers();
    const cellMap = await DB.getFeeCellMap();
    // セル単価: 保存時のfeeAtSetを優先（過去レート保護）。無ければ現在値
    const cellFee = (cell) => (cell && cell.feeAtSet) ? cell.feeAtSet : currentFee;
    let done = 0, plan = 0, done1Count = 0, plan1Count = 0;
    const memberSub = {};
    members.forEach((m) => {
      let sd = 0, sp = 0;
      months.forEach((ym) => {
        const cell = cellMap[`${m.id}|${ym}`];
        const st = cell && cell.status;
        if (st !== 'done1' && st !== 'plan1') return;
        const a = cellFee(cell);
        sp += a;
        if (st === 'done1') { sd += a; done1Count++; } else { plan1Count++; }
      });
      memberSub[m.id] = { done: sd, plan: sp };
      done += sd; plan += sp;
    });
    return { fee: currentFee, period, months, members, cellMap, done, plan, unpaid: plan - done,
      memberSub, done1Count, plan1Count };
  }

  function feeCellInner(st, fee, paidDate) {
    if (st === 'done1') {
      let dateFull = '';
      if (paidDate) {
        const [y, m, d] = paidDate.split('-').map(Number);
        dateFull = `${y}/${m}/${d}`;
      }
      return `<span class="fee-mark done">●</span><span class="fee-amt">${fee.toLocaleString('ja-JP')}</span>${dateFull ? `<span class="fee-date">${dateFull}</span>` : ''}`;
    }
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
        const pd = cell && cell.paidDate;
        const cf = (cell && cell.feeAtSet) ? cell.feeAtSet : t.fee;
        cells += `<td><div class="fee-cell" data-member="${m.id}" data-ym="${ym}">${feeCellInner(st, cf, pd)}</div></td>`;
      });
      html += `<tr><td class="name-col">${esc(m.name)}<button class="bulk-pay-btn" data-member="${m.id}" title="まとめて納付">💰</button></td>${cells}<td class="sub-col">${yen(t.memberSub[m.id].done)}</td></tr>`;
    });
    html += `<tr class="fee-total"><td class="name-col">合計</td><td colspan="${t.months.length}">済 ${yen(t.done)} ／ 予定 ${yen(t.plan)}</td><td class="sub-col">${yen(t.done)}</td></tr>`;
    html += `</table>`;
    return html;
  }

  async function renderFee() {
    const t = await computeFeeTotals();
    const settings = await DB.getAllSettings();
    const unifondPer = Number(settings.unifondPerMonth || 0);
    const unifondNote = unifondPer > 0 ? `／うちユニフォーム積立 ${yen(unifondPer)}` : '';
    $('#feePeriod').textContent = `期間：${periodLabel(t.period)}（${t.months.length}ヶ月）　月会費 ${yen(t.fee)}${unifondNote}`;

    const ul = $('#memberList');
    ul.innerHTML = '';
    t.members.forEach((m) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${esc(m.name)}</span><button class="retire-btn" data-id="${m.id}" title="退部処理">退部</button><button data-act="delMember" title="完全削除">✕</button>`;
      li.querySelector('.retire-btn').addEventListener('click', () => openRetireSheet(m.id, m.name));
      li.querySelector('[data-act="delMember"]').addEventListener('click', async () => {
        if (!confirm(`メンバー「${m.name}」を完全削除しますか？\n（退部処理ではなく、この人の記録を全て消します。年度途中の退部は「退部」ボタンを使ってください）`)) return;
        await pushUndoSnapshot(`メンバー完全削除（${m.name}）`);
        await DB.deleteMember(m.id);
        await renderFee();
        await refreshHeader();
        toastUndo('メンバーを完全削除しました');
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

  async function openFeeSheet(memberId, ym, name) {
    state.feeTarget = { memberId, ym };
    $('#feeSheetTitle').textContent = `${name || ''}　${Number(ym.split('-')[1])}月分`;
    // 既存セルの納付日を読み込み（無ければ今日）
    const cellMap = await DB.getFeeCellMap();
    const existing = cellMap[`${memberId}|${ym}`];
    const existingDate = existing && existing.paidDate;
    $('#feeCellDate').value = existingDate || todayStr();
    $('#feeSheet').classList.remove('hidden');
  }
  function closeFeeSheet() { $('#feeSheet').classList.add('hidden'); state.feeTarget = null; }

  // ---------- まとめて納付 ----------
  async function populateBulkPayMemberSelect(selectedId) {
    const members = await DB.getMembers();
    const sel = $('#bulkPayMember');
    sel.innerHTML = '';
    members.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.name;
      sel.appendChild(o);
    });
    if (selectedId != null) sel.value = String(selectedId);
  }
  async function openBulkPaySheet(memberId, name) {
    const settings = await DB.getAllSettings();
    const period = getPeriod(settings);
    state.bulkPayTarget = { memberId, name, fromRow: true };
    await populateBulkPayMemberSelect(memberId);
    $('#bulkPayMemberField').classList.add('hidden');  // 行から開いた時はメンバー固定
    $('#bulkPayTitle').textContent = `${name}さん：まとめて納付`;
    $('#bulkPayStart').value = period.start;
    $('#bulkPayEnd').value = period.end;
    $('#bulkPayDate').value = todayStr();
    updateBulkPayAmount();
    $('#bulkPaySheet').classList.remove('hidden');
  }
  async function openBulkAll() {
    const settings = await DB.getAllSettings();
    const period = getPeriod(settings);
    const members = await DB.getMembers();
    if (members.length === 0) { toast('まずメンバーを追加してください'); return; }
    state.bulkPayTarget = { memberId: null, name: '', fromRow: false };
    await populateBulkPayMemberSelect(members[0].id);
    $('#bulkPayMemberField').classList.remove('hidden');  // メンバー選択を表示
    $('#bulkPayTitle').textContent = '一括入力（複数月をまとめて集金済に）';
    $('#bulkPayStart').value = period.start;
    $('#bulkPayEnd').value = period.end;
    $('#bulkPayDate').value = todayStr();
    updateBulkPayAmount();
    $('#bulkPaySheet').classList.remove('hidden');
  }
  function closeBulkPaySheet() { $('#bulkPaySheet').classList.add('hidden'); state.bulkPayTarget = null; }

  // ---------- 退部処理 ----------
  async function openRetireSheet(memberId, name) {
    state.retireTarget = { memberId, name };
    const settings = await DB.getAllSettings();
    const period = getPeriod(settings);
    $('#retireTitle').textContent = `${name}さん：退部処理`;
    $('#retireMonth').value = period.end;
    await updateRetirePreview();
    $('#retireSheet').classList.remove('hidden');
  }
  function closeRetireSheet() { $('#retireSheet').classList.add('hidden'); state.retireTarget = null; }

  async function updateRetirePreview() {
    const t = state.retireTarget;
    if (!t) return;
    const ym = $('#retireMonth').value;
    if (!ym) { $('#retirePreview').textContent = '退部年月を選択してください'; return; }
    const cells = await DB.getFeeCells();
    const affected = cells.filter((c) => c.key.startsWith(t.memberId + '|') && c.key.split('|')[1] >= ym);
    const doneCells = affected.filter((c) => c.status === 'done1');
    const settings = await DB.getAllSettings();
    const curFee = Number(settings.monthlyFee || 1000);
    // 各セルのfeeAtSetを優先（過去レート保護）
    const refund = doneCells.reduce((sum, c) => sum + (c.feeAtSet || curFee), 0);
    $('#retirePreview').innerHTML = `${ym}以降の影響：<strong>${affected.length}ヶ月</strong>を対象外に変更<br>うち集金済 <strong>${doneCells.length}ヶ月</strong>（返金額 <strong>${yen(refund)}</strong>）`;
  }

  async function confirmRetire() {
    const t = state.retireTarget;
    if (!t) return;
    const ym = $('#retireMonth').value;
    if (!ym) { toast('退部年月を選んでください'); return; }
    const cells = await DB.getFeeCells();
    const affected = cells.filter((c) => c.key.startsWith(t.memberId + '|') && c.key.split('|')[1] >= ym);
    if (affected.length === 0) {
      if (!confirm('対象月のセルがありません。それでも退部処理を実行しますか？（記録は変わりません）')) return;
    }
    const doneCells = affected.filter((c) => c.status === 'done1');
    const settings = await DB.getAllSettings();
    const curFee = Number(settings.monthlyFee || 1000);
    const refund = doneCells.reduce((sum, c) => sum + (c.feeAtSet || curFee), 0);
    const doneCount = doneCells.length;
    let recordRefund = false;
    if (refund > 0) {
      recordRefund = confirm(`集金済 ${doneCount}ヶ月分（${yen(refund)}）を「部費返金」支出として自動記録しますか？\nOK：自動記録 ／ キャンセル：手動で別途入力`);
    }
    await pushUndoSnapshot(`退部処理（${t.name}）`);
    for (const c of affected) await DB.setFeeCell(c.key, '');
    if (recordRefund && refund > 0) {
      const ymList = affected.map((c) => c.key.split('|')[1]).sort();
      const startM = Number(ymList[0].split('-')[1]);
      const endM = Number(ymList[ymList.length - 1].split('-')[1]);
      // 返金日は退部月の1日。ただし集計期間外なら期間末に丸める（集計に確実に反映）
      const period = getPeriod(settings);
      let refundDate = `${ym}-01`;
      if (refundDate.slice(0, 7) > period.end) {
        const [py, pm] = period.end.split('-').map(Number);
        const lastDay = new Date(py, pm, 0).getDate();
        refundDate = `${period.end}-${String(lastDay).padStart(2, '0')}`;
      } else if (refundDate.slice(0, 7) < period.start) {
        refundDate = `${period.start}-01`;
      }
      await DB.addTransaction({
        date: refundDate,
        type: '支出', category: '部費返金',
        amount: refund,
        desc: `${t.name}さん退部：部費返金（${startM}月〜${endM}月分）`,
        note: ''
      });
    }
    closeRetireSheet();
    await renderFee();
    await refreshHeader();
    toastUndo(`${t.name}さんを退部処理しました${recordRefund ? '（返金も自動記録）' : ''}`);
  }

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
    // 一括入力モード（fromRow=false）ではドロップダウンの選択値を採用
    const memberId = t.fromRow ? t.memberId : $('#bulkPayMember').value;
    if (!memberId) { toast('メンバーを選択してください'); return; }
    const start = $('#bulkPayStart').value;
    const end = $('#bulkPayEnd').value;
    const paidDate = $('#bulkPayDate').value || todayStr();
    if (!start || !end || start > end) { toast('期間を正しく指定してください'); return; }
    const months = monthsInPeriod({ start, end });
    // 集計期間外の月が混ざる場合は警告
    const settings = await DB.getAllSettings();
    const aggPeriod = getPeriod(settings);
    const outside = months.filter((ym) => ym < aggPeriod.start || ym > aggPeriod.end);
    if (outside.length > 0) {
      if (!confirm(`指定期間（${periodLabel(aggPeriod)}）の外の月が${outside.length}ヶ月含まれます。\n外の月（${outside[0]}〜${outside[outside.length-1]}）は今の集計には反映されません。\n続行しますか？`)) return;
    }
    await pushUndoSnapshot(`まとめて納付（${months.length}ヶ月）`);
    for (const ym of months) {
      await DB.setFeeCell(`${memberId}|${ym}`, 'done1', paidDate);
    }
    closeBulkPaySheet();
    await renderFee();
    await refreshHeader();
    toastUndo(`${months.length}ヶ月分を集金済として登録しました`);
  }

  async function addMemberHandler() {
    const name = $('#newMember').value.trim();
    if (!name) return;
    await pushUndoSnapshot(`メンバー追加（${name}）`);
    const id = await DB.addMember(name);
    const months = monthsInPeriod(getPeriod(await DB.getAllSettings()));
    for (const ym of months) await DB.setFeeCell(`${id}|${ym}`, 'plan1');
    $('#newMember').value = '';
    await renderFee();
    await refreshHeader();
    toastUndo('メンバーを追加しました');
  }

  function bindList() {
    $$('.list-scope').forEach((b) => b.addEventListener('click', () => {
      $$('.list-scope').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.listScope = b.dataset.scope;
      renderList();
    }));
    $('#toggleListView').addEventListener('click', () => {
      state.listView = state.listView === 'table' ? 'cards' : 'table';
      $('#toggleListView').textContent = state.listView === 'table' ? '📋 カード' : '📊 表';
      $('#toggleListView').classList.toggle('on', state.listView === 'table');
      renderList();
    });
    $('#openGallery').addEventListener('click', async () => {
      await renderGallery();
      openModalEl('galleryModal');
    });
    $('#galleryClose').addEventListener('click', () => closeModalEl('galleryModal'));
    $('#galleryModal').addEventListener('click', (e) => { if (e.target.id === 'galleryModal') closeModalEl('galleryModal'); });
  }

  async function renderGallery() {
    const txs = await DB.getAllTransactions();
    const withPhoto = txs.filter((t) => t.photoId).sort((a, b) => b.date < a.date ? -1 : b.date > a.date ? 1 : 0);
    const grid = $('#galleryGrid');
    if (withPhoto.length === 0) {
      grid.innerHTML = '<p class="empty-msg">領収書写真はまだありません。入力時に「📷 カメラで撮影」から保存できます。</p>';
      return;
    }
    const items = [];
    for (const t of withPhoto) {
      const blob = await DB.getPhoto(t.photoId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      state.objectUrls.push(url);
      items.push(`<div class="gallery-item" data-id="${t.id}">
        <img src="${url}" alt="" />
        <div class="meta">
          <div>${t.date}</div>
          <div class="desc">${esc(t.desc || t.category)}</div>
          <div class="amt ${t.type === '収入' ? 'income' : ''}">${t.type === '収入' ? '+' : '−'}${yen(t.amount)}</div>
        </div>
      </div>`);
    }
    grid.innerHTML = items.join('');
    grid.querySelectorAll('.gallery-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id, 10);
        const tx = withPhoto.find((t) => t.id === id);
        if (tx && tx.photoId) showPhoto(tx.photoId);
      });
    });
  }

  function bindFee() {
    $('#addMember').addEventListener('click', addMemberHandler);
    $('#newMember').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMemberHandler(); } });
    $('#feeSheet').addEventListener('click', (e) => { if (e.target.id === 'feeSheet') closeFeeSheet(); });
    // まとめて納付
    $('#bulkPaySheet').addEventListener('click', (e) => { if (e.target.id === 'bulkPaySheet') closeBulkPaySheet(); });
    $('#bulkPayCancel').addEventListener('click', closeBulkPaySheet);
    $('#bulkPayConfirm').addEventListener('click', confirmBulkPay);
    // 月/日付ピッカーは change のみ（ピッカー回転中の連続発火を避けスクロール鈍化を防止）
    ['#bulkPayStart', '#bulkPayEnd', '#bulkPayDate'].forEach((sel) => $(sel).addEventListener('change', updateBulkPayAmount));
    // 退部処理
    $('#retireSheet').addEventListener('click', (e) => { if (e.target.id === 'retireSheet') closeRetireSheet(); });
    $('#retireCancel').addEventListener('click', closeRetireSheet);
    $('#retireConfirm').addEventListener('click', confirmRetire);
    $('#retireMonth').addEventListener('change', updateRetirePreview);
    // トップの一括入力
    $('#openBulkAll').addEventListener('click', openBulkAll);
    $$('#feeSheet .sheet-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const status = btn.dataset.status;
      if (status === 'cancel') { closeFeeSheet(); return; }
      if (state.feeTarget) {
        await pushUndoSnapshot('部費セル変更');
        // 「集金済」の時のみ納付日を記録（入力欄の値、無効なら今日）
        const paidDate = status === 'done1' ? ($('#feeCellDate').value || todayStr()) : null;
        await DB.setFeeCell(`${state.feeTarget.memberId}|${state.feeTarget.ym}`, status, paidDate);
        closeFeeSheet();
        await renderFee();
        await refreshHeader();
        toastUndo('部費セルを更新しました');
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
      await DB.setSetting('unifondPerMonth', parseInt($('#setUnifond').value, 10) || 0);
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
    // 数値は input（即時反映）、月ピッカーは change（確定時のみ）
    // input にすると iOS のホイールピッカー回転中に大量発火してスクロールが鈍る
    $('#periodCustomMonths').addEventListener('input', updatePeriodPreview);
    ['#periodStartScale', '#periodStartManual', '#periodEndManual'].forEach((sel) => {
      $(sel).addEventListener('change', updatePeriodPreview);
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
    $('#setUnifond').value = s.unifondPerMonth != null ? s.unifondPerMonth : 300;
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
    state.settings = await DB.getAllSettings();
    await refreshHeader();
    await renderList();
    await updateEntryPeriodHint();
    renderPeriodFields(state.settings);
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
    if (!confirm('現在のデータを上書きして読み込みます。よろしいですか？\n（直後なら⮌「元に戻す」で復元できます）')) { e.target.value = ''; return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await pushUndoSnapshot('バックアップ読み込み');
      await DB.importAll(data);
      await DB.init(); // 既定値マイグレーション再実行（古いバックアップ救済）
      state.settings = await DB.getAllSettings();
      await refreshCategories();
      await refreshHeader();
      await renderList();
      await renderSettings();
      toastUndo('読み込みました');
    } catch (err) {
      console.error(err);
      toast('読み込みに失敗しました');
    }
    e.target.value = '';
  }

  async function resetData() {
    if (!confirm('本当に全データを削除しますか？\n（直後なら⮌の「元に戻す」で復元可能ですが、ブラウザを閉じると確実に戻せません）')) return;
    if (!confirm('最終確認：すべての取引・設定が消えます。よろしいですか？')) return;
    await pushUndoSnapshot('全データ削除');
    await DB.clearAll();
    await DB.init();
    state.settings = await DB.getAllSettings();
    await refreshCategories();
    await refreshHeader();
    await renderList();
    await renderSettings();
    toastUndo('全データを削除しました');
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
    t.innerHTML = `<span>${esc(msg)}</span>`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }
  function toastUndo(msg) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span><button class="toast-undo" id="toastUndoBtn">⮌ 戻す</button>`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
    $('#toastUndoBtn').addEventListener('click', async () => {
      clearTimeout(toastTimer); t.classList.add('hidden');
      await undoLast();
    });
  }

  // ---------- Undo ----------
  async function pushUndoSnapshot(label) {
    try {
      const snap = await DB.snapshot();
      state.undoStack.push({ snap, label, at: Date.now() });
      if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
      updateUndoButton();
    } catch (e) { console.warn('snapshot失敗', e); }
  }
  function updateUndoButton() {
    const btn = $('#undoBtn');
    if (!btn) return;
    btn.disabled = state.undoStack.length === 0;
    btn.title = state.undoStack.length === 0 ? '元に戻す（履歴なし）' : `元に戻す（履歴${state.undoStack.length}件、最後: ${state.undoStack[state.undoStack.length - 1].label}）`;
  }
  async function undoLast() {
    if (state.undoStack.length === 0) { toast('元に戻せる操作がありません'); return; }
    const last = state.undoStack.pop();
    await DB.restoreSnapshot(last.snap);
    state.settings = await DB.getAllSettings();
    await refreshCategories();
    await refreshHeader();
    // 現在のビューを再描画
    const active = document.querySelector('.view.active');
    const v = active ? active.id.replace('view-', '') : '';
    if (v === 'list') await renderList();
    else if (v === 'fee') await renderFee();
    else if (v === 'summary') await renderSummary();
    else if (v === 'settings') await renderSettings();
    updateUndoButton();
    toast(`「${last.label}」を元に戻しました`);
  }

  // ---------- モーダル時のbody固定（iOS Safariのスクロール安定化） ----------
  let savedScrollY = 0;
  function lockBodyScroll() {
    if (document.body.classList.contains('modal-open')) return;
    savedScrollY = window.scrollY;
    document.body.style.top = `-${savedScrollY}px`;
    document.body.classList.add('modal-open');
  }
  function unlockBodyScroll() {
    if (!document.body.classList.contains('modal-open')) return;
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, savedScrollY);
  }
  function openModalEl(id) {
    lockBodyScroll();
    const el = $(`#${id}`);
    el.classList.remove('hidden');
    if (el.scrollTop !== undefined) el.scrollTop = 0;
  }
  function closeModalEl(id) {
    $(`#${id}`).classList.add('hidden');
    unlockBodyScroll();
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
      // 新しいSWが有効化されたら自動でリロード（毎回ではなく1回のみ）
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
