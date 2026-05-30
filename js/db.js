// ===== IndexedDB データ層 =====
// ストア: transactions（取引）, categories（カテゴリ）, settings（設定）, photos（領収書画像）,
//        members（メンバー）, feeCells（部費グリッドの状態: メンバー×月）
const DB = (() => {
  const DB_NAME = 'cheerful-kaikei';
  const DB_VER = 2;
  let _db = null;

  // 既定カテゴリ（提出フォーム準拠）
  const DEFAULT_INCOME_CATS = ['前年度繰越金', '部費', '雑収入', 'ルールブック代', '学校開放', '寄付', 'その他'];
  const DEFAULT_EXPENSE_CATS = [
    'ユニフォーム積立金', '備品代', '総会関係費', '大会参加費', '連盟登録費',
    '土産代', '交通費', '飲食費', '体育館使用料', '部費返金', '雑費'
  ];

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('transactions')) {
          const s = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('categories')) {
          db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('members')) {
          db.createObjectStore('members', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('feeCells')) {
          // key = `${memberId}|${YYYY-MM}`、value = 状態文字列
          db.createObjectStore('feeCells', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(store, mode = 'readonly') {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }
  function reqP(request) {
    return new Promise((res, rej) => { request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error); });
  }

  // ---- 初期化（初回のみ既定値を投入）----
  async function init() {
    const settings = await getAllSettings();
    const now = new Date();
    const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // 会計年度の開始年
    if (settings.initialized !== true) {
      await setSetting('teamName', 'チアフル');
      await setSetting('year', `${fy}年度`);
      await setSetting('treasurerName', '');
      await setSetting('carryover', 0);
      await setSetting('monthlyFee', 1000);
      await setSetting('unifondPerMonth', 300);
      for (const name of DEFAULT_INCOME_CATS) await addCategory('収入', name, true);
      for (const name of DEFAULT_EXPENSE_CATS) await addCategory('支出', name, true);
      await setSetting('initialized', true);
    }
    // 集計期間の既定値（未設定なら年度=12ヶ月、4月開始でマイグレーション）
    if (settings.periodMode == null) {
      await setSetting('periodMode', 'scale');
      await setSetting('periodScale', 12);
      await setSetting('periodCustomMonths', 12);
      await setSetting('periodStart', `${fy}-04`);
      await setSetting('periodEnd', `${fy + 1}-03`);
    }
    // 「部費返金」カテゴリが無ければ追加（既存ユーザー向け）
    const existingCats = await getCategories('支出');
    if (!existingCats.some((c) => c.name === '部費返金')) {
      await addCategory('支出', '部費返金', true);
    }
    // 旧お休み(500)セルを参加(1000)に変換（done5→done1, plan5→plan1）
    if (settings.feeMigrationV2 !== true) {
      const all = await getFeeCells();
      const rw = (await open()).transaction('feeCells', 'readwrite').objectStore('feeCells');
      for (const c of all) {
        if (c.status === 'done5' || c.status === 'plan5') {
          const newStatus = c.status === 'done5' ? 'done1' : 'plan1';
          await reqP(rw.put({ ...c, status: newStatus }));
        }
      }
      await setSetting('feeMigrationV2', true);
    }
  }

  // ---- 設定 ----
  async function setSetting(key, value) {
    const s = await tx('settings', 'readwrite');
    return reqP(s.put({ key, value }));
  }
  async function getSetting(key, fallback = null) {
    const s = await tx('settings');
    const r = await reqP(s.get(key));
    return r ? r.value : fallback;
  }
  async function getAllSettings() {
    const s = await tx('settings');
    const all = await reqP(s.getAll());
    const o = {};
    all.forEach((row) => { o[row.key] = row.value; });
    return o;
  }

  // ---- カテゴリ ----
  async function addCategory(type, name, isDefault = false) {
    const s = await tx('categories', 'readwrite');
    return reqP(s.add({ type, name, isDefault }));
  }
  async function getCategories(type = null) {
    const s = await tx('categories');
    const all = await reqP(s.getAll());
    return type ? all.filter((c) => c.type === type) : all;
  }
  async function deleteCategory(id) {
    const s = await tx('categories', 'readwrite');
    return reqP(s.delete(id));
  }

  // ---- 取引 ----
  async function addTransaction(t) {
    const s = await tx('transactions', 'readwrite');
    return reqP(s.add(t));
  }
  async function updateTransaction(t) {
    const s = await tx('transactions', 'readwrite');
    return reqP(s.put(t));
  }
  async function deleteTransaction(id) {
    const t = await getTransaction(id);
    if (t && t.photoId) await deletePhoto(t.photoId);
    const s = await tx('transactions', 'readwrite');
    return reqP(s.delete(id));
  }
  async function getTransaction(id) {
    const s = await tx('transactions');
    return reqP(s.get(id));
  }
  async function getAllTransactions() {
    const s = await tx('transactions');
    const all = await reqP(s.getAll());
    // 日付昇順、同日はid順
    all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    return all;
  }

  // ---- 写真（Blob） ----
  async function addPhoto(blob) {
    const s = await tx('photos', 'readwrite');
    return reqP(s.add({ blob }));
  }
  async function getPhoto(id) {
    const s = await tx('photos');
    const r = await reqP(s.get(id));
    return r ? r.blob : null;
  }
  async function deletePhoto(id) {
    const s = await tx('photos', 'readwrite');
    return reqP(s.delete(id));
  }

  // ---- メンバー ----
  async function addMember(name) {
    const members = await getMembers();
    const order = members.length ? Math.max(...members.map((m) => m.order || 0)) + 1 : 0;
    const s = await tx('members', 'readwrite');
    return reqP(s.add({ name, order }));
  }
  async function getMembers() {
    const s = await tx('members');
    const all = await reqP(s.getAll());
    all.sort((a, b) => (a.order || 0) - (b.order || 0) || a.id - b.id);
    return all;
  }
  async function updateMember(m) {
    const s = await tx('members', 'readwrite');
    return reqP(s.put(m));
  }
  async function deleteMember(id) {
    // そのメンバーの部費セルも削除
    const cells = await getFeeCells();
    const rw = await tx('feeCells', 'readwrite');
    for (const c of cells) if (c.key.startsWith(id + '|')) await reqP(rw.delete(c.key));
    const s = await tx('members', 'readwrite');
    return reqP(s.delete(id));
  }

  // ---- 部費セル（メンバー×月の状態） ----
  // status: 'plan1'|'done1'（なし=対象外）。paidDate: 'YYYY-MM-DD'（集金済の納付日）
  async function setFeeCell(key, status, paidDate) {
    const s = await tx('feeCells', 'readwrite');
    if (!status) return reqP(s.delete(key));
    const row = { key, status };
    if (paidDate) row.paidDate = paidDate;
    return reqP(s.put(row));
  }
  async function getFeeCells() {
    const s = await tx('feeCells');
    return reqP(s.getAll());
  }
  async function getFeeCellMap() {
    // key -> { status, paidDate }
    const all = await getFeeCells();
    const m = {};
    all.forEach((c) => { m[c.key] = { status: c.status, paidDate: c.paidDate || null }; });
    return m;
  }

  // ---- バックアップ ----
  async function exportAll() {
    const settings = await getAllSettings();
    const categories = await getCategories();
    const transactions = await getAllTransactions();
    // 写真はbase64で出力
    const photos = {};
    for (const t of transactions) {
      if (t.photoId && !photos[t.photoId]) {
        const blob = await getPhoto(t.photoId);
        if (blob) photos[t.photoId] = await blobToDataURL(blob);
      }
    }
    const members = await getMembers();
    const feeCells = await getFeeCells();
    return { version: 2, exportedAt: new Date().toISOString(), settings, categories, transactions, photos, members, feeCells };
  }
  async function importAll(data) {
    await clearAll();
    if (data.settings) for (const [k, v] of Object.entries(data.settings)) await setSetting(k, v);
    if (data.categories) {
      const s = await tx('categories', 'readwrite');
      for (const c of data.categories) await reqP(s.add(c));
    }
    // メンバーのID再マップ（部費セルのkeyも付け替え）
    const memberIdMap = {};
    if (data.members) {
      const s = await tx('members', 'readwrite');
      for (const m of data.members) {
        const copy = { ...m }; const oldId = copy.id; delete copy.id;
        const newId = await reqP(s.add(copy));
        memberIdMap[oldId] = newId;
      }
    }
    if (data.feeCells) {
      const s = await tx('feeCells', 'readwrite');
      for (const c of data.feeCells) {
        const [oldMid, ym] = c.key.split('|');
        const newMid = memberIdMap[oldMid] != null ? memberIdMap[oldMid] : oldMid;
        await reqP(s.put({ key: `${newMid}|${ym}`, status: c.status }));
      }
    }
    // 写真IDの再マップ
    const idMap = {};
    if (data.photos) {
      for (const [oldId, dataUrl] of Object.entries(data.photos)) {
        const blob = await dataURLToBlob(dataUrl);
        const newId = await addPhoto(blob);
        idMap[oldId] = newId;
      }
    }
    if (data.transactions) {
      const s = await tx('transactions', 'readwrite');
      for (const t of data.transactions) {
        const copy = { ...t };
        delete copy.id;
        if (copy.photoId && idMap[copy.photoId]) copy.photoId = idMap[copy.photoId];
        else delete copy.photoId;
        await reqP(s.add(copy));
      }
    }
  }
  async function clearAll() {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(['transactions', 'categories', 'settings', 'photos', 'members', 'feeCells'], 'readwrite');
      t.objectStore('transactions').clear();
      t.objectStore('categories').clear();
      t.objectStore('settings').clear();
      t.objectStore('photos').clear();
      t.objectStore('members').clear();
      t.objectStore('feeCells').clear();
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }

  // ---- ユーティリティ ----
  function blobToDataURL(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  }
  function dataURLToBlob(dataUrl) {
    return fetch(dataUrl).then((r) => r.blob());
  }

  return {
    init, setSetting, getSetting, getAllSettings,
    addCategory, getCategories, deleteCategory,
    addTransaction, updateTransaction, deleteTransaction, getTransaction, getAllTransactions,
    addPhoto, getPhoto, deletePhoto,
    addMember, getMembers, updateMember, deleteMember,
    setFeeCell, getFeeCells, getFeeCellMap,
    exportAll, importAll, clearAll, blobToDataURL,
    DEFAULT_INCOME_CATS, DEFAULT_EXPENSE_CATS
  };
})();
