(function () {
  var D = window.SCORECARD;
  var PR = function (n) { return '<a href="https://github.com/LinuxDevil/agent-sdk/pull/' + n + '">#' + n + '</a>'; };
  var S = { ok: '✅', warn: '⚠️', bad: '❌' };
  var cls = function (s) { return s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'bad'; };
  var byId = function (id) { return document.getElementById(id); };

  byId('eyebrow').textContent = 'LinuxDevil/agent-sdk · agent loop · ' + D.date + ' · after iteration ' + D.iterations;

  var counts = { ok: 0, warn: 0, bad: 0 };
  D.matrix.forEach(function (r) { counts[r[1]]++; });
  var tb = document.querySelector('#matrix tbody');
  D.matrix.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.dataset.s = r[1];
    tr.dataset.p = r[5] ? '1' : '';
    tr.innerHTML = '<td>' + r[0] + (r[5] ? ' <span class="chip pend">in flight</span>' : '') + '</td>' +
      '<td><span class="chip ' + cls(r[1]) + '">' + S[r[1]] + '</span></td>' +
      '<td><span class="chip ' + cls(r[2]) + '">' + S[r[2]] + '</span></td>' +
      '<td><span class="chip ' + cls(r[3]) + '">' + S[r[3]] + '</span></td>' +
      '<td class="flip">' + (r[4] || '—') + '</td>';
    tb.appendChild(tr);
  });

  var merged = 0;
  Object.keys(D.done).forEach(function (e) { merged += D.done[e].length; });
  var remCount = 0;
  Object.keys(D.remaining).forEach(function (e) { remCount += D.remaining[e].length; });

  var tiles = [
    [D.iterations, 'iterations run'],
    [D.prsMerged, 'PRs merged'],
    [D.inFlight.length, 'tickets in flight'],
    [counts.ok + ' / ' + D.matrix.length, 'matrix rows at parity (was 16)'],
    [D.differentiatorsShipped, 'differentiators shipped (target 3)'],
    [D.lintWarnings, 'lint warnings (was 433)'],
    [D.tests, 'tests on main (was 1,921)'],
    [remCount, 'tickets remaining']
  ];
  byId('tiles').innerHTML = tiles.map(function (t) {
    return '<div class="tile"><div class="n">' + t[0] + '</div><div class="l">' + t[1] + '</div></div>';
  }).join('');
  var bar = byId('bar');
  [['ok', counts.ok], ['warn', counts.warn], ['bad', counts.bad]].forEach(function (p) {
    var sp = document.createElement('span');
    sp.className = cls(p[0]);
    sp.style.width = (p[1] / D.matrix.length * 100) + '%';
    sp.style.background = 'var(--' + p[0] + '-fg)';
    bar.appendChild(sp);
  });
  byId('legend').innerHTML =
    '<span><span class="chip ok">✅ ' + counts.ok + '</span> parity or better</span>' +
    '<span><span class="chip warn">⚠️ ' + counts.warn + '</span> partial</span>' +
    '<span><span class="chip bad">❌ ' + counts.bad + '</span> missing</span>' +
    '<span><span class="chip pend">in flight</span> an agent is on the flipping ticket</span>';

  document.querySelectorAll('.controls button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.controls button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      var f = b.dataset.f;
      tb.querySelectorAll('tr').forEach(function (tr) {
        var show = f === 'all' || (f === 'pend' ? tr.dataset.p === '1' : tr.dataset.s === f);
        tr.hidden = !show;
      });
    });
  });

  byId('diffs').innerHTML = D.differentiators.map(function (d) {
    return '<div class="card"><span class="chip ' + (d[0] === 'Shipped' ? 'ok' : 'pend') + '">' + d[0] + '</span><h3 style="margin-top:8px">' + d[1] + '</h3><p>' + d[2] + '</p></div>';
  }).join('');

  byId('doneTitle').textContent = 'Done: ' + D.prsMerged + ' PRs merged in ' + D.iterations + ' iterations';
  var doneHtml = '';
  Object.keys(D.done).forEach(function (epic) {
    doneHtml += '<h3>' + epic + ' <span class="dim">(' + D.done[epic].length + ')</span></h3><div class="tablewrap"><table><thead><tr><th style="width:80px">Ticket</th><th>What shipped</th><th style="width:70px">PR</th></tr></thead><tbody>';
    D.done[epic].forEach(function (t) {
      doneHtml += '<tr><td class="id">' + t[0] + '</td><td>' + t[1] + '</td><td>' + PR(t[2]) + '</td></tr>';
    });
    doneHtml += '</tbody></table></div>';
  });
  byId('done').innerHTML = doneHtml;

  byId('openTitle').textContent = D.inFlight.length ? 'In flight (iteration ' + (D.iterations + 1) + ')' : 'In flight';
  byId('open').innerHTML = D.inFlight.length
    ? '<ul>' + D.inFlight.map(function (t) {
        return '<li><strong>' + (t[2] ? PR(t[2]) + ' ' : '') + t[0] + '</strong> ' + t[1] + '</li>';
      }).join('') + '</ul>' + (D.inFlightNote ? '<p class="dim" style="margin-top:8px">' + D.inFlightNote + '</p>' : '')
    : '<p>Nothing is in flight. ' + (D.inFlightNote || '') + '</p>';

  byId('remTitle').textContent = 'Remaining: ' + remCount + ' one-point tickets';
  var remHtml = '';
  Object.keys(D.remaining).forEach(function (epic) {
    if (!D.remaining[epic].length) return;
    remHtml += '<h3>' + epic + ' <span class="dim">(' + D.remaining[epic].length + ')</span></h3><div class="tablewrap"><table><thead><tr><th style="width:80px">Ticket</th><th>What it adds</th><th style="width:110px">Deps</th><th style="width:70px">Batch</th></tr></thead><tbody>';
    D.remaining[epic].forEach(function (t) {
      remHtml += '<tr><td class="id">' + t[0] + (t[3] === D.iterations + 1 ? ' <span class="chip pend">now</span>' : '') + '</td><td>' + t[1] + '</td><td class="flip">' + (t[2] || '—') + '</td><td class="flip">' + (t[3] || '—') + '</td></tr>';
    });
    remHtml += '</tbody></table></div>';
  });
  byId('remaining').innerHTML = remHtml || '<p>Every ticket is merged.</p>';

  byId('notes').innerHTML = D.notes.map(function (n) { return '<li>' + n + '</li>'; }).join('');
})();
