// Switcher for the two-axis plot. Without JavaScript the controls stay hidden
// and the plot shows its default view: one point per model at its main
// effort level. The filter logic is pure (PlotFilter) and unit-tested.
(function (g) {
  var RANK = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'default'];
  function defaults() { return { off: [], levels: false, oneRun: false, model: '' }; }
  /** 'on', 'dim' or 'off' for one point {family, model, effort, main, oneRun} in state s. */
  function show(p, s) {
    if (s.model && p.model === s.model) return 'on';
    var on = s.off.indexOf('f:' + p.family) < 0 && s.off.indexOf('e:' + p.effort) < 0 && (p.oneRun ? s.oneRun : (p.main || s.levels));
    if (!on) return 'off';
    return s.model ? 'dim' : 'on';
  }
  /** The points of one model in effort order (the order of the joining line). */
  function lineOrder(ps, model) {
    return ps.filter(function (p) { return p.model === model; }).sort(function (a, b) { return RANK.indexOf(a.effort) - RANK.indexOf(b.effort); });
  }
  function toHash(s) {
    var parts = s.off.slice().sort().map(function (x) { return '-' + x; });
    if (s.levels) parts.push('levels');
    if (s.oneRun) parts.push('onerun');
    if (s.model) parts.push('m:' + s.model);
    return parts.length ? '#plot=' + parts.join(',') : '';
  }
  function fromHash(h) {
    var s = defaults(), m = /(?:^#|&)plot=([^&]*)/.exec(h || '');
    if (!m) return s;
    m[1].split(',').forEach(function (x) {
      try { x = decodeURIComponent(x); } catch (e) { return; }
      if (/^-(f|e):[a-z0-9.\-]+$/.test(x)) s.off.push(x.slice(1));
      else if (x === 'levels') s.levels = true;
      else if (x === 'onerun') s.oneRun = true;
      else if (/^m:[a-z0-9.\-]+$/.test(x)) s.model = x.slice(2);
    });
    s.off.sort();
    return s;
  }
  g.PlotFilter = { RANK: RANK, defaults: defaults, show: show, lineOrder: lineOrder, toHash: toHash, fromHash: fromHash };
  if (typeof document === 'undefined') return;

  function setup(box) {
    var fig = box.parentNode, s = fromHash(location.hash);
    var items = Array.prototype.slice.call(fig.querySelectorAll('ol.qkey li[data-n]')).map(function (li) {
      return { li: li, n: li.getAttribute('data-n'), family: li.getAttribute('data-family'), model: li.getAttribute('data-model'), effort: li.getAttribute('data-effort'), main: li.getAttribute('data-main') === '1', oneRun: li.getAttribute('data-onerun') === '1' };
    });
    var sel = box.querySelector('select');
    function mark(el, v) { el.classList.toggle('q-off', v === 'off'); el.classList.toggle('q-dim', v === 'dim'); }
    function apply() {
      items.forEach(function (p) {
        var v = show(p, s);
        p.li.hidden = v === 'off';
        p.li.classList.toggle('q-dim', v === 'dim');
        var els = fig.querySelectorAll('[data-n="' + p.n + '"]:not(li)');
        for (var i = 0; i < els.length; i++) mark(els[i], v);
      });
      var lines = fig.querySelectorAll('.q-line');
      for (var i = 0; i < lines.length; i++) lines[i].classList.toggle('q-off', lines[i].getAttribute('data-model') !== s.model);
      var bs = box.querySelectorAll('button[data-k]');
      for (var j = 0; j < bs.length; j++) {
        var k = bs[j].getAttribute('data-k');
        var pressed = k === 'levels' ? s.levels : k === 'onerun' ? s.oneRun : s.off.indexOf(k) < 0;
        bs[j].setAttribute('aria-pressed', String(pressed));
      }
      if (sel) sel.value = s.model;
    }
    function save() {
      var h = toHash(s);
      try { history.replaceState(null, '', h || location.pathname + location.search); } catch (e) {}
      apply();
    }
    box.addEventListener('click', function (e) {
      var t = e.target, k = t && t.getAttribute && t.getAttribute('data-k');
      if (t && t.getAttribute && t.getAttribute('data-reset') !== null) { s = defaults(); save(); return; }
      if (!k) return;
      if (k === 'levels') s.levels = !s.levels;
      else if (k === 'onerun') s.oneRun = !s.oneRun;
      else { var i = s.off.indexOf(k); if (i < 0) s.off.push(k); else s.off.splice(i, 1); s.off.sort(); }
      save();
    });
    if (sel) sel.addEventListener('change', function () { s.model = sel.value; save(); });
    box.hidden = false;
    apply();
  }
  var boxes = document.querySelectorAll('.qctl');
  for (var i = 0; i < boxes.length; i++) setup(boxes[i]);
})(globalThis);
