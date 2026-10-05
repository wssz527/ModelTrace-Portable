(function() {
  const stored = localStorage.getItem('mt-theme');
  const theme = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  
  function update(t) {
    document.documentElement.setAttribute('data-theme', t);
    toggle.textContent = t === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('mt-theme', t);
  }
  
  update(theme);
  toggle.onclick = () => update(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
})();
