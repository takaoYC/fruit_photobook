(function () {
  'use strict';

  var REGION_OPTIONS = [
    ['north', '北部'], ['central', '中部'], ['south', '南部'], ['east', '東部'],
  ];
  var STOCK_OPTIONS = [
    ['in_stock', '尚有庫存'], ['out_of_stock', '目前無庫存'], ['unknown', '狀態未知'],
  ];
  // 電子書多一個「尚未上架」：電子版常常晚於實體書才上線。
  var EBOOK_STATUS_OPTIONS = STOCK_OPTIONS.concat([['not_listed', '尚未上架']]);
  var STOCK_LABELS = {
    in_stock: '尚有庫存', out_of_stock: '目前無庫存',
    unknown: '狀態未知', not_listed: '尚未上架',
  };

  function statusOptionsFor(kind) {
    return kind === 'ebook' ? EBOOK_STATUS_OPTIONS : STOCK_OPTIONS;
  }

  var FILES = ['stores.json', 'channels.json', 'meta.json'];
  var DRAFT_KEY = 'fruit-pb-admin-draft';
  var DB_NAME = 'fruit-pb-admin';
  var DB_STORE = 'handles';
  var DIR_KEY = 'dataDir';

  var state = {
    stores: [],
    channels: { online: [], ebook: [] },
    meta: {},
  };

  // 最後一次「與磁碟一致」的快照，用來判斷是否有未儲存變更
  var savedSnapshot = '';
  var dirHandle = null;
  var supportsFS = typeof window.showDirectoryPicker === 'function';

  var undoStack = [];
  var UNDO_LIMIT = 30;

  var filters = { keyword: '', region: 'all', stock: 'all' };
  var selected = {};          // storeId -> true
  var lastGeocodeAt = 0;      // Nominatim 使用規範：每秒最多一次

  // ---------------- 小工具 ----------------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function snapshot() { return JSON.stringify(state); }
  function $(id) { return document.getElementById(id); }
  function setVal(id, v) { $(id).value = v; }
  function getVal(id) { return $(id).value; }
  function attr(s) { return text(s).replace(/"/g, '&quot;'); }
  function text(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  var toastTimer = null;
  function showToast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  // ---------------- IndexedDB：記住資料夾授權 ----------------

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    }).catch(function () { return null; });
  }

  function idbSet(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () {});
  }

  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
      });
    }).catch(function () {});
  }

  // ---------------- 資料夾連結 ----------------

  // 使用者可能選 data/ 本身，也可能選專案根目錄——兩種都接受。
  function resolveDataDir(handle) {
    return handle.getFileHandle('stores.json').then(function () {
      return handle;
    }).catch(function () {
      return handle.getDirectoryHandle('data').then(function (sub) {
        return sub.getFileHandle('stores.json').then(function () { return sub; });
      });
    });
  }

  function connectFolder() {
    if (!supportsFS) return;
    window.showDirectoryPicker({ id: 'fruit-pb-data', mode: 'readwrite', startIn: 'documents' })
      .then(resolveDataDir)
      .then(function (dir) {
        return requestPermission(dir).then(function (ok) {
          if (!ok) throw new Error('未取得寫入權限');
          dirHandle = dir;
          return idbSet(DIR_KEY, dir);
        });
      })
      .then(function () {
        return loadFromDisk();
      })
      .then(function () {
        renderAll();
        showToast('已連結 data 資料夾，之後按「儲存」就會直接寫回檔案');
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (err && err.name === 'NotFoundError') {
          showToast('這個資料夾裡找不到 stores.json，請選擇專案的 data 資料夾', 'err');
          return;
        }
        showToast('連結失敗：' + (err && err.message ? err.message : err), 'err');
      });
  }

  function requestPermission(dir) {
    if (!dir || !dir.requestPermission) return Promise.resolve(true);
    return dir.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p === 'granted') return true;
      return dir.requestPermission({ mode: 'readwrite' }).then(function (p2) { return p2 === 'granted'; });
    });
  }

  function disconnectFolder() {
    dirHandle = null;
    idbDel(DIR_KEY);
    renderConnection();
    showToast('已解除資料夾連結');
  }

  function readJSONFromDir(dir, name) {
    return dir.getFileHandle(name).then(function (fh) { return fh.getFile(); })
      .then(function (f) { return f.text(); })
      .then(function (t) { return JSON.parse(t); });
  }

  function writeJSONToDir(dir, name, data) {
    return dir.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) {
        return w.write(JSON.stringify(data, null, 2) + '\n').then(function () { return w.close(); });
      });
  }

  // ---------------- 載入 ----------------

  function fetchJSON(path) {
    return fetch(path, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('無法載入 ' + path);
      return res.json();
    });
  }

  function loadFromDisk() {
    if (!dirHandle) return Promise.reject(new Error('尚未連結資料夾'));
    return Promise.all([
      readJSONFromDir(dirHandle, 'stores.json'),
      readJSONFromDir(dirHandle, 'channels.json'),
      readJSONFromDir(dirHandle, 'meta.json'),
    ]).then(applyLoaded);
  }

  function loadFromServer() {
    return Promise.all([
      fetchJSON('data/stores.json').catch(function () { return []; }),
      fetchJSON('data/channels.json').catch(function () { return { online: [], ebook: [] }; }),
      fetchJSON('data/meta.json').catch(function () { return {}; }),
    ]).then(applyLoaded);
  }

  function applyLoaded(results) {
    state.stores = results[0] || [];
    state.channels = results[1] || { online: [], ebook: [] };
    if (!state.channels.online) state.channels.online = [];
    if (!state.channels.ebook) state.channels.ebook = [];
    state.meta = results[2] || {};
    savedSnapshot = snapshot();
    undoStack = [];
    selected = {};
    clearDraft();
  }

  // ---------------- 草稿（localStorage） ----------------

  var draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state }));
      } catch (e) {}
    }, 400);
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  function readDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.data) return null;
      return d;
    } catch (e) { return null; }
  }

  // ---------------- 變更追蹤 / 復原 ----------------

  function isDirty() { return snapshot() !== savedSnapshot; }

  function pushUndo(label) {
    undoStack.push({ label: label, data: clone(state) });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function undo() {
    var entry = undoStack.pop();
    if (!entry) { showToast('沒有可復原的動作'); return; }
    state.stores = entry.data.stores;
    state.channels = entry.data.channels;
    state.meta = entry.data.meta;
    selected = {};
    renderAll();
    showToast('已復原：' + entry.label);
  }

  // 每次資料變動後統一呼叫
  function touched() {
    saveDraft();
    renderStatusBar();
    refreshPreviews();
  }

  // ---------------- 驗證 ----------------

  function storeIssues(s) {
    var out = [];
    if (!String(s.name || '').trim()) out.push('缺少門市名稱');
    if (!String(s.address || '').trim()) out.push('缺少地址');
    var hasLat = typeof s.lat === 'number' && !isNaN(s.lat);
    var hasLon = typeof s.lon === 'number' && !isNaN(s.lon);
    if (hasLat !== hasLon) out.push('經緯度只填了一半');
    if (hasLat && (s.lat < 21 || s.lat > 26.5)) out.push('緯度不在台灣範圍');
    if (hasLon && (s.lon < 118 || s.lon > 123)) out.push('經度不在台灣範圍');
    return out;
  }

  function channelIssues(c) {
    var out = [];
    if (!String(c.name || '').trim()) out.push('缺少名稱');
    var url = String(c.url || '').trim();
    if (!url) out.push('缺少連結網址');
    else if (!/^https?:\/\/.+/i.test(url)) out.push('網址須以 http:// 或 https:// 開頭');
    return out;
  }

  function allIssueCount() {
    var n = 0;
    state.stores.forEach(function (s) { if (storeIssues(s).length) n++; });
    ['online', 'ebook'].forEach(function (k) {
      state.channels[k].forEach(function (c) { if (channelIssues(c).length) n++; });
    });
    return n;
  }

  // ---------------- 儲存 ----------------

  function save() {
    var issues = allIssueCount();
    if (issues > 0 && !confirm('目前有 ' + issues + ' 筆資料有問題（缺欄位或格式不對）。仍要儲存嗎？')) return;

    if (!dirHandle) { downloadAll(); return; }

    requestPermission(dirHandle).then(function (ok) {
      if (!ok) throw new Error('資料夾寫入權限被拒絕');
      return Promise.all([
        writeJSONToDir(dirHandle, 'stores.json', state.stores),
        writeJSONToDir(dirHandle, 'channels.json', state.channels),
        writeJSONToDir(dirHandle, 'meta.json', state.meta),
      ]);
    }).then(function () {
      savedSnapshot = snapshot();
      clearDraft();
      renderStatusBar();
      showToast('已寫入 data/ 資料夾（3 個檔案）', 'ok');
      showPublishHint();
    }).catch(function (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        showToast('需要重新授權資料夾，請再按一次「儲存」', 'err');
      } else {
        showToast('儲存失敗：' + (err && err.message ? err.message : err), 'err');
      }
    });
  }

  function showPublishHint() {
    var el = $('publishHint');
    if (el) el.hidden = false;
  }

  function download(filename, data) {
    var blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadAll() {
    download('stores.json', state.stores);
    download('channels.json', state.channels);
    download('meta.json', state.meta);
    savedSnapshot = snapshot();
    clearDraft();
    renderStatusBar();
    showToast('已下載 3 個 JSON 檔，請覆蓋到 data/ 資料夾', 'ok');
    showPublishHint();
  }

  function copyToClipboard(str, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(function () {
        showToast(okMsg || '已複製到剪貼簿');
      }).catch(function () {
        showToast('複製失敗，請手動選取內容複製', 'err');
      });
    } else {
      showToast('此瀏覽器不支援自動複製，請手動選取內容複製', 'err');
    }
  }

  // ---------------- 狀態列 ----------------

  function renderConnection() {
    var dot = $('connDot');
    var label = $('connLabel');
    var connectBtn = $('connectBtn');
    var disconnectBtn = $('disconnectBtn');

    if (!supportsFS) {
      dot.className = 'conn-dot warn';
      label.textContent = '此瀏覽器不支援直接寫檔（請用桌面版 Chrome / Edge），儲存時會改為下載 JSON';
      connectBtn.hidden = true;
      disconnectBtn.hidden = true;
      return;
    }
    if (dirHandle) {
      dot.className = 'conn-dot ok';
      label.innerHTML = '已連結本機 <code>data/</code> 資料夾 · 按「儲存」直接寫回檔案';
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    } else {
      dot.className = 'conn-dot warn';
      label.textContent = '尚未連結資料夾 · 儲存時會改為下載 JSON 檔';
      connectBtn.hidden = false;
      connectBtn.textContent = '連結 data 資料夾';
      disconnectBtn.hidden = true;
    }
  }

  function renderStatusBar() {
    var dirty = isDirty();
    var badge = $('dirtyBadge');
    badge.textContent = dirty ? '● 有未儲存的變更' : '✓ 全部已儲存';
    badge.className = 'dirty-badge' + (dirty ? ' is-dirty' : '');

    var saveBtn = $('saveBtn');
    saveBtn.disabled = !dirty;
    saveBtn.textContent = dirHandle ? '儲存到 data/' : '下載全部 JSON';

    $('undoBtn').disabled = undoStack.length === 0;

    var issues = allIssueCount();
    var iv = $('issueBadge');
    if (issues > 0) {
      iv.hidden = false;
      iv.textContent = issues + ' 筆需要檢查';
    } else {
      iv.hidden = true;
    }
  }

  // ---------------- 初始化 ----------------

  function boot() {
    renderConnection();

    var restore = supportsFS
      ? idbGet(DIR_KEY).then(function (h) {
          if (!h) return null;
          // 只查詢、不主動要求權限（要求權限必須由使用者手勢觸發）
          return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
            dirHandle = h;
            return p;
          }).catch(function () { return null; });
        })
      : Promise.resolve(null);

    restore.then(function (perm) {
      renderConnection();
      if (dirHandle && perm === 'granted') {
        return loadFromDisk().catch(function () { return loadFromServer(); });
      }
      if (dirHandle && perm === 'prompt') {
        // 記得資料夾但需要重新授權：先用伺服器資料顯示，儲存時再要求權限
        return loadFromServer();
      }
      return loadFromServer();
    }).then(function () {
      offerDraft();
      renderAll();
      bindEvents();
    }).catch(function (err) {
      alert('資料載入失敗：' + err.message);
      console.error(err);
    });
  }

  function offerDraft() {
    var d = readDraft();
    if (!d) return;
    if (JSON.stringify(d.data) === savedSnapshot) { clearDraft(); return; }

    var when = new Date(d.savedAt);
    var banner = $('draftBanner');
    $('draftTime').textContent = when.toLocaleString('zh-TW', { hour12: false });
    banner.hidden = false;

    $('draftRestoreBtn').addEventListener('click', function () {
      state.stores = d.data.stores || [];
      state.channels = d.data.channels || { online: [], ebook: [] };
      state.meta = d.data.meta || {};
      banner.hidden = true;
      renderAll();
      showToast('已還原上次未儲存的草稿');
    });
    $('draftDiscardBtn').addEventListener('click', function () {
      clearDraft();
      banner.hidden = true;
      showToast('已捨棄草稿');
    });
  }

  function renderAll() {
    renderConnection();
    renderStoresTable();
    renderChannelTable('online');
    renderChannelTable('ebook');
    renderMetaForm();
    renderStatusBar();
  }

  function bindEvents() {
    initTabs();

    $('connectBtn').addEventListener('click', connectFolder);
    $('disconnectBtn').addEventListener('click', disconnectFolder);
    $('saveBtn').addEventListener('click', save);
    $('undoBtn').addEventListener('click', undo);
    $('downloadAllBtn').addEventListener('click', downloadAll);
    $('reloadBtn').addEventListener('click', reloadFromSource);
    $('copyGitBtn').addEventListener('click', function () {
      copyToClipboard('git add data/ && git commit -m "更新通路資料" && git push', '已複製 git 指令');
    });

    $('addStoreBtn').addEventListener('click', addStore);
    $('addOnlineBtn').addEventListener('click', function () { addChannel('online'); });
    $('addEbookBtn').addEventListener('click', function () { addChannel('ebook'); });

    $('storeSearch').addEventListener('input', function () {
      filters.keyword = this.value.trim().toLowerCase();
      renderStoresTable();
    });
    $('adminRegionFilter').addEventListener('change', function () {
      filters.region = this.value;
      renderStoresTable();
    });
    $('adminStockFilter').addEventListener('change', function () {
      filters.stock = this.value;
      renderStoresTable();
    });

    $('bulkStockBtn').addEventListener('click', applyBulkStock);
    $('bulkDeleteBtn').addEventListener('click', bulkDelete);
    $('geocodeAllBtn').addEventListener('click', geocodeMissing);

    $('copyStoresBtn').addEventListener('click', function () {
      copyToClipboard(JSON.stringify(state.stores, null, 2));
    });
    $('copyChannelsBtn').addEventListener('click', function () {
      copyToClipboard(JSON.stringify(state.channels, null, 2));
    });
    $('copyMetaBtn').addEventListener('click', function () {
      copyToClipboard(JSON.stringify(state.meta, null, 2));
    });

    document.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 's') { e.preventDefault(); if (isDirty()) save(); }
      if (e.key === 'z' && !e.shiftKey) {
        var t = e.target.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA') return; // 讓輸入框自己的復原正常運作
        e.preventDefault();
        undo();
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });

    document.querySelectorAll('.json-preview-toggle').forEach(function (d) {
      d.addEventListener('toggle', refreshPreviews);
    });
  }

  function reloadFromSource() {
    if (isDirty() && !confirm('重新載入會丟棄目前未儲存的變更，確定嗎？')) return;
    var p = dirHandle
      ? requestPermission(dirHandle).then(function (ok) {
          return ok ? loadFromDisk() : loadFromServer();
        })
      : loadFromServer();
    p.then(function () {
      renderAll();
      showToast('已重新載入磁碟上的資料');
    }).catch(function (err) {
      showToast('重新載入失敗：' + err.message, 'err');
    });
  }

  function initTabs() {
    var btns = document.querySelectorAll('.tab-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        btns.forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        $('panel-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  // ---------------- 門市 ----------------

  function nextId(list) {
    return list.reduce(function (max, item) { return Math.max(max, item.id || 0); }, 0) + 1;
  }

  function addStore() {
    pushUndo('新增門市');
    var s = {
      id: nextId(state.stores), region: 'north', name: '', address: '', phone: '',
      stock: 'unknown', lat: null, lon: null,
    };
    state.stores.push(s);
    filters.keyword = '';
    filters.region = 'all';
    filters.stock = 'all';
    $('storeSearch').value = '';
    $('adminRegionFilter').value = 'all';
    $('adminStockFilter').value = 'all';
    renderStoresTable();
    touched();
    var input = document.querySelector('tr[data-id="' + s.id + '"] input[data-field="name"]');
    if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
  }

  function visibleStores() {
    return state.stores.filter(function (s) {
      if (filters.region !== 'all' && s.region !== filters.region) return false;
      if (filters.stock !== 'all' && (s.stock || 'unknown') !== filters.stock) return false;
      if (filters.keyword) {
        var hay = (String(s.name || '') + ' ' + String(s.address || '') + ' ' + String(s.phone || '')).toLowerCase();
        if (hay.indexOf(filters.keyword) === -1) return false;
      }
      return true;
    });
  }

  function renderStoresTable() {
    var wrap = $('storesTableWrap');
    var list = visibleStores();

    // 統計
    var counts = { in_stock: 0, out_of_stock: 0, unknown: 0 };
    state.stores.forEach(function (s) { counts[s.stock || 'unknown'] = (counts[s.stock || 'unknown'] || 0) + 1; });
    $('storeStats').innerHTML =
      '共 <strong>' + state.stores.length + '</strong> 間門市 · ' +
      '<span class="pill ok">尚有庫存 ' + counts.in_stock + '</span>' +
      '<span class="pill warn">無庫存 ' + counts.out_of_stock + '</span>' +
      '<span class="pill">未知 ' + counts.unknown + '</span>' +
      (list.length !== state.stores.length ? ' · 篩選後顯示 <strong>' + list.length + '</strong> 間' : '');

    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state">沒有符合條件的門市。</div>';
      renderBulkBar();
      refreshPreviews();
      return;
    }

    var rows = list.map(function (s) {
      var issues = storeIssues(s);
      var hasCoord = typeof s.lat === 'number' && typeof s.lon === 'number';
      return '<tr data-id="' + s.id + '" class="' + (issues.length ? 'row-invalid' : '') + '">' +
        '<td class="col-check" data-label="選取"><input type="checkbox" data-action="select"' + (selected[s.id] ? ' checked' : '') + ' aria-label="選取此門市"></td>' +
        '<td class="col-id" data-label="ID">' + s.id + '</td>' +
        '<td data-label="地區">' + selectHtml('region', REGION_OPTIONS, s.region) + '</td>' +
        '<td data-label="門市名稱"><input data-field="name" value="' + attr(s.name) + '" placeholder="例：誠品書店台大店"></td>' +
        '<td data-label="地址"><textarea data-field="address" placeholder="完整地址">' + text(s.address) + '</textarea></td>' +
        '<td data-label="電話"><input data-field="phone" value="' + attr(s.phone) + '" placeholder="02-1234-5678"></td>' +
        '<td data-label="庫存">' + selectHtml('stock', STOCK_OPTIONS, s.stock) + '</td>' +
        '<td class="col-coord" data-label="座標">' +
          '<div class="coord-grid">' +
            '<input data-field="lat" type="number" step="any" value="' + (s.lat != null ? s.lat : '') + '" placeholder="緯度">' +
            '<input data-field="lon" type="number" step="any" value="' + (s.lon != null ? s.lon : '') + '" placeholder="經度">' +
          '</div>' +
          '<button class="btn tiny" data-action="geocode">' + (hasCoord ? '重查座標' : '從地址查座標') + '</button>' +
        '</td>' +
        '<td class="col-actions" data-label="操作"><button class="btn tiny danger" data-action="delete">刪除</button></td>' +
        (issues.length ? '' : '') +
        '</tr>' +
        (issues.length
          ? '<tr class="issue-row" data-issue-for="' + s.id + '"><td colspan="9">' + text(issues.join('、')) + '</td></tr>'
          : '');
    }).join('');

    wrap.innerHTML = '<table class="admin-table"><thead><tr>' +
      '<th class="col-check"><input type="checkbox" id="selectAllStores" aria-label="全選"></th>' +
      '<th>ID</th><th>地區</th><th>門市名稱</th><th>地址</th><th>電話</th><th>庫存</th>' +
      '<th>座標</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    var allSelected = list.every(function (s) { return selected[s.id]; });
    var selectAll = $('selectAllStores');
    selectAll.checked = allSelected;
    selectAll.addEventListener('change', function () {
      list.forEach(function (s) {
        if (selectAll.checked) selected[s.id] = true; else delete selected[s.id];
      });
      renderStoresTable();
    });

    wrap.querySelectorAll('tr[data-id]').forEach(function (tr) {
      var id = Number(tr.dataset.id);

      tr.querySelectorAll('[data-field]').forEach(function (input) {
        var evt = input.tagName === 'SELECT' ? 'change' : 'input';
        input.addEventListener(evt, function () {
          updateStoreField(id, input.dataset.field, input.value);
        });
      });

      var cb = tr.querySelector('[data-action="select"]');
      if (cb) cb.addEventListener('change', function () {
        if (cb.checked) selected[id] = true; else delete selected[id];
        renderBulkBar();
        $('selectAllStores').checked = visibleStores().every(function (s) { return selected[s.id]; });
      });

      var geoBtn = tr.querySelector('[data-action="geocode"]');
      if (geoBtn) geoBtn.addEventListener('click', function () { geocodeStore(id, geoBtn); });

      var delBtn = tr.querySelector('[data-action="delete"]');
      if (delBtn) delBtn.addEventListener('click', function () {
        var s = state.stores.find(function (x) { return x.id === id; });
        pushUndo('刪除門市「' + (s && s.name ? s.name : '未命名') + '」');
        state.stores = state.stores.filter(function (x) { return x.id !== id; });
        delete selected[id];
        renderStoresTable();
        touched();
        showToast('已刪除，可按左上「復原」或 Ctrl/⌘+Z 還原');
      });
    });

    renderBulkBar();
    refreshPreviews();
  }

  function renderBulkBar() {
    var ids = Object.keys(selected);
    var bar = $('bulkBar');
    bar.hidden = ids.length === 0;
    $('bulkCount').textContent = ids.length;
  }

  function applyBulkStock() {
    var ids = Object.keys(selected).map(Number);
    if (!ids.length) return;
    var value = $('bulkStockValue').value;
    pushUndo('批次設定 ' + ids.length + ' 間門市庫存');
    state.stores.forEach(function (s) {
      if (ids.indexOf(s.id) !== -1) s.stock = value;
    });
    renderStoresTable();
    touched();
    showToast('已將 ' + ids.length + ' 間門市設為「' + STOCK_LABELS[value] + '」');
  }

  function bulkDelete() {
    var ids = Object.keys(selected).map(Number);
    if (!ids.length) return;
    if (!confirm('確定要刪除選取的 ' + ids.length + ' 間門市嗎？（可復原）')) return;
    pushUndo('刪除 ' + ids.length + ' 間門市');
    state.stores = state.stores.filter(function (s) { return ids.indexOf(s.id) === -1; });
    selected = {};
    renderStoresTable();
    touched();
    showToast('已刪除 ' + ids.length + ' 間門市，可按「復原」還原');
  }

  function updateStoreField(id, field, value) {
    var s = state.stores.find(function (x) { return x.id === id; });
    if (!s) return;
    if (field === 'lat' || field === 'lon') {
      s[field] = value === '' ? null : Number(value);
    } else {
      s[field] = value;
    }
    touched();
    // 庫存／地區改變會影響篩選結果，需要重畫
    if ((field === 'stock' && filters.stock !== 'all') || (field === 'region' && filters.region !== 'all')) {
      renderStoresTable();
    }
  }

  // ---------------- 地址轉座標（OpenStreetMap Nominatim，免費、免金鑰） ----------------

  // Nominatim 對台灣地址的門牌（「號」）幾乎查不到，但路段查得到，
  // 所以由細到粗試兩種寫法：先連門牌一起查，查不到再退到路段層級。
  // （刻意不用門市名稱查詢——實測「誠品書店台大店」會回傳新店分店，差了 5 公里。）
  function addressQueries(address) {
    var a = String(address || '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!a) return [];
    var list = [];
    var withNo = a.replace(/號.*$/, '號');
    var roadOnly = a.replace(/[\d０-９之\-]+\s*號.*$/, '').trim();
    [withNo, roadOnly, a].forEach(function (q) {
      if (q && list.indexOf(q) === -1) list.push(q);
    });
    return list;
  }

  function queryNominatim(q) {
    var wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
    return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(function () {
      lastGeocodeAt = Date.now();
      var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&q=' +
        encodeURIComponent(q);
      return fetch(url, { headers: { 'Accept': 'application/json' } });
    }).then(function (res) {
      if (!res.ok) throw new Error('查詢服務回應 ' + res.status);
      return res.json();
    }).then(function (arr) {
      if (!arr || !arr.length) return null;
      return { lat: Number(Number(arr[0].lat).toFixed(7)), lon: Number(Number(arr[0].lon).toFixed(7)) };
    });
  }

  function geocode(address) {
    var queries = addressQueries(address);
    if (!queries.length) return Promise.resolve(null);

    function attempt(i) {
      if (i >= queries.length) return Promise.resolve(null);
      return queryNominatim(queries[i]).then(function (r) {
        if (r) {
          // 第一個查法帶著門牌；退到後面的查法就只到路段，屬於約略位置。
          r.approx = i > 0;
          r.query = queries[i];
          return r;
        }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  function geocodeStore(id, btn) {
    var s = state.stores.find(function (x) { return x.id === id; });
    if (!s) return;
    var addr = String(s.address || '').trim();
    if (!addr) { showToast('請先填寫地址', 'err'); return; }

    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '查詢中…';
    geocode(addr).then(function (r) {
      btn.disabled = false;
      if (!r) { btn.textContent = original; showToast('查不到「' + addr + '」的座標，請手動填入', 'err'); return; }
      pushUndo('查詢座標：' + (s.name || '未命名'));
      s.lat = r.lat;
      s.lon = r.lon;
      var tr = document.querySelector('tr[data-id="' + id + '"]');
      if (tr) {
        tr.querySelector('[data-field="lat"]').value = r.lat;
        tr.querySelector('[data-field="lon"]').value = r.lon;
      }
      btn.textContent = '重查座標';
      touched();
      if (r.approx) {
        showToast('查不到門牌，已用「' + r.query + '」的路段位置估算，請到前台地圖確認再微調');
      } else {
        showToast('已填入座標 ' + r.lat + ', ' + r.lon, 'ok');
      }
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = original;
      showToast('座標查詢失敗：' + err.message, 'err');
    });
  }

  function geocodeMissing() {
    var todo = state.stores.filter(function (s) {
      return String(s.address || '').trim() && (typeof s.lat !== 'number' || typeof s.lon !== 'number');
    });
    if (!todo.length) { showToast('所有有地址的門市都已經有座標了'); return; }
    if (!confirm('將依序查詢 ' + todo.length + ' 間門市的座標（每秒 1 筆，約需 ' +
      Math.ceil(todo.length * 1.1) + ' 秒），期間請不要關閉頁面。開始嗎？')) return;

    pushUndo('批次查詢 ' + todo.length + ' 筆座標');
    var btn = $('geocodeAllBtn');
    btn.disabled = true;
    var done = 0, found = 0, approx = 0;

    function step() {
      if (!todo.length) {
        btn.disabled = false;
        btn.textContent = '補齊缺少的座標';
        renderStoresTable();
        touched();
        showToast('查詢完成：' + done + ' 筆中有 ' + found + ' 筆查到' +
          (approx ? '（其中 ' + approx + ' 筆只查到路段、屬約略位置，請到前台地圖確認）' : ''),
          found ? 'ok' : 'err');
        return;
      }
      var s = todo.shift();
      btn.textContent = '查詢中 ' + (done + 1) + '…';
      geocode(String(s.address).trim()).then(function (r) {
        done++;
        if (r) { s.lat = r.lat; s.lon = r.lon; found++; if (r.approx) approx++; }
        step();
      }).catch(function () { done++; step(); });
    }
    step();
  }

  // ---------------- 通路 ----------------

  function addChannel(kind) {
    pushUndo('新增通路');
    state.channels[kind].push({ id: nextId(state.channels[kind]), name: '', url: '', note: '', status: 'unknown' });
    renderChannelTable(kind);
    touched();
  }

  function renderChannelTable(kind) {
    var wrap = $(kind === 'online' ? 'onlineTableWrap' : 'ebookTableWrap');
    var list = state.channels[kind];

    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state">尚無項目，按上方「新增」加入。</div>';
      return;
    }

    var rows = list.map(function (c) {
      var issues = channelIssues(c);
      var url = String(c.url || '').trim();
      return '<tr data-id="' + c.id + '" class="' + (issues.length ? 'row-invalid' : '') + '">' +
        '<td class="col-id" data-label="ID">' + c.id + '</td>' +
        '<td data-label="名稱"><input data-field="name" value="' + attr(c.name) + '" placeholder="例：博客來"></td>' +
        '<td data-label="連結網址">' +
          '<input data-field="url" value="' + attr(c.url) + '" placeholder="https://…">' +
          (/^https?:\/\/.+/i.test(url)
            ? '<a class="test-link" href="' + attr(url) + '" target="_blank" rel="noopener">↗ 測試連結</a>'
            : '') +
        '</td>' +
        '<td data-label="備註"><input data-field="note" value="' + attr(c.note || '') + '" placeholder="選填"></td>' +
        '<td data-label="狀態">' + selectHtml('status', statusOptionsFor(kind), c.status || 'unknown') + '</td>' +
        '<td class="col-actions" data-label="操作"><button class="btn tiny danger" data-action="delete">刪除</button></td>' +
        '</tr>' +
        (issues.length
          ? '<tr class="issue-row"><td colspan="6">' + text(issues.join('、')) + '</td></tr>'
          : '');
    }).join('');

    wrap.innerHTML = '<table class="admin-table"><thead><tr>' +
      '<th>ID</th><th>名稱</th><th>連結網址</th><th>備註</th><th>狀態</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    wrap.querySelectorAll('tr[data-id]').forEach(function (tr) {
      var id = Number(tr.dataset.id);
      tr.querySelectorAll('[data-field]').forEach(function (input) {
        var evt = input.tagName === 'SELECT' ? 'change' : 'input';
        input.addEventListener(evt, function () {
          updateChannelField(kind, id, input.dataset.field, input.value);
        });
      });
      var delBtn = tr.querySelector('[data-action="delete"]');
      if (delBtn) delBtn.addEventListener('click', function () {
        var c = state.channels[kind].find(function (x) { return x.id === id; });
        pushUndo('刪除通路「' + (c && c.name ? c.name : '未命名') + '」');
        state.channels[kind] = state.channels[kind].filter(function (x) { return x.id !== id; });
        renderChannelTable(kind);
        touched();
        showToast('已刪除，可按「復原」還原');
      });
    });

    refreshPreviews();
  }

  function updateChannelField(kind, id, field, value) {
    var c = state.channels[kind].find(function (x) { return x.id === id; });
    if (!c) return;
    c[field] = value;
    touched();
  }

  // ---------------- 網站設定 ----------------

  function renderMetaForm() {
    var m = state.meta || {};
    var links = m.links || {};
    setVal('m_siteTitle', m.siteTitle || '');
    setVal('m_siteSubtitle', m.siteSubtitle || '');
    setVal('m_lastUpdated', m.lastUpdated || '');
    setVal('m_disclaimer', m.disclaimer || '');
    setVal('m_uchutecho', links.uchutecho || '');
    setVal('m_pp12', links.pp12 || '');

    if (!renderMetaForm.bound) {
      renderMetaForm.bound = true;
      ['m_siteTitle', 'm_siteSubtitle', 'm_lastUpdated', 'm_disclaimer', 'm_uchutecho', 'm_pp12'].forEach(function (id) {
        $(id).addEventListener('input', syncMetaFromForm);
      });
      $('setTodayBtn').addEventListener('click', function () {
        setVal('m_lastUpdated', todayString());
        syncMetaFromForm();
        showToast('已設為今天');
      });
    }
    refreshPreviews();
  }

  function todayString() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function syncMetaFromForm() {
    state.meta = {
      siteTitle: getVal('m_siteTitle'),
      siteSubtitle: getVal('m_siteSubtitle'),
      lastUpdated: getVal('m_lastUpdated'),
      disclaimer: getVal('m_disclaimer'),
      links: {
        uchutecho: getVal('m_uchutecho'),
        pp12: getVal('m_pp12'),
      },
    };
    touched();
  }

  // ---------------- 其他 ----------------

  function selectHtml(field, options, current) {
    var opts = options.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === current ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    return '<select data-field="' + field + '">' + opts + '</select>';
  }

  // JSON 預覽只在展開時更新，避免每次按鍵都重新序列化整份資料
  function refreshPreviews() {
    setPreview('storesPreview', state.stores);
    setPreview('channelsPreview', state.channels);
    setPreview('metaPreview', state.meta);
  }

  function setPreview(id, data) {
    var el = $(id);
    if (!el) return;
    var details = el.closest('details');
    if (details && !details.open) return;
    el.textContent = JSON.stringify(data, null, 2);
  }

  boot();
})();
