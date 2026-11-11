// Optional table sort. The table is complete and ordered without JavaScript.
(function () {
  for (const table of document.querySelectorAll('table.sortable')) {
    const tbody = table.tBodies[0];
    for (const th of table.querySelectorAll('th[data-sortable]')) {
      const col = Number(th.dataset.col);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = th.textContent;
      th.textContent = '';
      th.appendChild(btn);
      th.setAttribute('aria-sort', 'none');
      btn.addEventListener('click', function () {
        const asc = th.getAttribute('aria-sort') !== 'ascending';
        for (const o of table.querySelectorAll('th[aria-sort]')) o.setAttribute('aria-sort', 'none');
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        const rows = Array.from(tbody.rows).filter(function (r) { return !r.classList.contains('detail'); });
        const key = function (r) { const c = r.cells[col]; const v = c ? c.dataset.sort : ''; const n = Number(v); return v !== '' && !isNaN(n) ? n : v; };
        rows.sort(function (a, b) { const x = key(a), y = key(b); const d = x < y ? -1 : x > y ? 1 : 0; return asc ? d : -d; });
        for (const r of rows) {
          tbody.appendChild(r);
          const d = tbody.querySelector('tr[data-detail-for="' + r.id + '"]');
          if (d) tbody.appendChild(d);
        }
      });
    }
  }
})();
