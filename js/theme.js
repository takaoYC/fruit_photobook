(function () {
  var STORAGE_KEY = 'fruit-pb-theme';
  var root = document.documentElement;
  var btn = document.getElementById('themeToggle');
  var icon = document.getElementById('themeIcon');

  // 第一次造訪一律是淺色（暖調紙面版本），不跟隨系統偏好；
  // 只有使用者自己按過切換鈕，才會記住並套用深色。
  function currentTheme() {
    var attr = root.getAttribute('data-theme');
    return attr === 'dark' ? 'dark' : 'light';
  }

  function applyVisual() {
    var isDark = currentTheme() === 'dark';
    if (btn) btn.classList.toggle('is-dark', isDark);
    // 圖示顯示「按下去會切到的模式」，沿用 pp_uchutecho 的做法。
    if (icon) icon.textContent = isDark ? '☀' : '☾';
    if (btn) btn.setAttribute('aria-label', isDark ? '切換為淺色模式' : '切換為深色模式');
  }

  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
    applyVisual();
  }

  if (btn) {
    btn.addEventListener('click', function () {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  applyVisual();
})();
