(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preferred;
  try { preferred = localStorage.getItem('notebook_theme'); } catch { /* Storage may be blocked in private contexts. */ }
  const apply = theme => { document.documentElement.dataset.theme = theme; };
  apply(['light', 'dark'].includes(preferred) ? preferred : media.matches ? 'dark' : 'light');
  media.addEventListener('change', event => { if (!preferred) apply(event.matches ? 'dark' : 'light'); });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const update = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      button.textContent = dark ? '☼' : '◐';
      button.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
    };
    update();
    button.addEventListener('click', () => {
      preferred = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(preferred);
      try { localStorage.setItem('notebook_theme', preferred); } catch { /* Theme remains usable for this page. */ }
      update();
    });
    media.addEventListener('change', update);
  });
})();
