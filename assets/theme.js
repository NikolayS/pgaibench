// Theme switcher: system (default), light, dark. Without JavaScript the
// switcher stays hidden and the page follows the system theme.
(function () {
  var root = document.documentElement, box = document.querySelector('.theme');
  if (!box) return;
  var meta = document.querySelector('meta[name=color-scheme]');
  function apply(t) {
    if (t === 'light' || t === 'dark') { root.setAttribute('data-theme', t); if (meta) meta.setAttribute('content', t); }
    else { root.removeAttribute('data-theme'); if (meta) meta.setAttribute('content', 'light dark'); }
    var bs = box.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].getAttribute('data-theme-set') === (t || 'system')));
  }
  var cur = null; try { cur = localStorage.getItem('theme'); } catch (e) {}
  apply(cur);
  box.addEventListener('click', function (e) {
    var t = e.target && e.target.getAttribute && e.target.getAttribute('data-theme-set');
    if (!t) return;
    try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch (err) {}
    apply(t === 'system' ? null : t);
  });
  box.hidden = false;
})();
