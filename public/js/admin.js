/* Admin console: events, ticket sources (API / file / webhook), imports, reports. */
(function () {
  'use strict';

  var root = document.getElementById('root');
  var PLATFORMS = {
    shotgun: { name: 'Shotgun', kinds: ['api', 'file'], every: 1 },
    dice: { name: 'DICE', kinds: ['api', 'file'], every: 2 },
    ra: { name: 'RA', kinds: ['file'] },
    bucketlisters: { name: 'Bucket Listers', kinds: ['file'] },
    eventbrite: { name: 'Eventbrite', kinds: ['api', 'file'], every: 2 },
    posh: { name: 'Posh', kinds: ['webhook', 'file'] },
    other: { name: 'Other', kinds: ['file', 'webhook'] },
  };
  var KIND_NAMES = { api: 'API', file: 'Upload file', webhook: 'Webhook' };
  var KIND_LABELS = { api: 'API', file: 'Upload', webhook: 'Webhook' };
  var VOID_STATUS = /refund|cancel|void|invalid|revoked|transferr|resold|declin|reject|chargeback|deleted|not attending|returned/i;
  var STALE_MS = 60 * 60 * 1000;
  var refreshTimer = null;

  // ------------------------------------------------------------------ helpers

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); });
    return n;
  }

  async function api(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'X-Requested-With': 'door-admin' };
    var payload;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') { payload = body; headers['Content-Type'] = opts.contentType || 'text/plain; charset=utf-8'; }
      else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    }
    loading(1);
    var res;
    try { res = await fetch(path, { method: method, headers: headers, body: payload, credentials: 'same-origin', cache: 'no-store' }); }
    finally { loading(-1); }
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && !opts.allow401) { renderLogin(); throw new Error('Sign in again'); }
    if (!res.ok) { var err = new Error(data.error || 'HTTP ' + res.status); err.status = res.status; throw err; }
    return data;
  }

  var inFlight = 0;
  function loading(d) { inFlight = Math.max(0, inFlight + d); document.body.classList.toggle('loading', inFlight > 0); }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtClock(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDoors(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : 'Doors ' + d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  }
  function ago(iso) {
    if (!iso) return 'never';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return fmtDate(iso);
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }
  // "Today 8:57 PM" or "Nov 25, 8:57 PM": short enough for one line on a phone.
  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.toDateString() === new Date().toDateString() ? 'Today ' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ') + fmtClock(iso);
  }
  function n(x) { return Number(x || 0).toLocaleString(); }
  function platformName(p) { return (PLATFORMS[p] || {}).name || p; }
  function isMadeUp(code) { return /^NOQR-/.test(code || ''); }

  // ------------------------------------------------------------------ motion

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function later(ms, fn) { return setTimeout(fn, reduceMotion ? 0 : ms); }
  // Restarts a CSS animation class, so the same element can play it again.
  function play(node, cls) { if (!node) return; node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }
  // Numbers glide from the value on screen to the new one.
  function countTo(node, to, ms) {
    var from = Number(node.getAttribute('data-v') || 0);
    node.setAttribute('data-v', String(to));
    if (reduceMotion || from === to) { node.textContent = n(to); return; }
    var start = null;
    function step(t) {
      if (start === null) start = t;
      var k = Math.min(1, (t - start) / (ms || 700));
      node.textContent = n(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && node.isConnected) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  // Rows rise in one after another; capped so long lists never wait.
  function stagger(nodes) {
    if (reduceMotion) return;
    Array.prototype.slice.call(nodes, 0, 14).forEach(function (node, i) { node.style.setProperty('--i', String(i)); node.classList.add('rise'); });
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.setAttribute('data-label', btn.textContent); if (label) btn.textContent = label; btn.classList.add('busy'); btn.disabled = true; }
    else { btn.classList.remove('busy'); btn.disabled = false; if (btn.getAttribute('data-label')) btn.textContent = btn.getAttribute('data-label'); }
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.remove('leaving');
    t.hidden = false;
    play(t, 'enter');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.add('leaving');
      toastTimer = later(200, function () { t.hidden = true; t.classList.remove('leaving'); });
    }, ms || 4000);
  }

  // opts: { small, noClose, alert }. Pop-ups can stack (a confirm over the Edit sheet): Escape closes the top one.
  function modal(title, body, onClose, opts) {
    opts = opts || {};
    var back = el('div', { class: 'modal-back' });
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      back.classList.add('leaving'); // slides away, then leaves the page
      document.removeEventListener('keydown', esc);
      later(200, function () {
        back.remove();
        document.body.classList.toggle('modal-open', !!document.querySelector('.modal-back:not(.leaving)'));
      });
      if (onClose) onClose();
    }
    function esc(e) { var all = document.querySelectorAll('.modal-back:not(.leaving)'); if (e.key === 'Escape' && all[all.length - 1] === back) close(); }
    var box = el('div', { class: 'modal' + (opts.small ? ' small' : ''), role: opts.alert ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('header', null, [el('h2', { text: title }), opts.noClose ? null : el('button', { type: 'button', class: 'ghost sm', text: 'Close', onclick: close })]),
      body,
    ]);
    back.appendChild(box);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(back);
    document.body.classList.add('modal-open');
    return close;
  }

  // In-app confirm: a sheet on phones, a small dialog on laptops. Resolves true only on the action button.
  function ask(title, text, yes, danger) {
    return new Promise(function (resolve) {
      var answered = false;
      function answer(v) { if (answered) return; answered = true; close(); resolve(v); }
      var no = el('button', { type: 'button', class: 'lg', text: 'Cancel', onclick: function () { answer(false); } });
      var go = el('button', { type: 'button', class: 'lg ' + (danger ? 'danger solid' : 'primary'), text: yes, onclick: function () { answer(true); } });
      var close = modal(title, el('div', { class: 'ask' }, [el('p', { text: text }), el('div', { class: 'ask-actions' }, [no, go])]),
        function () { if (!answered) { answered = true; resolve(false); } }, { small: true, noClose: true, alert: true });
      (danger ? no : go).focus();
    });
  }

  function plural(count, one, many) { return n(count) + ' ' + (count === 1 ? one : many); }

  function field(label, input, hint) {
    return el('label', { class: 'field' }, [el('span', { class: 'label', text: label }), input, hint ? el('small', { text: hint }) : null]);
  }

  function copyField(value) {
    var input = el('input', { value: value, readonly: true });
    return el('div', { class: 'copy-field' }, [input, el('button', { type: 'button', class: 'sm', text: 'Copy', onclick: function () {
      input.select();
      (navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject()).then(function () { toast('Copied'); }, function () { document.execCommand('copy'); toast('Copied'); });
    } })]);
  }

  // crumbs: the way back ([{ text, href }]). meta: an optional line under the title.
  function pageHead(crumbs, title, actions, meta) {
    var crumb = null;
    if (crumbs && crumbs.length) {
      crumb = el('nav', { class: 'crumb', 'aria-label': 'Breadcrumb' });
      crumbs.forEach(function (c, i) {
        if (i) crumb.appendChild(el('span', { class: 'sep', text: '/' }));
        crumb.appendChild(c.href ? el('a', { href: c.href, text: c.text }) : el('span', { text: c.text }));
      });
    }
    return el('div', { class: 'page-head' }, [
      el('div', { class: 'ph-text' }, [crumb, el('h1', { text: title }), meta || null]),
      actions && actions.length ? el('div', { class: 'head-actions' }, actions) : null,
    ]);
  }

  // The sidebar layout every signed-in page uses. depth: 0 events, 1 an event, 2 a page inside an event.
  // Going deeper slides the page in from the right, going back from the left.
  var lastDepth = 0;
  function shell(depth) {
    clearInterval(refreshTimer);
    depth = depth || 0;
    root.textContent = '';
    var main = el('main', { class: 'main' });
    if (pageChange && !reduceMotion) main.classList.add(depth > lastDepth ? 'enter-fwd' : depth < lastDepth ? 'enter-back' : 'enter-fade');
    lastDepth = depth;
    root.appendChild(el('div', { class: 'shell' }, [
      el('aside', { class: 'side' }, [
        el('a', { href: '#/', 'aria-label': 'Events' }, [el('img', { class: 'logo', src: '/brand/moji-logo.png', alt: 'Moji' })]),
        el('a', { class: 'nav active', href: '#/', text: 'Events' }),
        el('a', { class: 'nav', href: '/', target: '_blank', rel: 'noopener', text: 'Door app' }),
        el('div', { class: 'me' }, [
          el('div', { class: 'n', text: 'Moji Sounds' }),
          el('button', { type: 'button', class: 'text-btn', text: 'Sign out', onclick: async function () { await api('POST', '/api/admin/logout', {}); renderLogin(); } }),
        ]),
      ]),
      main,
    ]));
    if (toTop) { window.scrollTo(0, 0); toTop = false; }
    freshPage = pageChange;
    pageChange = false;
    return main;
  }

  // ------------------------------------------------------------------ routing
  // #/                      events
  // #/event/ID              an event: Overview      (…/guests, …/scans, …/door for the other tabs)
  // #/event/ID/add          add a ticket source
  // #/event/ID/upload/SID   upload a file for a source

  var shownHash = null;
  var toTop = false;
  var pageChange = false;
  var freshPage = false;
  function pageChangeFresh() { return freshPage; }
  var EVENT_TAB = /^#\/event\/([^/]+)(?:\/(guests|scans|door))?$/;
  function route() {
    var h = location.hash;
    var m = EVENT_TAB.exec(h);
    // Another tab of the event on screen: switch in place, no reload.
    if (m && view && view.id === m[1] && view.root.isConnected) { shownHash = h; switchTab(m[2] || 'overview'); return; }
    clearInterval(refreshTimer);
    view = null;
    // A new page opens at the top and slides in; re-rendering the same page (after Sync, Remove…) keeps the scroll.
    if (h !== shownHash) { toTop = true; pageChange = true; shownHash = h; }
    if (m) return renderEvent(m[1], m[2] || 'overview');
    if ((m = /^#\/event\/([^/]+)\/add$/.exec(h))) return renderAddSource(m[1]);
    if ((m = /^#\/event\/([^/]+)\/upload\/([^/]+)$/.exec(h))) return renderUpload(m[1], m[2]);
    if ((m = /^#\/event\/([^/]+)/.exec(h))) { location.replace('#/event/' + m[1]); return; }
    renderEvents();
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ login

  function renderLogin() {
    clearInterval(refreshTimer);
    root.textContent = '';
    var pw = el('input', { type: 'password', autocomplete: 'current-password', required: true });
    var err = el('p', { class: 'error', role: 'alert' });
    root.appendChild(el('div', { class: 'admin-login' }, [el('form', { onsubmit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      try {
        await api('POST', '/api/admin/login', { password: pw.value }, { allow401: true });
        route();
      } catch (ex) { err.textContent = ex.message; }
    } }, [
      el('div', { class: 'brandline' }, [el('img', { class: 'logo', src: '/brand/moji-logo.png', alt: 'Moji' }), el('span', { class: 'sep' }), el('span', { class: 'label', text: 'Door admin' })]),
      el('h1', { text: 'Sign in' }),
      field('Admin password', pw),
      el('button', { class: 'primary lg', type: 'submit', text: 'Sign in' }),
      err,
    ])]));
    pw.focus();
  }

  // ------------------------------------------------------------------ events list

  function eventStatus(e) {
    if (e.archived) return ['muted', 'Archived', 4];
    var t = Date.parse(e.startsAt);
    var now = Date.now();
    if (!isNaN(t)) {
      if (now >= t - 4 * 3600e3 && now <= t + 10 * 3600e3) return ['ok live', 'Live now', 0];
      if (now > t + 10 * 3600e3) return ['muted', 'Ended', 3];
    }
    if (!e.sources) return ['draft', 'Draft', 2];
    return ['in', 'Upcoming', 1];
  }

  function platformsLine(list) {
    if (!list || !list.length) return 'No sources yet';
    return list.slice(0, 3).join(', ') + (list.length > 3 ? ' +' + (list.length - 3) : '');
  }

  // A thin bar: share of valid tickets checked in. It grows from `fromPct` (0 on first show) to the value.
  // Width goes through the CSSOM (the CSP blocks inline styles).
  function meter(scanned, valid, cls, fromPct) {
    var pct = valid ? Math.min(100, Math.round(100 * scanned / valid)) : 0;
    var fill = el('i');
    fill.style.width = (reduceMotion ? pct : fromPct || 0) + '%';
    if (!reduceMotion) requestAnimationFrame(function () { requestAnimationFrame(function () { fill.style.width = pct + '%'; }); });
    return el('div', { class: 'meter' + (cls ? ' ' + cls : ''), role: 'img', 'aria-label': n(scanned) + ' of ' + n(valid) + ' checked in' }, [fill]);
  }

  var GROUPS = ['Tonight', 'Coming up', 'Coming up', 'Past', 'Past'];

  async function renderEvents() {
    var data;
    try { data = await api('GET', '/api/admin/events'); } catch (e) { return; }
    var main = shell(0);
    main.appendChild(pageHead([], 'Events', [el('button', { type: 'button', class: 'primary', text: 'New event', onclick: newEvent })]));
    if (!data.events.length) {
      main.appendChild(el('div', { class: 'empty-card' }, [
        el('p', { text: 'Create your first event, then add where its tickets were sold: Shotgun, DICE, RA, Bucket Listers, Eventbrite, Posh or any CSV.' }),
        el('button', { type: 'button', class: 'primary', text: 'New event', onclick: newEvent }),
      ]));
      return;
    }
    // Live first, then upcoming (soonest first), drafts, then past events (latest first).
    var list = data.events.map(function (e) { return { e: e, st: eventStatus(e), t: Date.parse(e.startsAt) || 0 }; });
    list.sort(function (a, b) {
      if (a.st[2] !== b.st[2]) return a.st[2] - b.st[2];
      return a.st[2] >= 3 ? b.t - a.t : a.t - b.t;
    });
    var groups = list.map(function (x) { return GROUPS[x.st[2]]; }).filter(function (g, i, all) { return all.indexOf(g) === i; });
    var rows = [];
    var lastGroup = null;
    list.forEach(function (x) {
      var e = x.e;
      var st = x.st;
      var group = GROUPS[st[2]];
      // Section labels only help when there's more than one kind of event.
      if (groups.length > 1 && group !== lastGroup) rows.push(el('div', { class: 'ev-group label xs', role: 'heading', 'aria-level': '2', text: group }));
      lastGroup = group;
      var hasTickets = e.valid || e.scanned;
      var bare = !hasTickets && !(e.platforms && e.platforms.length); // phones show "No sources yet" once, not twice
      rows.push(el('a', { class: 'ev-row' + (st[2] === 0 ? ' live' : '') + (st[2] >= 3 ? ' past' : '') + (bare ? ' bare' : ''), href: '#/event/' + e.id }, [
        el('div', { class: 'ev-name' }, [el('strong', { text: e.name }), el('span', { class: 'sub', text: e.venue || 'No venue set' })]),
        el('div', { class: 'ev-when' }, [el('span', { text: e.startsAt ? fmtDate(e.startsAt) : 'No date' }), e.startsAt ? el('span', { class: 'sub', text: fmtDoors(e.startsAt) }) : null]),
        el('div', { class: 'ev-status' }, [el('span', { class: 'tag ' + st[0], text: st[1] })]),
        el('div', { class: 'ev-in' }, hasTickets ? [
          el('span', { class: 'ev-count' }, [el('b', { text: n(e.scanned) }), ' / ' + n(e.valid) + ' in']),
          meter(e.scanned, e.valid),
        ] : [el('span', { class: 'sub', text: 'No tickets yet' })]),
        el('div', { class: 'ev-src sub', text: platformsLine(e.platforms) }),
      ]));
    });
    var listBox = el('div', { class: 'ev-list' }, [
      el('div', { class: 'ev-row ev-head', 'aria-hidden': 'true' }, ['Event', 'Date', 'Status', 'Checked in', 'Sold on'].map(function (h) { return el('span', { class: 'label xs', text: h }); })),
    ].concat(rows));
    main.appendChild(listBox);
    if (pageChangeFresh()) stagger(listBox.querySelectorAll('.ev-row:not(.ev-head), .ev-group'));
  }

  function eventForm(ev, onSaved) {
    var name = el('input', { required: true, maxlength: 120, value: ev ? ev.name : '', placeholder: 'MOJI & FRQNC Present: LIGHTLEAK' });
    var venue = el('input', { maxlength: 120, value: ev ? ev.venue || '' : '', placeholder: 'Edge Miami' });
    var when = el('input', { type: 'datetime-local', value: ev ? toLocalInput(ev.startsAt) : '' });
    var pin = el('input', { inputmode: 'numeric', pattern: '[0-9]*', minlength: 4, maxlength: 12, required: !ev, placeholder: ev ? 'Leave empty to keep it' : '4 to 12 digits', autocomplete: 'off' });
    var archived = el('input', { type: 'checkbox', checked: ev && ev.archived });
    var err = el('p', { class: 'error' });
    var submit = el('button', { class: 'primary', type: 'submit', text: ev ? 'Save' : 'Create event' });
    var parts = [
      el('div', { class: 'form-grid' }, [field('Event name', name), field('Venue', venue)]),
      el('div', { class: 'form-grid' }, [field('Doors open', when), field(ev ? 'New door PIN' : 'Door PIN', pin, 'Door staff type this to sign in. Avoid 0000 or 1234.')]),
    ];
    if (ev) parts.push(el('label', { class: 'check' }, [archived, 'Archived: hidden from the door app, and API syncing stops']));
    parts.push(el('div', { class: 'head-actions' }, [submit]));
    parts.push(err);
    return el('form', { onsubmit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      busy(submit, true);
      try {
        var body = { name: name.value, venue: venue.value, startsAt: fromLocalInput(when.value) };
        if (pin.value) body.doorPin = pin.value;
        if (ev) body.archived = archived.checked;
        var res = ev ? await api('PATCH', '/api/admin/events/' + ev.id, body) : await api('POST', '/api/admin/events', body);
        onSaved(res.event);
      } catch (ex) { err.textContent = ex.message; }
      busy(submit, false);
    } }, parts);
  }

  function newEvent() {
    var close = modal('New event', eventForm(null, function (ev) { close(); location.hash = '#/event/' + ev.id; }));
  }

  // ------------------------------------------------------------------ event page
  // One event, four tabs with their own addresses: Overview (check-in, what to fix, where tickets were sold),
  // Guests (the ticket list), Scans (the scan log) and Door (PIN, door phones, test a code).

  var view = null; // the event on screen
  var EVENT_TABS = [['overview', 'Overview'], ['guests', 'Guests'], ['scans', 'Scans'], ['door', 'Door']];
  function tabHref(id, tab) { return '#/event/' + id + (tab && tab !== 'overview' ? '/' + tab : ''); }

  // 0000, 1234, 2580-style patterns, repeated pairs and years: the first things anyone tries.
  function weakPin(p) {
    p = String(p || '');
    if (!/^\d+$/.test(p)) return false;
    if (/^(\d)\1+$/.test(p) || /^(\d\d)\1+$/.test(p) || /^(19|20)\d\d$/.test(p)) return true;
    return '01234567890123456789'.indexOf(p) !== -1 || '98765432109876543210'.indexOf(p) !== -1 || p === '2580' || p === '0852';
  }

  function activePhones(data) {
    return (data.devices || []).filter(function (d) { return !d.revoked && d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 15 * 60e3; }).length;
  }

  async function renderEvent(id, tab) {
    var data;
    try { data = await api('GET', '/api/admin/events/' + id); } catch (e) { if (e.status === 404) location.hash = ''; return; }
    var main = shell(1);
    var head = el('div', { class: 'page-head ev-top' });
    var mark = el('div', { class: 'tabs-mark', 'aria-hidden': 'true' });
    var bar = el('nav', { class: 'ev-tabs no-anim', 'aria-label': 'Event sections' });
    var ink = el('span', { class: 'ink', 'aria-hidden': 'true' });
    EVENT_TABS.forEach(function (t) { bar.appendChild(el('a', { href: tabHref(id, t[0]), 'data-tab': t[0], text: t[1] })); });
    bar.appendChild(ink);
    var content = el('div', { class: 'tab-body' });
    [head, mark, bar, content].forEach(function (x) { main.appendChild(x); });
    view = { id: id, data: data, tab: null, root: main, head: head, mark: mark, bar: bar, ink: ink, content: content, prev: null, filter: '' };
    drawHead();
    switchTab(tab, true);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInk);
    requestAnimationFrame(function () { moveInk(); requestAnimationFrame(function () { bar.classList.remove('no-anim'); }); });
    refreshTimer = setInterval(function () { refreshEvent(false); }, 10000);
  }

  function drawHead() {
    var v = view;
    var ev = v.data.event;
    var st = eventStatus(Object.assign({}, ev, { sources: v.data.sources.length }));
    v.head.textContent = '';
    v.head.appendChild(el('div', { class: 'ph-bar' }, [
      el('nav', { class: 'crumb', 'aria-label': 'Breadcrumb' }, [el('a', { href: '#/', text: 'Events' })]),
      el('button', { type: 'button', class: 'sm', text: 'Edit event', onclick: function () {
        var close = modal('Edit event', eventForm(ev, function () { close(); toast('Saved'); refreshEvent(true); }));
      } }),
    ]));
    v.head.appendChild(el('h1', { text: ev.name }));
    v.head.appendChild(el('div', { class: 'ph-meta' }, [
      el('span', { class: 'tag ' + st[0], text: st[1] }),
      el('span', { text: [ev.venue, ev.startsAt ? fmtDate(ev.startsAt) : 'No date set', fmtDoors(ev.startsAt)].filter(Boolean).join(' · ') }),
    ]));
  }

  function switchTab(tab, first) {
    var v = view;
    if (!v) return;
    var order = EVENT_TABS.map(function (t) { return t[0]; });
    if (order.indexOf(tab) === -1) tab = 'overview';
    if (v.tab === tab && !first) return;
    var dir = order.indexOf(tab) > order.indexOf(v.tab) ? 'in-r' : 'in-l';
    v.tab = tab;
    Array.prototype.forEach.call(v.bar.querySelectorAll('a[data-tab]'), function (a) {
      var on = a.getAttribute('data-tab') === tab;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    moveInk();
    // Coming from further down the page, the new tab starts right under the tab bar.
    if (!first) {
      var top = v.mark.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(v.bar).top) || 0);
      if (window.scrollY > top) window.scrollTo(0, top);
    }
    v.content.textContent = '';
    v.content.className = 'tab-body' + (first || reduceMotion ? '' : ' ' + dir);
    ({ overview: renderOverview, guests: guestsTab, scans: scansTab, door: doorTab })[tab](v.content, v.data, { fresh: true });
  }

  // The underline slides to the chosen tab.
  function moveInk() {
    var v = view;
    if (!v) return;
    var a = v.bar.querySelector('a.active');
    if (!a) return;
    v.ink.style.width = a.offsetWidth + 'px';
    v.ink.style.transform = 'translateX(' + a.offsetLeft + 'px)';
  }
  window.addEventListener('resize', function () {
    if (!view) return;
    view.bar.classList.add('no-anim');
    moveInk();
    requestAnimationFrame(function () { if (view) view.bar.classList.remove('no-anim'); });
  });

  // Fresh numbers every 10 seconds, and right after a change. The Overview updates in place (numbers glide);
  // after a change (force) the tab on screen redraws without replaying its entrance.
  async function refreshEvent(force) {
    var v = view;
    if (!v || (!force && (document.hidden || document.querySelector('.modal-back')))) return;
    var fresh;
    try { fresh = await api('GET', '/api/admin/events/' + v.id); } catch (e) { return; }
    if (view !== v) return;
    v.data = fresh;
    drawHead();
    if (v.tab === 'overview') renderOverview(v.content, fresh, { fresh: false });
    else if (force) ({ guests: guestsTab, scans: scansTab, door: doorTab })[v.tab](v.content, fresh, { fresh: false });
  }

  // "Headline\ndetail" (new) or "message — hint" (older) into [headline, detail].
  function splitMsg(m) {
    m = String(m || '');
    var i = m.indexOf('\n');
    if (i !== -1) return [m.slice(0, i), m.slice(i + 1)];
    var j = m.indexOf(' — ');
    if (j !== -1) return [m.slice(0, j), m.slice(j + 3)];
    return [m, ''];
  }

  function isStale(s) { return s.kind === 'file' && s.lastSyncAt && Date.now() - new Date(s.lastSyncAt).getTime() > STALE_MS; }

  // What needs doing before doors, each with the button that fixes it.
  function problems(data) {
    var ev = data.event;
    var start = Date.parse(ev.startsAt);
    var over = !isNaN(start) && Date.now() > start + 10 * 3600e3;
    var out = [];
    if (!over && !ev.archived && weakPin(ev.doorPin)) {
      out.push({ text: 'Door PIN ' + ev.doorPin + ' is easy to guess. Anyone with the door link could try it.', action: ['Change PIN', function () { changePin(ev); }] });
    }
    data.sources.forEach(function (s) {
      var upload = '#/event/' + ev.id + '/upload/' + s.id;
      if (s.kind === 'api' && s.lastSyncOk === false) {
        out.push({ s: s, text: splitMsg(s.lastSyncMessage)[0] || 'The last sync failed.', action: ['Open settings', function () { editApiSource(ev, s); }] });
      } else if (s.lastSyncMessage && /safety check/.test(s.lastSyncMessage)) {
        out.push({ s: s, text: 'Some tickets disappeared from ' + s.platformName + '. Voiding them is on hold until you confirm.', action: ['Apply voids', async function (e) {
          var btn = e.currentTarget;
          if (await ask('Void the missing tickets?', 'Every ticket that is no longer on ' + s.platformName + ' gets voided. Door phones show NOT VALID if someone scans one.', 'Void them', true)) runSync(s, { force: true }, btn);
        }] });
      } else if (s.kind === 'file' && !over) {
        if (!s.lastSyncAt) out.push({ s: s, text: 'No file uploaded yet.', action: ['Upload file', upload] });
        else if (isStale(s)) out.push({ s: s, text: 'List uploaded ' + ago(s.lastSyncAt) + '. Upload a fresh export before doors so refunds and resales get caught.', action: ['Upload file', upload] });
      }
    });
    var flags = data.stats.flags || {};
    if (flags.double_entry) out.push({ text: flags.double_entry + (flags.double_entry === 1 ? ' ticket' : ' tickets') + ' got in twice while a phone was offline.', action: ['Show', showFlagged] });
    if (flags.voided_after_scan) out.push({ text: flags.voided_after_scan + (flags.voided_after_scan === 1 ? ' ticket was' : ' tickets were') + ' refunded, resold or transferred after the scan.', action: ['Show', showFlagged] });
    return out;
  }

  function showFlagged() {
    if (!view) return;
    view.filter = 'flagged';
    location.hash = tabHref(view.id, 'guests');
  }

  function renderOverview(box, data, opts) {
    var fresh = opts && opts.fresh;
    var st = data.stats;
    var rows = st.rows || {};
    var ev = data.event;
    var prev = view && view.prev; // what's on screen now: a refresh glides from there
    box.textContent = '';
    var pct = st.valid ? Math.round(100 * st.scanned / st.valid) : 0;
    var phones = activePhones(data);
    function fact(num, text) { return el('span', null, [el('b', { text: num }), text]); }
    // Nothing sold or scanned yet: a wall of zeros says nothing, so the page opens on "Where tickets were sold".
    if (st.valid || st.scanned || rows.all || st.lastScanAt) {
      var count = el('b', { text: n(prev ? prev.scanned : 0), 'data-v': String(prev ? prev.scanned : 0) });
      var pctNode = el('b', { text: (prev ? prev.pct : 0) + '%' });
      box.appendChild(el('section', { class: 'tally', 'aria-label': 'Check-in' }, [
        el('div', { class: 'tally-top' }, [
          el('div', { class: 'tally-count' }, [count, el('span', { class: 'in', text: ' in' }), el('span', { class: 'of', text: ' / ' + n(st.valid) })]),
          el('div', { class: 'tally-pct' }, [pctNode, ' checked in']),
        ]),
        meter(st.scanned, st.valid, 'big', prev ? prev.pct : 0),
        el('div', { class: 'tally-facts' }, [
          fact(n(Math.max(0, st.valid - st.scanned)), ' not here yet'),
          fact(n(rows.void), ' void'),
          st.lastScanAt ? el('span', null, ['Last scan ', el('b', { text: fmtClock(st.lastScanAt) })]) : el('span', { text: 'No scans yet' }),
          el('a', { class: 'fact-link', href: tabHref(ev.id, 'door') }, phones ? [el('b', { text: n(phones) }), phones === 1 ? ' door phone active' : ' door phones active'] : ['No door phones active']),
        ]),
      ]));
      countTo(count, st.scanned, fresh ? 900 : 600);
      if (!reduceMotion && (!prev || prev.pct !== pct)) {
        var from = prev ? prev.pct : 0;
        var t0 = null;
        requestAnimationFrame(function tick(t) {
          if (t0 === null) t0 = t;
          var k = Math.min(1, (t - t0) / 800);
          pctNode.textContent = Math.round(from + (pct - from) * (1 - Math.pow(1 - k, 3))) + '%';
          if (k < 1 && pctNode.isConnected) requestAnimationFrame(tick);
        });
      } else pctNode.textContent = pct + '%';
    }
    if (view) view.prev = { scanned: st.scanned, pct: pct };

    var issues = problems(data);
    if (issues.length) {
      box.appendChild(el('section', { class: 'attention', 'aria-label': 'Needs attention' }, [
        el('h2', { text: issues.length === 1 ? '1 thing to fix' : issues.length + ' things to fix' }),
        el('ul', null, issues.map(function (it) {
          var a = it.action;
          var btn = typeof a[1] === 'string' ? el('a', { class: 'btn sm', href: a[1], text: a[0] }) : el('button', { type: 'button', class: 'sm', text: a[0], onclick: a[1] });
          return el('li', null, [it.s ? el('span', { class: 'badge', text: it.s.platformName }) : el('span', { class: 'tag warn', text: 'Check' }), el('span', { class: 'att-text', text: it.text }), btn]);
        })),
      ]));
    }

    var none = !data.sources.length;
    box.appendChild(el('div', { class: 'section-head' }, [el('h2', { text: 'Where tickets were sold' }), none ? null : el('a', { class: 'btn sm', href: '#/event/' + ev.id + '/add', text: 'Add source' })]));
    var byId = {};
    (st.bySource || []).forEach(function (s) { byId[s.source_id] = s; });
    if (none) {
      box.appendChild(el('div', { class: 'empty-card gap-bottom' }, [
        el('p', { text: 'Add every platform this event sold on: Shotgun, DICE, RA, Bucket Listers, Eventbrite, Posh or any CSV export. Door phones scan all of them.' }),
        el('a', { class: 'btn primary', href: '#/event/' + ev.id + '/add', text: 'Add source' }),
      ]));
      return;
    }
    var list = el('div', { class: 'src-list' }, data.sources.map(function (s) { return sourceRow(ev, s, byId[s.id] || { valid: 0, scanned: 0, void: 0 }); }));
    box.appendChild(list);
    if (fresh && !(view && view.prevSrc)) stagger(list.children);
    if (view) { view.prevSrc = {}; data.sources.forEach(function (s) { view.prevSrc[s.id] = pctOf(byId[s.id]); }); }
  }

  // The custom label without a repeated platform name ("Shotgun · Riva Starr @ Sable" → "Riva Starr @ Sable").
  function sourceLabel(s) {
    var label = String(s.label || '').trim();
    if (!label || label === s.platformName || label === s.platformName + ' (file)') return '';
    var esc = s.platformName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return label.replace(new RegExp('^' + esc + '\\s*[·:|\\-–—]\\s*', 'i'), '') || label;
  }

  var HOW = { api: 'Pulled by API', file: 'File upload', webhook: 'Webhook' };
  var HOW_SHORT = { api: 'API', file: 'File', webhook: 'Webhook' };

  function sourceState(s) {
    if (s.kind === 'api') {
      if (s.syncing) return ['idle', 'Syncing…'];
      if (s.lastSyncOk === false) return ['bad', 'Sync failed ' + ago(s.lastSyncAt)];
      if (s.lastSyncAt) return ['', 'Synced ' + fmtClock(s.lastSyncAt)];
      return ['idle', 'Not synced yet'];
    }
    if (s.kind === 'webhook') {
      if (s.lastSyncOk === false) return ['bad', 'Last webhook had no tickets'];
      if (s.lastSyncAt) return ['', 'Last sale ' + fmtClock(s.lastSyncAt)];
      return ['idle', 'Waiting for the first sale'];
    }
    if (!s.lastSyncAt) return ['warn', 'No file uploaded yet'];
    return isStale(s) ? ['warn', 'Uploaded ' + ago(s.lastSyncAt)] : ['', 'Uploaded ' + fmtClock(s.lastSyncAt)];
  }

  // The one thing you do most with each kind of source.
  function primaryAction(ev, s) {
    if (s.kind === 'api') return el('button', { type: 'button', class: 'sm', text: 'Sync now', onclick: function (e) { runSync(s, {}, e.currentTarget); } });
    if (s.kind === 'webhook') return el('button', { type: 'button', class: 'sm', text: 'Setup', 'aria-label': 'Webhook setup', onclick: function () { webhookSetup(ev, s); } });
    var due = !s.lastSyncAt || isStale(s);
    return el('a', { class: 'btn sm' + (due ? ' primary' : ''), href: '#/event/' + ev.id + '/upload/' + s.id, text: s.lastSyncAt ? 'Upload new file' : 'Upload file' });
  }

  function pctOf(c) { return c && c.valid ? Math.min(100, Math.round(100 * c.scanned / c.valid)) : 0; }
  function srcNums(counts, cls, fromPct) {
    return el('span', { class: 'src-nums' + (cls ? ' ' + cls : '') }, [
      el('span', null, [el('b', { text: n(counts.valid) }), ' valid']),
      el('span', null, [el('b', { text: n(counts.scanned) }), ' in']),
      el('span', { class: counts.void ? '' : 'zero' }, [el('b', { text: n(counts.void) }), ' void']),
      meter(counts.scanned, counts.valid, null, fromPct),
    ]);
  }

  // A row says what the source is and how it's doing; tapping it opens everything else.
  function sourceRow(ev, s, counts) {
    var label = sourceLabel(s);
    var state = sourceState(s);
    var failed = s.kind === 'api' && s.lastSyncOk === false;
    var open = el('button', { type: 'button', class: 'src-open', 'aria-label': 'Manage ' + s.platformName + (label ? ', ' + label : ''), onclick: function () { sourceSheet(ev, s, counts); } }, [
      el('span', { class: 'src-id' }, [
        el('span', { class: 'badge', text: s.platformName }),
        el('span', { class: 'src-name' }, [
          el('strong', { text: label || HOW[s.kind] }),
          el('span', { class: 'src-state' }, [el('span', { class: 'dot ' + state[0] }), el('span', { text: (label ? HOW_SHORT[s.kind] + ' · ' : '') + state[1] })]),
        ]),
      ]),
      srcNums(counts, null, view && view.prevSrc ? view.prevSrc[s.id] : 0), // a refresh doesn't restart the bar
      el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }),
    ]);
    return el('div', { class: 'src-row' + (failed ? ' failed' : '') }, [open, el('div', { class: 'src-actions' }, [primaryAction(ev, s)])]);
  }

  // Everything for one source in one place: state, numbers, what you can do, and Remove at the bottom.
  function sourceSheet(ev, s, counts) {
    var label = sourceLabel(s);
    var state = sourceState(s);
    var failed = s.kind === 'api' && s.lastSyncOk === false;
    var body = el('div', { class: 'src-sheet' });
    var close = modal(s.platformName + (label ? ' · ' + label : ''), body);
    function then(fn) { return function () { close(); later(140, fn); }; }
    body.appendChild(el('p', { class: 'src-sheet-state' + (failed ? ' bad' : '') }, [el('span', { class: 'dot ' + state[0] }), el('span', { text: state[1] }), el('span', { class: 'muted', text: ' · ' + HOW[s.kind] })]));
    if (failed) {
      var msg = splitMsg(s.lastSyncMessage);
      body.appendChild(el('div', { class: 'callout warn' }, [el('p', { class: 'lead', text: msg[0] }), msg[1] ? el('p', { class: 'detail', text: msg[1] }) : null]));
    }
    body.appendChild(srcNums(counts, 'big'));
    var acts = el('div', { class: 'sheet-actions' });
    if (s.kind === 'api') {
      acts.appendChild(el('button', { type: 'button', class: 'primary lg', text: 'Sync now', onclick: async function (e) { await runSync(s, {}, e.currentTarget); close(); } }));
      acts.appendChild(el('button', { type: 'button', class: 'lg', text: 'Settings', onclick: then(function () { editApiSource(ev, s); }) }));
      if (s.platform === 'shotgun') acts.appendChild(el('button', { type: 'button', class: 'lg', text: 'Full re-sync', onclick: async function (e) { await runSync(s, { full: true }, e.currentTarget); close(); } }));
    } else if (s.kind === 'file') {
      acts.appendChild(el('a', { class: 'btn primary lg', href: '#/event/' + ev.id + '/upload/' + s.id, text: s.lastSyncAt ? 'Upload new file' : 'Upload file', onclick: close }));
    } else {
      acts.appendChild(el('button', { type: 'button', class: 'primary lg', text: 'Webhook setup', onclick: then(function () { webhookSetup(ev, s); }) }));
      acts.appendChild(el('a', { class: 'btn lg', href: '#/event/' + ev.id + '/upload/' + s.id, text: 'Upload file', onclick: close }));
    }
    body.appendChild(acts);
    body.appendChild(el('div', { class: 'sheet-danger' }, [
      el('p', { text: 'Removing a source voids its tickets: door phones show NOT VALID if one is scanned. The scan log keeps every check-in.' }),
      el('button', { type: 'button', class: 'danger', text: 'Remove source', onclick: async function () {
        var what = counts.valid ? plural(counts.valid, 'ticket gets', 'tickets get') + ' voided.' : 'It has no tickets.';
        if (!(await ask('Remove ' + s.platformName + (label ? ' · ' + label : '') + '?', what + ' The scan log keeps every check-in.', 'Remove', true))) return;
        await api('DELETE', '/api/admin/sources/' + s.id);
        close();
        toast(s.platformName + ' removed');
        refreshEvent(true);
      } }),
    ]));
  }

  async function runSync(s, opts, btn) {
    busy(btn, true, 'Syncing…');
    try {
      var res = await api('POST', '/api/admin/sources/' + s.id + '/sync', opts);
      toast(res.ok ? s.platformName + ': ' + res.message : s.platformName + ' sync failed. ' + splitMsg(res.message)[0], 6000);
    } catch (e) { toast(e.message, 6000); }
    busy(btn, false);
    if (view) await refreshEvent(true); else route();
  }

  // ------------------------------------------------------------------ add a source

  var HELP = {
    shotgun: {
      api: ['In Shotgun Backstage go to Settings → Integrations → Shotgun APIs and click Connect.', 'Copy the Organizer ID, then click Issue token and copy the token.', 'Open the event in Backstage. Its ID is the number at the end of the address (backstage.shotgun.live/events/123456). Pasting the whole address works too.', 'Transfers cancel the old QR and issue a new one, so this pulls changes every minute, and right away when the door scans a code it doesn\'t know.'],
      file: ['Export the attendee list from Smartboard as CSV with the scan code column.'],
    },
    dice: {
      api: ['In MIO click your company name (bottom left) → Manage → Access tokens.', 'Click the token under Ticket holder API access tokens to copy it, and paste it below. Not the Event API token.', 'Click Load my DICE events and pick the show. The event box fills itself.', 'DICE keeps the ticket code behind restricted access. If the first sync says the fields are restricted, ask your DICE rep to enable restricted fields (ticket code) on your Ticket Holders API token for door access control.', 'Fans see their QR in the DICE app about 2 hours before the event. Scan one in the door app with Test mode on (More → Test mode) before doors. DICE calls its QR "animated": if it doesn\'t match, check DICE guests in with Search.'],
      file: ['Ask your DICE rep for the barcode export for this event (the file they give venue scanning systems) and upload it here.', 'Only have a list of names? Upload it with the QR column set to "None in this file". Staff check those guests in by name. Remove it once you have DICE codes, or people count twice.'],
    },
    ra: {
      file: ['In RA Pro open the event → Audience Data → Export Audience.', 'Keep the fields RA selects by default (they include the barcode) and export as CSV.', 'Upload it here. Re-export and upload again right before doors: resales cancel the old barcode and issue a new one.', 'RA prints an 8-digit barcode ID under each QR. If the export\'s barcode column holds that number, door staff can type it when a screen won\'t scan (check with a test ticket).'],
    },
    bucketlisters: {
      file: ['Bucket Listers has no public API. Ask your partner contact for a CSV of the QR values for your event before doors (or email partner@bucketlisters.com).', 'If they can only send names and emails, upload that with the QR column set to "None in this file". Staff find those guests with Search and tap Admit. Pick the quantity column if one row covers several tickets.'],
    },
    eventbrite: {
      api: ['In Eventbrite go to Account Settings → Developer Links → API Keys and copy your private token.', 'The event ID is the number at the end of the event URL.'],
      file: ['Export the attendee report as CSV including the Barcode column.'],
    },
    posh: {
      webhook: ['Add this source, then copy the webhook address it shows you.', 'In Posh go to Settings → API Webhooks, paste the address and select Order Created.', 'Buy one test ticket. The payload shows up here so you can point at the QR field once.', 'Posh doesn\'t send refunds by webhook: upload the attendee CSV export right before doors to void refunds.'],
      file: ['Export the event\'s attendee/orders CSV from Posh and upload it.', 'If it has no QR column, it still works as a name-only list: staff check those guests in by name.'],
    },
    other: {
      file: ['Any CSV with one row per ticket and a column holding the QR / barcode value works.', 'A list of names without codes works too (guest list, comps): set the QR column to "None in this file" and staff check them in by name.'],
      webhook: ['Point any platform that can POST JSON at the address shown after adding.'],
    },
  };

  function kindBlurb(platform, kind) {
    var name = platformName(platform);
    if (kind === 'api') return 'We pull new sales every ' + (PLATFORMS[platform].every === 1 ? 'minute' : PLATFORMS[platform].every + ' minutes') + '.';
    if (kind === 'file') return 'You export a CSV from ' + (platform === 'other' ? 'any platform' : name) + ' and upload it.';
    return (platform === 'other' ? 'The platform' : name) + ' sends each sale the moment it happens.';
  }

  function afterNotes(platform, kind) {
    var name = platformName(platform);
    if (kind === 'api') return ['Tickets show up in the Tickets tab within ' + (PLATFORMS[platform].every === 1 ? 'a minute' : PLATFORMS[platform].every + ' minutes') + '.', 'Door phones download the list on their next sync.', 'Refunds and transfers on ' + name + ' void the ticket automatically.'];
    if (kind === 'file') return ['Upload a fresh export right before doors: refunds and resales only show up when you upload again.', 'Door phones download the list on their next sync.', 'A full-list upload voids tickets that are missing from the new file.'];
    return ['Each sale shows up the moment it arrives.', 'You point at the QR field once, using your first test sale.', platform === 'posh' ? 'Posh doesn\'t send refunds: upload its CSV before doors to void them.' : 'Refunds only arrive if the platform sends them.'];
  }

  async function renderAddSource(eventId) {
    var data;
    try { data = await api('GET', '/api/admin/events/' + eventId); } catch (e) { if (e.status === 404) location.hash = ''; return; }
    var ev = data.event;
    var added = {};
    data.sources.forEach(function (s) { added[s.platform] = true; });
    var state = { platform: null, kind: null };
    var main = shell(2);
    var head = pageHead([{ text: 'Events', href: '#/' }, { text: ev.name, href: '#/event/' + ev.id }, { text: 'Sources' }], 'Add a ticket source', [el('a', { class: 'btn', href: '#/event/' + ev.id, text: 'Cancel' })]);
    head.querySelector('.head-actions').classList.add('back-only'); // phones use the back link above the title
    main.appendChild(head);
    var left = el('div');
    var right = el('div', { class: 'side-card' });
    main.appendChild(el('div', { class: 'split' }, [left, right]));

    function step(num, title, body) {
      return el('div', { class: 'step' }, [el('div', { class: 'step-n', text: String(num) }), el('div', null, [el('h2', { text: title }), body])]);
    }

    // changed: 'platform' or 'kind', so only the steps that changed slide in (step 1 never jumps).
    function draw(changed) {
      left.textContent = '';
      left.appendChild(step(1, 'Pick the platform', el('div', { class: 'pick-grid' }, Object.keys(PLATFORMS).map(function (p) {
        var on = state.platform === p;
        return el('button', { type: 'button', class: 'pick' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: function () { var was = state.platform; state.platform = p; state.kind = PLATFORMS[p].kinds[0]; draw(was === p ? null : 'platform'); } }, [
          el('span', { class: 'pn', text: PLATFORMS[p].name }),
          on ? el('span', { class: 'label', text: 'Selected' }) : added[p] ? el('span', { class: 'label done', text: '✓ Added' }) : null,
        ]);
      }))));
      right.textContent = '';
      right.appendChild(el('div', { class: 'label sm', text: 'After you add it' }));
      if (!state.platform) {
        right.appendChild(el('p', { text: 'Add one source per platform you sold on. Each door phone scans all of them.' }));
        return;
      }
      var p = state.platform;
      var kinds = PLATFORMS[p].kinds;
      if (kinds.length > 1) left.appendChild(step(2, 'How tickets get in', el('div', { class: 'pick-grid' }, kinds.map(function (k, i) {
        var on = state.kind === k;
        return el('button', { type: 'button', class: 'pick kind' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: function () { var was = state.kind; state.kind = k; draw(was === k ? null : 'kind'); } }, [
          el('div', { class: 'top' }, [el('span', { text: KIND_NAMES[k] }), i === 0 && kinds.length > 1 ? el('span', { class: 'label', text: 'Recommended' }) : null]),
          el('div', { class: 'd', text: kindBlurb(p, k) }),
        ]);
      }))));
      var title = state.kind === 'api' ? 'Connect ' + PLATFORMS[p].name : state.kind === 'file' ? 'Upload from ' + PLATFORMS[p].name : 'Webhook from ' + PLATFORMS[p].name;
      left.appendChild(step(kinds.length > 1 ? 3 : 2, title, sourceForm(ev, p, state.kind, null)));
      afterNotes(p, state.kind).forEach(function (t) { right.appendChild(el('p', { text: t })); });
      if (changed) stagger(Array.prototype.slice.call(left.children, changed === 'platform' ? 1 : left.children.length - 1).concat(Array.prototype.slice.call(right.children, 1)));
    }
    draw();
  }

  // Fields for one source. existing = edit mode (inside a modal).
  function sourceForm(ev, platform, kind, existing, close) {
    var label = el('input', { maxlength: 80, value: existing ? existing.label : '', placeholder: PLATFORMS[platform].name + (kind === 'file' ? ' (file)' : '') });
    var err = el('p', { class: 'error' });
    var result = el('div');
    var inputs = {};
    var parts = [];
    var help = (HELP[platform] || {})[kind] || [];
    if (help.length && !existing) parts.push(el('ol', { class: 'howto' }, help.map(function (h) { return el('li', { text: h }); })));
    var settings = existing ? existing.settings || {} : {};
    function secret() { return el('input', { type: 'password', value: settings.token || '', required: !existing, autocomplete: 'off', placeholder: existing ? 'Leave as is to keep the saved token' : '' }); }
    if (kind === 'api') {
      if (platform === 'shotgun') {
        inputs.organizerId = el('input', { value: settings.organizerId || '', required: true, inputmode: 'numeric' });
        inputs.token = secret();
        inputs.eventId = el('input', { value: settings.eventId || '', required: true, inputmode: 'numeric' });
        inputs.includeCohosted = el('input', { type: 'checkbox', checked: !!settings.includeCohosted });
        parts.push(el('div', { class: 'form-grid three' }, [field('Organizer ID', inputs.organizerId), field('API token', inputs.token), field('Shotgun event ID', inputs.eventId)]));
        parts.push(el('label', { class: 'check' }, [inputs.includeCohosted, 'I\'m a co-host of this Shotgun event (not the main organizer)']));
      } else if (platform === 'dice') {
        inputs.token = secret();
        inputs.eventId = el('input', { value: settings.eventId || '', required: true, placeholder: 'Pick below or paste the DICE event ID' });
        var pick = el('select', { hidden: true });
        var loadBtn = el('button', { type: 'button', class: 'sm', text: 'Load my DICE events', onclick: async function () {
          loadBtn.disabled = true; err.textContent = '';
          try {
            var res = await api('POST', '/api/admin/dice/events', { token: inputs.token.value, sourceId: existing ? existing.id : undefined });
            pick.textContent = '';
            pick.appendChild(el('option', { value: '', text: 'Choose an event (' + res.events.length + ')' }));
            res.events.forEach(function (e) { pick.appendChild(el('option', { value: e.id, text: e.name + (e.startsAt ? ' · ' + fmtDate(e.startsAt) : '') })); });
            pick.hidden = false;
          } catch (ex) { err.textContent = ex.message; }
          loadBtn.disabled = false;
        } });
        pick.addEventListener('change', function () { if (pick.value) { inputs.eventId.value = pick.value; if (!label.value) label.value = 'DICE · ' + pick.options[pick.selectedIndex].text.split(' · ')[0]; } });
        parts.push(el('div', { class: 'form-grid' }, [field('Ticket holder API token', inputs.token), field('DICE event ID', inputs.eventId)]));
        parts.push(el('div', { class: 'toolbar-row' }, [loadBtn, pick]));
      } else if (platform === 'eventbrite') {
        inputs.token = secret();
        inputs.eventId = el('input', { value: settings.eventId || '', required: true, inputmode: 'numeric' });
        parts.push(el('div', { class: 'form-grid' }, [field('Private token', inputs.token), field('Eventbrite event ID', inputs.eventId)]));
      }
    }
    parts.push(el('div', { class: 'form-grid' }, [field('Label (optional)', label)]));
    var submit = el('button', { class: 'primary lg', type: 'submit', text: existing ? 'Save' : 'Add ' + PLATFORMS[platform].name + ' source' });
    parts.push(el('div', { class: 'head-actions' }, [submit]));
    parts.push(result, err);
    return el('form', { onsubmit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      result.textContent = '';
      busy(submit, true, existing ? 'Saving…' : kind === 'api' ? 'Connecting…' : 'Adding…');
      var config = {};
      Object.keys(inputs).forEach(function (k) { config[k] = inputs[k].type === 'checkbox' ? inputs[k].checked : inputs[k].value; });
      if (platform === 'dice' && config.eventId && /^[A-Za-z0-9_\-]{30,}$/.test(config.eventId.trim())) {
        err.textContent = 'That looks like an access token, not a DICE event ID. Click Load my DICE events and pick the show.';
        busy(submit, false);
        return;
      }
      if ((platform === 'shotgun' || platform === 'eventbrite') && config.eventId && !/^\s*\d+\s*$/.test(config.eventId)) {
        var runs = String(config.eventId).match(/\d{4,}/g);
        if (runs) { config.eventId = runs[runs.length - 1]; inputs.eventId.value = config.eventId; }
      }
      try {
        if (existing) {
          await api('PATCH', '/api/admin/sources/' + existing.id, { label: label.value, config: config });
          if (close) close();
          toast('Saved');
          if (view) refreshEvent(true); else route();
          return;
        }
        var res = await api('POST', '/api/admin/events/' + ev.id + '/sources', { platform: platform, kind: kind, label: label.value, config: config });
        if (kind === 'file') { location.hash = '#/event/' + ev.id + '/upload/' + res.source.id; return; }
        if (kind === 'webhook') { location.hash = '#/event/' + ev.id; setTimeout(function () { webhookSetup(ev, res.source); }, 300); return; }
        busy(submit, false);
        if (res.sync && res.sync.ok) {
          var done = el('div', { class: 'connect-result' }, [el('span', { class: 'ok', text: '✓' }), 'Connected. ' + res.sync.message]);
          result.appendChild(done);
          done.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
          setTimeout(function () { location.hash = '#/event/' + ev.id; }, 1800);
        } else {
          err.textContent = 'Added, but the first sync failed: ' + (res.sync ? res.sync.message : 'unknown error');
          result.appendChild(el('a', { class: 'btn', href: '#/event/' + ev.id, text: 'Back to the event' }));
        }
      } catch (ex) { err.textContent = ex.message; busy(submit, false); }
    } }, parts);
  }

  function editApiSource(ev, s) {
    var body = el('div');
    var close = modal(s.platformName + ' settings', body);
    var help = (HELP[s.platform] || {}).api || [];
    // The fields come first. The steps fold away; they open by themselves when the last sync failed.
    if (help.length) body.appendChild(el('details', { class: 'howto-fold', open: s.lastSyncOk === false }, [
      el('summary', { text: 'Where to find these' }),
      el('ol', { class: 'howto' }, help.map(function (h) { return el('li', { text: h }); })),
    ]));
    body.appendChild(sourceForm(ev, s.platform, 'api', s, close));
  }

  // ------------------------------------------------------------------ CSV upload

  async function renderUpload(eventId, sourceId) {
    var data;
    try { data = await api('GET', '/api/admin/events/' + eventId); } catch (e) { if (e.status === 404) location.hash = ''; return; }
    var ev = data.event;
    var s = data.sources.filter(function (x) { return x.id === sourceId; })[0];
    if (!s) { location.hash = '#/event/' + eventId; return; }
    var main = shell(2);
    var headActions = el('div', { class: 'head-actions back-only' }, [el('a', { class: 'btn', href: '#/event/' + ev.id, text: 'Back to event' })]);
    var head = pageHead([{ text: 'Events', href: '#/' }, { text: ev.name, href: '#/event/' + ev.id }, { text: 'Sources' }], 'Upload file — ' + s.platformName, []);
    head.appendChild(headActions);
    main.appendChild(head);
    var body = el('div');
    main.appendChild(body);
    var input = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv' });
    var err = el('p', { class: 'error' });

    async function readFile(file) {
      err.textContent = '';
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) { err.textContent = 'That is an Excel file. Open it, save it as CSV, and upload the CSV.'; return; }
      var text = await file.text();
      try {
        var prev = await api('POST', '/api/admin/sources/' + s.id + '/import/preview', text, { contentType: 'text/csv; charset=utf-8' });
        renderMapping(file.name, prev, text);
      } catch (ex) { err.textContent = ex.message; }
    }
    input.addEventListener('change', function () { readFile(input.files[0]); });

    function chooser() {
      body.textContent = '';
      var zone = el('label', { class: 'dropzone' }, [
        input,
        el('div', { class: 'label sm', text: 'CSV export' }),
        el('div', { class: 'drop-text', text: 'Drop the file here, or' }),
        el('span', { class: 'btn primary', text: 'Choose a CSV file' }),
        el('small', { class: 'muted', text: 'Excel file? Open it and save it as CSV first.' }),
      ]);
      zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
      zone.addEventListener('drop', function (e) { e.preventDefault(); zone.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
      var help = (HELP[s.platform] || {}).file || [];
      var tips = el('div', { class: 'side-card' }, [el('div', { class: 'label sm', text: 'Where to get the file' })].concat(help.map(function (h) { return el('p', { text: h }); })));
      body.appendChild(el('div', { class: 'split' }, [el('div', null, [zone, err]), tips]));
    }

    function renderMapping(fileName, prev, text) {
      body.textContent = '';
      headActions.textContent = '';
      headActions.classList.remove('back-only');
      headActions.appendChild(el('div', { class: 'file-chip' }, [
        el('span', { class: 'f', text: fileName }),
        el('span', { class: 'label xs', text: n(prev.rowCount) + ' rows' }),
        el('button', { type: 'button', class: 'text-btn', text: 'Replace', onclick: function () { input.value = ''; input.click(); } }),
      ]));
      var mapping = Object.assign({}, prev.mapping);
      var FIELDS = [['code', 'QR code'], ['name', 'Name'], ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['ticketType', 'Ticket type'], ['quantity', 'Quantity'], ['status', 'Status'], ['extId', 'Ticket / order ID']];
      var banner = el('div', { class: 'alert' }, [el('span', { class: 'tag warn', text: 'No QR column' }), el('div', null, ['This file has no QR code column. Guests from it can only be checked in with ', el('strong', { text: 'Search' }), ' at the door. Scanning their tickets will show NOT FOUND. If ' + (s.platform === 'other' ? 'the platform' : s.platformName) + ' can export ticket codes, upload that file instead.'])]);
      var previewTable = el('table', { class: 'data preview' });
      var summaryLine = el('span', { class: 'muted' });
      var full = el('input', { type: 'radio', name: 'mode', value: 'replace', checked: true });
      var add = el('input', { type: 'radio', name: 'mode', value: 'merge' });
      var fullCard = el('label', { class: 'radio-card on' }, [full, el('span', { class: 'ring' }), el('div', null, [el('div', { class: 't', text: 'Full list' }), el('div', { class: 'd', text: 'Replace every ' + s.platformName + ' ticket from this source with this file. Tickets missing from the file are voided (refunds, resales).' })])]);
      var addCard = el('label', { class: 'radio-card' }, [add, el('span', { class: 'ring' }), el('div', null, [el('div', { class: 't', text: 'Add only' }), el('div', { class: 'd', text: 'Keep the tickets already here. Add or update the rows in this file.' })])]);
      [full, add].forEach(function (r) { r.addEventListener('change', function () { fullCard.classList.toggle('on', full.checked); addCard.classList.toggle('on', add.checked); }); });
      var result = el('p');
      var go = el('button', { class: 'primary lg', type: 'button', text: 'Import' });
      var picked = function (k) { return mapping[k] >= 0; };

      function sampleValues(i) {
        var seen = [];
        prev.sample.forEach(function (r) { var v = String(r[i] || '').trim(); if (v && seen.indexOf(v) === -1 && seen.length < 2) seen.push(v.slice(0, 28)); });
        return seen.join(', ') || '—';
      }
      var sampleCells = {};
      var mapRows = FIELDS.map(function (f) {
        var sel = el('select', null, [el('option', { value: '-1', text: f[0] === 'code' ? 'None in this file' : 'Not in this file' })].concat(prev.headers.map(function (h, i) { return el('option', { value: String(i), text: h }); })));
        sel.value = String(mapping[f[0]] === undefined ? -1 : mapping[f[0]]);
        sel.setAttribute('aria-label', f[1] + ' column');
        sampleCells[f[0]] = el('td', { class: 'sample' });
        function upd() {
          sel.className = f[0] === 'code' && !(mapping.code >= 0) ? 'none' : '';
          sampleCells[f[0]].textContent = mapping[f[0]] >= 0 ? sampleValues(mapping[f[0]]) : '';
        }
        sel.addEventListener('change', function () { mapping[f[0]] = Number(sel.value); upd(); refresh(); });
        upd();
        return el('tr', null, [el('td', { class: 'fld' }, [el('strong', { text: f[1] })]), el('td', { class: 'col' }, [sel]), sampleCells[f[0]]]);
      });

      function cell(row, k) { return mapping[k] >= 0 ? String(row[mapping[k]] || '').trim() : ''; }
      function drawPreview() {
        var nameOnly = !picked('code');
        var cols = (nameOnly ? [] : [['code', 'QR code']]).concat([['name', 'Name'], ['ticketType', 'Ticket type']]).concat(nameOnly && picked('quantity') ? [['quantity', 'Qty']] : []).concat([['status', 'Status']]);
        previewTable.textContent = '';
        previewTable.appendChild(el('thead', null, [el('tr', null, cols.map(function (c) { return el('th', { text: c[1] }); }))]));
        previewTable.appendChild(el('tbody', null, prev.sample.slice(0, 6).map(function (r) {
          return el('tr', null, cols.map(function (c) {
            if (c[0] === 'name') return el('td', { class: 'pv-name' }, [el('strong', { text: cell(r, 'name') || [cell(r, 'firstName'), cell(r, 'lastName')].filter(Boolean).join(' ') || cell(r, 'email') || '—' })]);
            if (c[0] === 'status') { var st = cell(r, 'status'); return el('td', { class: 'pv-status' }, [st && VOID_STATUS.test(st) ? el('span', { class: 'tag void', text: 'Void' }) : st || 'Valid']); }
            if (c[0] === 'code') return el('td', { class: 'email pv-code', text: cell(r, 'code') || '(no code: skipped)' });
            var v = cell(r, c[0]);
            return el('td', { class: 'pv-' + c[0] + (v ? '' : ' blank'), text: v || '—' });
          }));
        })));
      }

      var sumTimer = null;
      function refresh() {
        banner.hidden = picked('code');
        drawPreview();
        clearTimeout(sumTimer);
        sumTimer = setTimeout(async function () {
          try {
            var res = await api('POST', '/api/admin/sources/' + s.id + '/import/preview?mapping=' + encodeURIComponent(JSON.stringify(mapping)), text, { contentType: 'text/csv; charset=utf-8' });
            var sm = res.summary || { tickets: 0, valid: 0, void: 0 };
            go.textContent = 'Import ' + n(sm.tickets) + ' ticket' + (sm.tickets === 1 ? '' : 's');
            go.disabled = !sm.tickets;
            summaryLine.textContent = n(sm.valid) + ' valid' + (sm.void ? ' · ' + n(sm.void) + ' void' : '') + (sm.nameOnly ? ' · no QR codes' : '');
          } catch (ex) { summaryLine.textContent = ''; }
        }, 200);
      }

      go.addEventListener('click', async function () {
        if (!picked('code') && !['name', 'firstName', 'lastName', 'email'].some(picked)) { result.className = 'error'; result.textContent = 'Pick the QR code column, or a name column for a list without codes.'; return; }
        busy(go, true, 'Importing…');
        result.className = 'muted'; result.textContent = '';
        try {
          var mode = full.checked ? 'replace' : 'merge';
          var res = await api('POST', '/api/admin/sources/' + s.id + '/import?mode=' + mode + '&mapping=' + encodeURIComponent(JSON.stringify(mapping)), text, { contentType: 'text/csv; charset=utf-8' });
          busy(go, false);
          go.disabled = true;
          result.className = 'ok-text connect-result';
          result.textContent = '';
          result.appendChild(el('span', { class: 'ok', text: '✓' }));
          result.appendChild(document.createTextNode(res.message));
          setTimeout(function () { location.hash = '#/event/' + ev.id; }, 1500);
        } catch (ex) { busy(go, false); result.className = 'error'; result.textContent = ex.message; }
      });

      body.appendChild(banner);
      body.appendChild(el('div', { class: 'split even' }, [
        el('div', null, [
          el('div', { class: 'section-head' }, [el('h2', { text: 'Match the columns' })]),
          el('div', { class: 'table-wrap' }, [el('table', { class: 'data map' }, [
            el('thead', null, [el('tr', null, [el('th', { text: 'Field' }), el('th', { text: 'Column in your file' }), el('th', { text: 'Sample values' })])]),
            el('tbody', null, mapRows),
          ])]),
        ]),
        el('div', null, [
          el('div', { class: 'section-head' }, [el('h2', { text: 'Preview' })]),
          el('div', { class: 'table-wrap' }, [previewTable]),
          el('div', { class: 'section-head gap-top' }, [el('h2', { text: 'How to import' })]),
          fullCard, addCard,
          el('div', { class: 'import-row' }, [go, summaryLine]),
          result,
        ]),
      ]));
      refresh();
    }
    chooser();
  }

  // ------------------------------------------------------------------ webhooks

  async function webhookSetup(ev, s) {
    var body = el('div');
    modal(s.platformName + ' webhook', body);
    var help = (HELP[s.platform] || {}).webhook || [];
    async function render() {
      body.textContent = '';
      body.appendChild(field('Webhook address (keep it private)', copyField(s.webhookUrl)));
      if (help.length) body.appendChild(el('ol', { class: 'howto' }, help.map(function (h) { return el('li', { text: h }); })));
      var data;
      try { data = await api('GET', '/api/admin/sources/' + s.id + '/webhooks'); } catch (e) { body.appendChild(el('p', { class: 'error', text: e.message })); return; }
      body.appendChild(el('div', { class: 'section-head' }, [
        el('h2', { text: data.total ? plural(data.total, 'sale', 'sales') + ' received' : 'No sales received yet' }),
        el('button', { type: 'button', class: 'sm', text: 'Refresh', onclick: render }),
      ]));
      if (!data.items.length) { body.appendChild(el('p', { class: 'muted', text: 'Buy one test ticket on ' + (s.platform === 'other' ? 'the platform' : s.platformName) + ', then tap Refresh.' })); return; }
      var m = Object.assign({ items: '', code: '', name: '', firstName: '', lastName: '', email: '', ticketType: '', status: '', extId: '' }, data.mapping || data.guess || {});
      var inputs = {};
      var labels = { items: 'List of tickets (if one webhook has several)', code: 'QR / barcode value', name: 'Full name', firstName: 'First name', lastName: 'Last name', email: 'Email', ticketType: 'Ticket type', status: 'Status', extId: 'Ticket ID' };
      Object.keys(labels).forEach(function (k) { inputs[k] = el('input', { value: m[k] || '', spellcheck: 'false', placeholder: k === 'code' ? 'e.g. tickets[].qrCode' : '' }); });
      body.appendChild(el('div', { class: 'callout' }, ['Point at fields in the payload. Use ', el('code', { text: 'tickets[]' }), ' for lists and ', el('code', { text: '$.order.email' }), ' for fields outside the ticket list. ', data.mapping ? '' : 'Pre-filled with a best guess: check the QR field.']));
      body.appendChild(el('div', { class: 'mapping-grid' }, Object.keys(labels).map(function (k) { return field(labels[k], inputs[k]); })));
      var result = el('p');
      body.appendChild(el('button', { class: 'primary', type: 'button', text: 'Save mapping and import stored webhooks', onclick: async function () {
        var mapping = {};
        Object.keys(inputs).forEach(function (k) { mapping[k] = inputs[k].value.trim(); });
        try {
          var res = await api('PUT', '/api/admin/sources/' + s.id + '/mapping', { mapping: mapping });
          result.className = res.ok ? 'ok-text' : 'error';
          result.textContent = res.message;
          if (view) refreshEvent(true);
        } catch (ex) { result.className = 'error'; result.textContent = ex.message; }
      } }));
      body.appendChild(result);
      if (data.preview && data.preview.length) {
        body.appendChild(el('h3', { class: 'label sm', text: 'From the latest webhook with the saved mapping' }));
        body.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data' }, [el('tr', null, ['Code', 'Name', 'Email', 'Type'].map(function (h) { return el('th', { text: h }); }))].concat(data.preview.map(function (r) {
          return el('tr', null, [r.code, r.holderName, r.holderEmail, r.ticketType].map(function (v) { return el('td', { class: 'email', text: v || '' }); }));
        })))]));
      }
      body.appendChild(el('h3', { class: 'label sm', text: 'Fields in the latest payload' }));
      body.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data' }, [el('tr', null, [el('th', { text: 'Path' }), el('th', { text: 'Example' })])].concat(data.fields.slice(0, 60).map(function (f) {
        return el('tr', null, [el('td', { class: 'email', text: f.path }), el('td', { class: 'email', text: f.sample === null ? 'null' : f.sample })]);
      })))]));
      body.appendChild(el('details', null, [el('summary', { text: 'Raw payload' }), el('pre', { class: 'json', text: JSON.stringify(data.items[0].payload, null, 2) })]));
    }
    render();
  }

  // ------------------------------------------------------------------ tabs

  function shortVoid(v) {
    var s = String(v || '');
    if (/missing|no longer|not in the latest/i.test(s)) return 'Not on list';
    if (/refund/i.test(s)) return 'Refunded';
    if (/resold|resale/i.test(s)) return 'Resold';
    if (/cancel/i.test(s)) return 'Canceled';
    if (/transfer/i.test(s)) return 'Transferred';
    if (/return/i.test(s)) return 'Returned';
    return 'Void';
  }

  // A line over a list: what it holds, and the spreadsheet of it.
  function listHead(text, href, note) {
    return el('div', { class: 'list-head' }, [
      el('span', { class: 'muted', text: text }),
      el('a', { class: 'btn sm', href: href, text: 'Download CSV', title: note || '' }),
    ]);
  }

  // ---- Guests: every ticket, searchable, with Admit and Undo
  function guestsTab(box, data, opts) {
    var ev = data.event;
    var rows = data.stats.rows || {};
    box.textContent = '';
    if (!rows.all) {
      box.appendChild(el('p', { class: 'muted empty-line', text: data.sources.length ? 'No tickets yet. They show up here as soon as a source brings some in.' : 'No tickets yet. Add where this event sold tickets (Overview → Add source) and they show up here.' }));
      return;
    }
    var q = el('input', { class: 'search', type: 'search', placeholder: 'Search name, email or ticket code', 'aria-label': 'Search tickets' });
    var status = (view && view.filter) || '';
    if (view) view.filter = '';
    var segs = [['', 'All', rows.all], ['scanned', 'In', rows.scanned], ['unscanned', 'Not here', rows.unscanned], ['void', 'Void', rows.void]];
    if (rows.flagged) segs.push(['flagged', 'Flagged', rows.flagged]);
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' });
    var changed = null; // a row that just got admitted or undone flashes once
    function drawSeg() {
      seg.textContent = '';
      segs.forEach(function (sg) { seg.appendChild(el('button', { type: 'button', class: status === sg[0] ? 'on' : '', 'aria-pressed': status === sg[0] ? 'true' : 'false', text: sg[1] + ' ' + n(sg[2]), onclick: function () { status = sg[0]; drawSeg(); load(true); } })); });
      // On a phone the chips scroll sideways: keep the chosen one in view.
      var on = seg.querySelector('button.on');
      if (on && seg.scrollWidth > seg.clientWidth) {
        var a = seg.getBoundingClientRect();
        var b = on.getBoundingClientRect();
        if (b.right > a.right - 8) seg.scrollLeft += b.right - a.right + 24;
        else if (b.left < a.left + 8) seg.scrollLeft -= a.left - b.left + 24;
      }
    }
    var list = el('div', { class: 'table-wrap' });
    var timer;
    async function load(animate) {
      var res = await api('GET', '/api/admin/events/' + ev.id + '/tickets?limit=200&q=' + encodeURIComponent(q.value) + '&status=' + status);
      list.textContent = '';
      if (!res.tickets.length) {
        var none = { scanned: 'Nobody is in yet.', unscanned: 'Everyone is in.', void: 'No void tickets.', flagged: 'Nothing flagged.' }[status];
        var qv = q.value.trim();
        list.appendChild(el('p', { class: 'muted empty-line', text: qv ? (status ? 'Nothing in this filter matches “' + qv + '”.' : 'No tickets match “' + qv + '”. Check the spelling, or try their email or ticket code.') : none || 'No tickets.' }));
        return;
      }
      var tbody = el('tbody', null, res.tickets.map(function (t) {
        var statusCell = t.status === 'void' ? el('span', { class: 'tag void', title: t.voidReason || '', text: 'Void · ' + shortVoid(t.voidReason) })
          : t.scannedAt ? el('span', { class: 'state' }, [el('span', { class: 'dot' }), el('span', null, ['In ' + fmtClock(t.scannedAt), t.scannedBy ? el('span', { class: 'by', text: ' · ' + t.scannedBy }) : null])])
          : el('span', { class: 'state muted' }, [el('span', { class: 'dot idle' }), 'Not here']);
        var action = null;
        if (t.status === 'valid' && !t.scannedAt) {
          action = el('button', { type: 'button', class: 'xs', text: 'Admit', 'aria-label': 'Admit ' + (t.holderName || 'guest'), onclick: async function (e) {
            busy(e.currentTarget, true);
            try {
              var r = await api('POST', '/api/admin/events/' + ev.id + '/admit', { ticketId: t.id });
              toast(r.result === 'admitted' ? (t.holderName || 'Guest') + ' admitted' : 'Not admitted: ' + r.result.replace(/_/g, ' '));
            } catch (ex) { toast(ex.message); }
            changed = t.id;
            load(false);
          } });
        } else if (t.scannedAt) {
          action = el('button', { type: 'button', class: 'text-btn', text: 'Undo', 'aria-label': 'Undo check-in for ' + (t.holderName || 'guest'), onclick: async function () {
            await api('POST', '/api/admin/tickets/' + t.id + '/undo', {});
            toast((t.holderName || 'Guest') + ' is no longer checked in');
            changed = t.id;
            load(false);
          } });
        }
        return el('tr', { class: changed === t.id ? 'flash' : '' }, [
          el('td', { class: 'guest' }, [el('strong', { text: t.holderName || '(no name)' }), isMadeUp(t.code) ? el('span', { class: 'tag noqr', title: 'This list had no QR codes: check this guest in by name', text: 'no QR' }) : null, el('span', { class: 'sub show-sm', text: [t.ticketType, platformName(t.platform)].filter(Boolean).join(' · ') })]),
          el('td', { class: 'hide-sm', text: t.ticketType || '' }),
          el('td', { class: 'hide-sm' }, [el('span', { class: 'badge sm', text: platformName(t.platform) })]),
          el('td', { class: 'email hide-sm', text: t.holderEmail || '' }),
          el('td', { class: 'st' }, [statusCell, t.flag ? el('span', { class: 'tag flag', text: t.flag.replace(/_/g, ' ') }) : null]),
          el('td', { class: 'r act' }, [action]),
        ]);
      }));
      changed = null;
      list.appendChild(el('table', { class: 'data tickets' }, [
        el('thead', null, [el('tr', null, [['Guest'], ['Ticket type', 'hide-sm'], ['Platform', 'hide-sm'], ['Email', 'hide-sm'], ['Status'], ['']].map(function (h) { return el('th', { class: h[1], text: h[0] }); }))]),
        tbody,
      ]));
      if (animate) stagger(tbody.children);
      if (res.tickets.length === 200) list.appendChild(el('p', { class: 'more-note', text: 'Showing the first 200. Narrow the search, or download the full list.' }));
    }
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { load(false); }, 250); });
    drawSeg();
    box.appendChild(listHead(plural(rows.all, 'ticket', 'tickets') + ' from ' + plural(data.sources.length, 'source', 'sources'), '/api/admin/events/' + ev.id + '/export/tickets.csv', 'DICE ticket holders are left out of downloads (DICE’s token terms).'));
    box.appendChild(el('div', { class: 'toolbar-row' }, [q, seg]));
    box.appendChild(list);
    load(opts && opts.fresh);
  }

  // ---- Scans: what every door phone did, newest first
  async function scansTab(box, data, opts) {
    var ev = data.event;
    var res;
    try { res = await api('GET', '/api/admin/events/' + ev.id + '/scans?limit=300'); } catch (e) { return; }
    if (!view || view.tab !== 'scans' || !box.isConnected) return;
    box.textContent = '';
    if (!res.scans.length) { box.appendChild(el('p', { class: 'muted empty-line', text: 'No scans yet. Every scan from every door phone shows up here, newest first.' })); return; }
    var labels = { admitted: ['ok', 'Admitted'], duplicate: ['dup', 'Already scanned'], void: ['void', 'Not valid'], not_found: ['warn', 'Not found'], undo: ['muted', 'Undone'] };
    box.appendChild(listHead('Every scan from every door phone, newest first', '/api/admin/events/' + ev.id + '/export/scans.csv'));
    var tbody = el('tbody', null, res.scans.map(function (s) {
      var l = labels[s.result] || ['muted', s.result];
      return el('tr', null, [
        el('td', { class: 'num t' }, [fmtClock(s.scanned_at)]),
        el('td', { class: 'res' }, [el('span', { class: 'tag ' + l[0], text: l[1] }), s.note ? el('span', { class: 'sub', text: s.note.replace(/_/g, ' ') }) : null]),
        el('td', { class: 'who' }, [s.holder_name ? el('strong', { text: s.holder_name }) : (s.code_raw ? el('span', { class: 'mono', text: String(s.code_raw).slice(0, 40) }) : ''), el('span', { class: 'sub', text: [s.ticket_type, s.platform ? platformName(s.platform) : ''].filter(Boolean).join(' · ') })]),
        el('td', { class: 'door', text: s.device_name || '' }),
        el('td', { class: 'muted hide-sm', text: ({ camera: 'Camera', manual: 'Typed', search: 'Search', scanner: 'Handheld scanner' }[s.method] || s.method) + (s.offline ? ' · offline' : '') }),
      ]);
    }));
    box.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data scans' }, [
      el('thead', null, [el('tr', null, [['Time'], ['Result'], ['Guest'], ['Door'], ['How', 'hide-sm']].map(function (h) { return el('th', { class: h[1], text: h[0] }); }))]),
      tbody,
    ])]));
    if (opts && opts.fresh) stagger(tbody.children);
  }

  // ---- Door: the PIN, the phones signed in, and a way to test a code
  function doorTab(box, data) {
    var ev = data.event;
    var pin = ev.doorPin || '';
    var weak = weakPin(pin);
    box.textContent = '';
    box.appendChild(el('section', { class: 'door-card' + (weak ? ' weak' : '') }, [
      el('div', { class: 'door-card-main' }, [
        el('div', { class: 'label sm', text: 'Door PIN' }),
        el('div', { class: 'pin-big', role: 'img', 'aria-label': pin ? 'Door PIN ' + pin.split('').join(' ') : 'Door PIN hidden' }, (pin || '••••').split('').map(function (d) { return el('span', { text: d }); })),
        weak ? el('p', { class: 'warn-line', text: 'Easy to guess. Anyone with the door link could try it.' }) : null,
        el('p', { class: 'muted', text: 'Door staff open the door app on their phone and type this. Changing it doesn’t sign out phones that are already scanning.' }),
      ]),
      el('div', { class: 'door-card-actions' }, [
        el('button', { type: 'button', class: weak ? 'primary' : '', text: 'Change PIN', onclick: function () { changePin(ev); } }),
        el('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener', text: 'Open door app' }),
        el('button', { type: 'button', text: 'Copy door link', onclick: function () { copyText(location.origin + '/', 'Door link copied'); } }),
      ]),
    ]));

    var phones = data.devices || [];
    var signedIn = phones.filter(function (d) { return !d.revoked; });
    box.appendChild(el('div', { class: 'section-head gap-top' }, [
      el('h2', { text: 'Door phones' }),
      signedIn.length ? el('button', { type: 'button', class: 'sm danger', text: 'Sign out all', onclick: async function () {
        if (!(await ask('Sign out all door phones?', 'Every phone scanning ' + ev.name + ' goes back to the PIN screen. Check-ins already made stay.', 'Sign out phones', true))) return;
        var r = await api('POST', '/api/admin/events/' + ev.id + '/signout-devices', {});
        toast(r.signedOut ? plural(r.signedOut, 'phone', 'phones') + ' signed out' : 'No phones were signed in');
        refreshEvent(true);
      } }) : null,
    ]));
    if (!phones.length) box.appendChild(el('p', { class: 'muted empty-line', text: 'No phones yet. Open the door app on a phone and type the PIN. It shows up here.' }));
    else {
      function seen(d) { return d.lastSeenAt ? ago(d.lastSeenAt) : 'not yet'; }
      box.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data devices' }, [
        el('thead', null, [el('tr', null, [['Phone'], ['Signed in', 'hide-sm'], ['Last seen', 'hide-sm'], ['']].map(function (h) { return el('th', { class: h[1], text: h[0] }); }))]),
        el('tbody', null, phones.map(function (d) {
          return el('tr', { class: d.revoked ? 'off' : '' }, [
            el('td', { class: 'dev' }, [
              el('strong', { text: d.name }),
              d.revoked ? el('span', { class: 'sub', text: 'Signed out' }) : null,
              el('span', { class: 'sub show-sm', text: 'Signed in ' + fmtStamp(d.createdAt).replace(/^Today /, '') + ' · seen ' + seen(d) }),
            ]),
            el('td', { class: 'hide-sm', text: fmtStamp(d.createdAt) }),
            el('td', { class: 'hide-sm', text: seen(d) }),
            el('td', { class: 'r' }, [d.revoked ? null : el('button', { type: 'button', class: 'xs danger', text: 'Sign out', 'aria-label': 'Sign out ' + d.name, onclick: async function () {
              if (!(await ask('Sign out ' + d.name + '?', 'That phone goes back to the PIN screen. Staff type the PIN to get back in, and scans saved on it upload then.', 'Sign out', true))) return;
              await api('POST', '/api/admin/devices/' + d.id + '/revoke', {});
              toast(d.name + ' signed out');
              refreshEvent(true);
            } })]),
          ]);
        })),
      ])]));
    }

    box.appendChild(el('div', { class: 'section-head gap-top' }, [el('h2', { text: 'Test a code' })]));
    testBlock(box, ev);
  }

  function changePin(ev) {
    var input = el('input', { inputmode: 'numeric', pattern: '[0-9]*', minlength: 4, maxlength: 12, required: true, autocomplete: 'off', placeholder: '4 to 12 digits', 'aria-label': 'New door PIN' });
    var hint = el('p', { class: 'warn-line', hidden: true, text: 'Easy to guess. Pick digits that aren’t a pattern.' });
    var err = el('p', { class: 'error' });
    var save = el('button', { class: 'primary lg', type: 'submit', text: 'Save PIN' });
    input.addEventListener('input', function () { input.value = input.value.replace(/\D/g, ''); hint.hidden = !(input.value.length >= 4 && weakPin(input.value)); });
    var close = modal('Change door PIN', el('form', { class: 'pin-form', onsubmit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      busy(save, true);
      try {
        await api('PATCH', '/api/admin/events/' + ev.id, { doorPin: input.value });
        close();
        toast('Door PIN changed. Tell door staff the new one.');
        refreshEvent(true);
      } catch (ex) { err.textContent = ex.message; busy(save, false); }
    } }, [field('New door PIN', input, 'Phones already scanning stay signed in.'), hint, el('div', { class: 'head-actions' }, [save]), err]), null, { small: true });
    later(260, function () { input.focus(); });
  }

  function copyText(text, done) {
    function fallback() {
      var t = el('textarea', { class: 'offscreen' }); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast(done); } catch (e) { toast(text); }
      t.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(done); }, fallback);
    else fallback();
  }

  // Mirrors the door's result screens, without admitting anyone.
  function verdictCard(kind, word, title, detail) {
    var tag = { admitted: 'ok', duplicate: 'dup', void: 'void', not_found: 'warn' }[kind];
    return el('div', { class: 'verdict ' + kind }, [el('span', { class: 'tag ' + tag, text: word }), el('div', null, [el('strong', { text: title }), el('span', { class: 'sub', text: detail })])]);
  }

  function testBlock(box, ev) {
    var input = el('input', { class: 'search', placeholder: 'Paste or type what a QR contains', spellcheck: 'false', 'aria-label': 'Ticket code' });
    var out = el('div', { class: 'verdicts', 'aria-live': 'polite' });
    var go = el('button', { class: 'primary', type: 'submit', text: 'Check' });
    box.appendChild(el('p', { class: 'muted tab-intro', text: 'Check a code without admitting anyone. Scan the ticket with any QR reader app and paste the text here, or type the number printed under the QR.' }));
    box.appendChild(el('form', { class: 'toolbar-row', onsubmit: async function (e) {
      e.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      busy(go, true);
      var res;
      try { res = await api('POST', '/api/admin/events/' + ev.id + '/lookup', { code: input.value }); } catch (ex) { busy(go, false); toast(ex.message); return; }
      busy(go, false);
      out.textContent = '';
      if (!res.tickets.length) {
        out.appendChild(verdictCard('not_found', 'Not found', 'No ticket for this event has this code', 'If it came from a link or has extra characters, check that the platform export uses the same value. Tried: ' + (res.keys.join(', ') || '(empty)')));
      }
      res.tickets.forEach(function (t) {
        var kind = t.status === 'void' ? 'void' : t.scannedAt ? 'duplicate' : 'admitted';
        var word = { void: 'Not valid', duplicate: 'Already scanned', admitted: 'Would admit' }[kind];
        var detail = t.status === 'void' ? (t.voidReason || 'Void') : t.scannedAt ? 'Scanned ' + fmtClock(t.scannedAt) + (t.scannedBy ? ' at ' + t.scannedBy : '') : 'Valid, not scanned yet';
        out.appendChild(verdictCard(kind, word, t.holderName || '(no name)', [t.ticketType, platformName(t.platform), detail].filter(Boolean).join(' · ')));
      });
      stagger(out.children);
      // On a phone the keyboard hides the answer: put the keyboard away and bring the answer into view.
      if (window.matchMedia('(pointer: coarse)').matches) input.blur();
      out.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
    } }, [input, go]));
    box.appendChild(out);
  }

  // ------------------------------------------------------------------ start

  document.addEventListener('touchstart', function () {}, { passive: true }); // lets iPhone Safari show :active pressed states

  (async function start() {
    try { await api('GET', '/api/admin/me', null, { allow401: true }); route(); } catch (e) { renderLogin(); }
  })();
})();
