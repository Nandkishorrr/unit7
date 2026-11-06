// Set the theme before first paint so there is no white flash in dark mode (external: CSP forbids inline scripts).
try {
  var t = localStorage.getItem('unit7-theme') || 'system';
  if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
