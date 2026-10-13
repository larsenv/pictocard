'use strict';

(() => {
  const root = document.documentElement;
  const theme = document.getElementById('themeToggle');
  const menu = document.getElementById('menuToggle');
  const navigation = document.getElementById('siteNavigation');
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');

  function updateThemeLabel() {
    theme.textContent = root.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
  }
  updateThemeLabel();
  theme.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('pictocard-theme', root.dataset.theme); } catch {}
    updateThemeLabel();
  });
  systemTheme.addEventListener('change', () => {
    try { if (localStorage.getItem('pictocard-theme')) return; } catch {}
    root.dataset.theme = systemTheme.matches ? 'dark' : 'light';
    updateThemeLabel();
  });

  function setMenu(open) {
    navigation.classList.toggle('menu-open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.textContent = open ? 'Close' : 'Menu';
  }
  menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && !navigation.contains(event.target)) setMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
      setMenu(false);
      menu.focus();
    }
  });
  navigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenu(false);
  });
  matchMedia('(max-width: 700px)').addEventListener('change', () => setMenu(false));
})();
