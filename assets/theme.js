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

// Print-only link references ([n] markers + numbered Links bibliography) and
// <details> print expansion, matching postgres.ai blog print output.
(function () {
  var main = document.querySelector('main');
  if (!main || main.querySelector('.print-refs')) return;
  var canonicalEl = document.querySelector('link[rel="canonical"]');
  var baseUrl = (canonicalEl && canonicalEl.href) || 'https://pgaibench.dev/';
  var selfUrl;
  try { selfUrl = new URL(baseUrl); } catch (e) { selfUrl = new URL('https://pgaibench.dev/'); }
  var selfPath = selfUrl.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';

  var byUrl = Object.create(null);
  var refs = [];
  var links = main.querySelectorAll('a[href]');
  for (var i = 0; i < links.length; i++) {
    var a = links[i];
    if (a.closest('.print-refs')) continue;
    var raw = (a.getAttribute('href') || '').trim();
    if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) continue;
    var text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    var resolved;
    try { resolved = new URL(raw, baseUrl); } catch (e) { continue; }
    var rPath = resolved.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';
    if (resolved.origin === selfUrl.origin && rPath === selfPath && !resolved.search) continue;
    var href = resolved.href.replace(/\/index\.html(?=[#?]|$)/, '/');
    var n = byUrl[href];
    if (!n) {
      n = refs.length + 1;
      byUrl[href] = n;
      refs.push({ n: n, text: text, url: href });
    }
    var sup = document.createElement('sup');
    sup.className = 'print-ref';
    sup.textContent = '[' + n + ']';
    a.insertAdjacentElement('afterend', sup);
  }

  if (refs.length) {
    var sec = document.createElement('section');
    sec.className = 'print-refs';
    sec.setAttribute('aria-label', 'Links');
    var h = document.createElement('h2');
    h.className = 'print-refs__title';
    h.textContent = 'Links';
    var ol = document.createElement('ol');
    ol.className = 'print-refs__list';
    for (var j = 0; j < refs.length; j++) {
      var r = refs[j];
      var li = document.createElement('li');
      var num = document.createElement('span');
      num.className = 'print-refs__num';
      num.textContent = '[' + r.n + ']';
      var body = document.createElement('span');
      body.className = 'print-refs__body';
      if (r.text && r.text !== r.url) {
        var label = document.createElement('span');
        label.textContent = r.text + ' ';
        body.appendChild(label);
      }
      var u = document.createElement('a');
      u.className = 'print-refs__url';
      u.href = r.url;
      u.textContent = r.url;
      body.appendChild(u);
      li.appendChild(num);
      li.appendChild(body);
      ol.appendChild(li);
    }
    sec.appendChild(h);
    sec.appendChild(ol);
    main.appendChild(sec);
  }

  // Open collapsed <details> during print for browsers without ::details-content.
  var openedForPrint = [];
  window.addEventListener('beforeprint', function () {
    openedForPrint = [];
    var ds = document.querySelectorAll('details:not([open])');
    for (var k = 0; k < ds.length; k++) {
      ds[k].setAttribute('open', '');
      openedForPrint.push(ds[k]);
    }
  });
  window.addEventListener('afterprint', function () {
    for (var k = 0; k < openedForPrint.length; k++) {
      openedForPrint[k].removeAttribute('open');
    }
    openedForPrint = [];
  });
})();
