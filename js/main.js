(function () {
  'use strict';

  var REGION_LABELS = { north: '北部', central: '中部', south: '南部', east: '東部' };
  var REGION_ORDER = ['north', 'central', 'south', 'east'];
  var STOCK_LABELS = {
    in_stock: '尚有庫存', out_of_stock: '目前無庫存',
    unknown: '狀態未知', not_listed: '尚未上架',
  };

  var state = {
    meta: null,
    stores: [],
    channels: { online: [], ebook: [] },
    userLocation: null, // { lat, lon }
    sortByDistance: false,
  };

  var mapEl = document.getElementById('map');
  var map = null;
  var markerLayer = null;
  var userMarker = null;

  // ---------------- Data loading ----------------

  function fetchJSON(path) {
    return fetch(path, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('無法載入 ' + path);
      return res.json();
    });
  }

  Promise.all([
    fetchJSON('data/meta.json'),
    fetchJSON('data/stores.json'),
    fetchJSON('data/channels.json'),
  ])
    .then(function (results) {
      state.meta = results[0];
      state.stores = results[1];
      state.channels = results[2];
      init();
    })
    .catch(function (err) {
      document.getElementById('storeListContainer').innerHTML =
        '<div class="empty-state">資料載入失敗：' + err.message +
        '<br>若您是直接以檔案總管開啟 index.html，請改用本機伺服器（例如 <code>python3 -m http.server</code>）後再瀏覽。</div>';
      console.error(err);
    });

  function init() {
    renderMeta();
    initTabs();
    initMap();
    initControls();
    renderOnline();
    renderEbook();
    applyFilters();
  }

  // ---------------- Meta / header ----------------

  function renderMeta() {
    var m = state.meta || {};
    document.title = (m.siteTitle || '通路查詢') + ' · ' + (m.siteSubtitle || '');
    setText('brandText', m.siteTitle || '通路查詢');
    setText('siteTitle', m.siteTitle || '');
    setText('siteSubtitle', m.siteSubtitle || '');
    setText('disclaimerText', m.disclaimer || '');
    setText('updatedText', '資料更新至：' + (m.lastUpdated || '—'));

    var links = m.links || {};
    var a1 = document.getElementById('linkUchutecho');
    var a2 = document.getElementById('linkPP12');
    if (links.uchutecho) a1.href = links.uchutecho;
    if (links.pp12) a2.href = links.pp12;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ---------------- Tabs ----------------

  function initTabs() {
    var btns = document.querySelectorAll('.tab-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        btns.forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'physical' && map) {
          setTimeout(function () { map.invalidateSize(); }, 50);
        }
      });
    });
  }

  // ---------------- Map ----------------

  function initMap() {
    map = L.map(mapEl, { scrollWheelZoom: true }).setView([23.7, 120.9], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function renderMap(stores) {
    if (!map) return;
    markerLayer.clearLayers();
    stores.forEach(function (s) {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return;
      var stock = s.stock || 'unknown';
      // 樣式（實心色塊＋白環＋投影）交給 CSS，才能隨主題切換；
      // 這裡只負責幾何尺寸與狀態 class。
      var marker = L.circleMarker([s.lat, s.lon], {
        radius: 9,
        weight: 2.5,
        className: 'store-marker is-' + stock,
      });
      // 用 tooltip 而非 popup：點擊已經會開啟完整的門市彈窗，
      // 兩者同時出現只會互相打架。滑過看名稱、點下去看細節。
      marker.bindTooltip(
        '<b>' + escapeHtml(s.name) + '</b>' +
        '<span class="badge ' + stock + '">' + (STOCK_LABELS[stock] || '') + '</span>',
        { direction: 'top', offset: [0, -10], className: 'store-tip', sticky: false }
      );
      marker.on('click', function () { openStoreModal(s); });
      marker.addTo(markerLayer);
    });
  }

  // ---------------- Controls / filters ----------------

  function initControls() {
    document.getElementById('storeSearch').addEventListener('input', applyFilters);
    document.getElementById('regionFilter').addEventListener('change', applyFilters);
    document.getElementById('stockFilter').addEventListener('change', applyFilters);
    document.getElementById('locateBtn').addEventListener('click', requestLocation);
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('storeModalOverlay').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });
  }

  function requestLocation() {
    var statusEl = document.getElementById('geoStatus');
    if (!navigator.geolocation) {
      statusEl.textContent = '此瀏覽器不支援定位功能，仍可於地圖上瀏覽門市位置。';
      return;
    }
    statusEl.textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        state.userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.sortByDistance = true;
        statusEl.textContent = '已定位成功，門市已依距離排序（直線距離估算，僅供參考）。';
        placeUserMarker();
        applyFilters();
      },
      function () {
        statusEl.textContent = '您已選擇不提供定位，仍可透過地圖與清單瀏覽所有門市位置。';
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function placeUserMarker() {
    if (!map || !state.userLocation) return;
    if (userMarker) map.removeLayer(userMarker);
    var pos = [state.userLocation.lat, state.userLocation.lon];
    userMarker = L.layerGroup([
      L.circleMarker(pos, { radius: 18, weight: 0, className: 'user-marker-halo' }),
      L.circleMarker(pos, { radius: 7, weight: 3, className: 'user-marker-dot' })
        .bindPopup('您的位置'),
    ]).addTo(map);
    map.setView(pos, 12);
  }

  function applyFilters() {
    var q = document.getElementById('storeSearch').value.trim().toLowerCase();
    var region = document.getElementById('regionFilter').value;
    var stock = document.getElementById('stockFilter').value;

    var filtered = state.stores.filter(function (s) {
      if (region !== 'all' && s.region !== region) return false;
      if (stock !== 'all' && s.stock !== stock) return false;
      if (q && s.name.toLowerCase().indexOf(q) === -1 && s.address.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    if (state.userLocation) {
      filtered.forEach(function (s) {
        if (typeof s.lat === 'number' && typeof s.lon === 'number') {
          s._distanceKm = haversineKm(state.userLocation.lat, state.userLocation.lon, s.lat, s.lon);
        }
      });
    }

    renderMap(filtered);
    renderList(filtered);
  }

  // ---------------- Store list ----------------

  function renderList(stores) {
    var container = document.getElementById('storeListContainer');
    if (!stores.length) {
      container.innerHTML = '<div class="empty-state">找不到符合條件的門市，請調整搜尋或篩選條件。</div>';
      return;
    }

    if (state.sortByDistance && state.userLocation) {
      var sorted = stores.slice().sort(function (a, b) {
        return (a._distanceKm || Infinity) - (b._distanceKm || Infinity);
      });
      container.innerHTML = '<div class="store-grid">' + sorted.map(storeCardHtml).join('') + '</div>';
    } else {
      var html = '';
      REGION_ORDER.forEach(function (region) {
        var group = stores.filter(function (s) { return s.region === region; });
        if (!group.length) return;
        html += '<div class="region-group">' +
          '<h3 class="region-title">' + REGION_LABELS[region] + '</h3>' +
          '<div class="store-grid">' + group.map(storeCardHtml).join('') + '</div>' +
          '</div>';
      });
      container.innerHTML = html || '<div class="empty-state">找不到符合條件的門市。</div>';
    }

    markReveal(container, '.card');

    container.querySelectorAll('[data-store-id]').forEach(function (card) {
      card.addEventListener('click', function () {
        var id = Number(card.dataset.storeId);
        var store = state.stores.find(function (s) { return s.id === id; });
        if (store) openStoreModal(store);
      });
    });
  }

  function storeCardHtml(s) {
    var distanceHtml = '';
    if (typeof s._distanceKm === 'number') {
      distanceHtml = '<div class="card-distance">' + icon('pin') +
        '<span>直線距離約 ' + formatDistance(s._distanceKm) + '</span></div>';
    }
    return '<div class="card" data-store-id="' + s.id + '">' +
      '<div class="card-head">' +
      '<span class="card-title">' + escapeHtml(s.name) + '</span>' +
      '<span class="badge ' + s.stock + '">' + STOCK_LABELS[s.stock] + '</span>' +
      '</div>' +
      '<div class="card-addr">' + icon('pin') + '<span>' + escapeHtml(s.address) + '</span></div>' +
      '<div class="card-phone">' + icon('phone') + '<span>' + escapeHtml(s.phone) + '</span></div>' +
      distanceHtml +
      '</div>';
  }

  // ---------------- Modal ----------------

  function openStoreModal(s) {
    document.getElementById('modalRegion').textContent = REGION_LABELS[s.region] || '';
    document.getElementById('modalName').textContent = s.name;
    document.getElementById('modalAddress').textContent = s.address;
    var phoneEl = document.getElementById('modalPhone');
    phoneEl.textContent = s.phone;
    phoneEl.href = toTelHref(s.phone);
    var stockEl = document.getElementById('modalStock');
    stockEl.textContent = STOCK_LABELS[s.stock];
    stockEl.className = 'badge ' + s.stock;

    var distEl = document.getElementById('modalDistance');
    if (state.userLocation && typeof s.lat === 'number') {
      var d = haversineKm(state.userLocation.lat, state.userLocation.lon, s.lat, s.lon);
      distEl.style.display = 'block';
      distEl.innerHTML = '距離您目前位置直線約 <strong>' + formatDistance(d) +
        '</strong>（僅供參考的估算值，非實際路程距離）';
    } else {
      distEl.style.display = 'block';
      distEl.innerHTML = '點選上方「定位我的位置」，即可查看與此門市的估算距離。';
    }

    var dirEl = document.getElementById('modalDirections');
    if (typeof s.lat === 'number' && typeof s.lon === 'number') {
      var url = 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lon;
      if (state.userLocation) {
        url += '&origin=' + state.userLocation.lat + ',' + state.userLocation.lon;
      }
      dirEl.href = url;
      dirEl.style.display = '';
    } else {
      dirEl.style.display = 'none';
    }

    document.getElementById('modalCall').href = toTelHref(s.phone);

    document.getElementById('storeModalOverlay').classList.add('open');
  }

  function closeModal() {
    document.getElementById('storeModalOverlay').classList.remove('open');
  }

  // ---------------- Online / Ebook channels ----------------

  function renderOnline() {
    renderChannelGrid('onlineGrid', state.channels.online || [], '前往通路');
  }

  function renderEbook() {
    renderChannelGrid('ebookGrid', state.channels.ebook || [], '前往閱讀平台');
  }

  function renderChannelGrid(containerId, list, ctaLabel) {
    var el = document.getElementById(containerId);
    if (!list.length) {
      el.innerHTML = '<div class="empty-state">目前尚無通路資訊，請留意後續公告。</div>';
      return;
    }
    el.innerHTML = list.map(function (c) {
      var badge = c.status ? '<span class="badge ' + c.status + '">' + (STOCK_LABELS[c.status] || c.status) + '</span>' : '';
      return '<div class="channel-card">' +
        '<div class="card-head"><span class="name">' + escapeHtml(c.name) + '</span>' + badge + '</div>' +
        (c.note ? '<div class="note">' + escapeHtml(c.note) + '</div>' : '') +
        '<a class="btn go" href="' + escapeAttr(c.url) + '" target="_blank" rel="noopener">' +
          ctaLabel + icon('arrow') + '</a>' +
        '</div>';
    }).join('');
    markReveal(el, '.channel-card');
  }

  // ---------------- Scroll reveal ----------------

  // 逐段淡入，呼應 12 週年站的節奏。
  // 淡入只是裝飾：只有在確定觀察得到時才把內容藏起來，並且一律留一道保險，
  // 免得動畫沒被觸發（背景分頁、IntersectionObserver 未送出）就永遠看不到門市清單。
  function canReveal() {
    return 'IntersectionObserver' in window &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function markReveal(container, selector) {
    var els = [].slice.call(container.querySelectorAll(selector));
    if (!els.length || !canReveal()) return;

    els.forEach(function (el, i) {
      el.classList.add('reveal');
      el.style.transitionDelay = Math.min(i, 6) * 0.035 + 's';
    });

    var delivered = false;
    var io = new IntersectionObserver(function (entries) {
      delivered = true;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    // 提前 240px 觸發：清單很長，等進入視窗才淡入會在快速捲動時留下空白。
    }, { rootMargin: '240px 0px 240px 0px', threshold: 0 });

    els.forEach(function (el) { io.observe(el); });

    // 保險：分頁在背景時瀏覽器不會送出觀察結果，等它回到前景再判斷；
    // 若確實在前景卻仍未收到任何結果，就直接全部顯示。
    function safetyNet() {
      if (delivered) return;
      if (document.hidden) {
        document.addEventListener('visibilitychange', function once() {
          document.removeEventListener('visibilitychange', once);
          setTimeout(safetyNet, 600);
        });
        return;
      }
      els.forEach(function (el) { el.classList.add('in'); });
    }
    setTimeout(safetyNet, 1600);
  }

  // ---------------- Utils ----------------

  function icon(name) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }


  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatDistance(km) {
    if (km < 1) return Math.round(km * 1000) + ' 公尺';
    return km.toFixed(1) + ' 公里';
  }

  function toTelHref(phone) {
    var digits = (phone || '').replace(/[^\d+]/g, '');
    return 'tel:' + digits;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }
})();
