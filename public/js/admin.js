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
    var res = await fetch(path, { method: method, headers: headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && !opts.allow401) { renderLogin(); throw new Error('Sign in again'); }
    if (!res.ok) { var err = new Error(data.error || 'HTTP ' + res.status); err.status = res.status; throw err; }
    return data;
  }

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
  function n(x) { return Number(x || 0).toLocaleString(); }
  function platformName(p) { return (PLATFORMS[p] || {}).name || p; }
  function isMadeUp(code) { return /^NOQR-/.test(code || ''); }

  var toastTimer;
  function toast(msg, ms) {
    var t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 4000);
  }

  function modal(title, body, onClose) {
    var back = el('div', { class: 'modal-back' });
    function close() { back.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); }
    function esc(e) { if (e.key === 'Escape') close(); }
    var box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('header', null, [el('h2', { text: title }), el('button', { type: 'button', class: 'ghost sm', text: 'Close', onclick: close })]),
      body,
    ]);
    back.appendChild(box);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(back);
    return close;
  }

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

  function pageHead(crumbs, title, actions) {
    var crumb = el('span', { class: 'label crumb' });
    crumbs.forEach(function (c, i) {
      if (i) crumb.appendChild(document.createTextNode(' / '));
      crumb.appendChild(c.href ? el('a', { href: c.href, text: c.text }) : document.createTextNode(c.text));
    });
    return el('div', { class: 'page-head' }, [
      el('div', null, [crumb, el('h1', { text: title })]),
      actions && actions.length ? el('div', { class: 'head-actions' }, actions) : null,
    ]);
  }

  // The sidebar layout every signed-in page uses.
  function shell() {
    clearInterval(refreshTimer);
    root.textContent = '';
    var main = el('main', { class: 'main' });
    root.appendChild(el('div', { class: 'shell' }, [
      el('aside', { class: 'side' }, [
        el('a', { href: '#/' }, [el('img', { class: 'logo', src: '/brand/moji-logo.png', alt: 'Moji' })]),
        el('a', { class: 'nav active', href: '#/', text: 'Events' }),
        el('a', { class: 'nav', href: '/', target: '_blank', rel: 'noopener', text: 'Door app' }),
        el('div', { class: 'me' }, [
          el('div', { class: 'n', text: 'Moji Sounds' }),
          el('button', { type: 'button', class: 'text-btn', text: 'Sign out', onclick: async function () { await api('POST', '/api/admin/logout', {}); renderLogin(); } }),
        ]),
      ]),
      main,
    ]));
    return main;
  }

  // ------------------------------------------------------------------ routing

  function route() {
    clearInterval(refreshTimer);
    var h = location.hash;
    var m;
    if ((m = /^#\/event\/([^/]+)\/add$/.exec(h))) return renderAddSource(m[1]);
    if ((m = /^#\/event\/([^/]+)\/upload\/([^/]+)$/.exec(h))) return renderUpload(m[1], m[2]);
    if ((m = /^#\/event\/([^/]+)/.exec(h))) return renderEvent(m[1]);
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
    if (e.archived) return ['muted', 'Archived'];
    var t = Date.parse(e.startsAt);
    var now = Date.now();
    if (!isNaN(t)) {
      if (now >= t - 4 * 3600e3 && now <= t + 10 * 3600e3) return ['ok', 'Live now'];
      if (now > t + 10 * 3600e3) return ['muted', 'Ended'];
    }
    if (!e.sources) return ['draft', 'Draft'];
    return ['in', 'Upcoming'];
  }

  function platformsLine(list) {
    if (!list || !list.length) return 'None yet';
    return list.slice(0, 3).join(' · ') + (list.length > 3 ? ' · +' + (list.length - 3) : '');
  }

  async function renderEvents() {
    var data;
    try { data = await api('GET', '/api/admin/events'); } catch (e) { return; }
    var main = shell();
    main.appendChild(pageHead([{ text: 'Moji Door' }], 'Events', [el('button', { type: 'button', class: 'primary', text: 'New event', onclick: newEvent })]));
    if (!data.events.length) {
      main.appendChild(el('div', { class: 'empty-card' }, ['Create your first event, then add where its tickets were sold: Shotgun, DICE, RA, Bucket Listers, Eventbrite, Posh or any CSV.']));
      return;
    }
    var rows = data.events.map(function (e) {
      var st = eventStatus(e);
      var open = function () { location.hash = '#/event/' + e.id; };
      return el('tr', { class: 'click', onclick: function (ev) { if (ev.target.tagName !== 'A' && ev.target.tagName !== 'BUTTON') open(); } }, [
        el('td', null, [el('a', { class: 'ev-name', href: '#/event/' + e.id, text: e.name })]),
        el('td', { class: 'hide-sm', text: e.venue || '' }),
        el('td', { text: e.startsAt ? fmtDate(e.startsAt) : 'No date' }),
        el('td', null, [el('span', { class: 'tag ' + st[0], text: st[1] })]),
        el('td', { class: 'num r', text: e.valid || e.scanned ? n(e.scanned) + ' / ' + n(e.valid) : '—' }),
        el('td', { class: 'muted hide-sm', text: platformsLine(e.platforms) }),
        el('td', { class: 'r' }, [el('button', { type: 'button', class: 'sm' + (st[1] === 'Live now' ? ' primary' : ''), text: 'Open', onclick: open })]),
      ]);
    });
    main.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data' }, [
      el('thead', null, [el('tr', null, [['Event'], ['Venue', 'hide-sm'], ['Date'], ['Status'], ['Checked in', 'r'], ['Sources', 'hide-sm'], ['']].map(function (h) { return el('th', { class: h[1], text: h[0] }); }))]),
      el('tbody', null, rows),
    ])]));
  }

  function eventForm(ev, onSaved) {
    var name = el('input', { required: true, maxlength: 120, value: ev ? ev.name : '', placeholder: 'MOJI & FRQNC Present: LIGHTLEAK' });
    var venue = el('input', { maxlength: 120, value: ev ? ev.venue || '' : '', placeholder: 'Edge Miami' });
    var when = el('input', { type: 'datetime-local', value: ev ? toLocalInput(ev.startsAt) : '' });
    var pin = el('input', { inputmode: 'numeric', pattern: '[0-9]*', minlength: 4, maxlength: 12, required: !ev, placeholder: ev ? 'Leave empty to keep it' : '4 to 12 digits' });
    var archived = el('input', { type: 'checkbox', checked: ev && ev.archived });
    var err = el('p', { class: 'error' });
    var parts = [
      el('div', { class: 'form-grid' }, [field('Event name', name), field('Venue', venue)]),
      el('div', { class: 'form-grid' }, [field('Doors open', when), field(ev ? 'New door PIN' : 'Door PIN', pin, 'Door staff type this to sign in.')]),
    ];
    if (ev) parts.push(el('label', { class: 'check' }, [archived, 'Archived: hidden from the door app, and API syncing stops']));
    parts.push(el('div', { class: 'head-actions' }, [
      el('button', { class: 'primary', type: 'submit', text: ev ? 'Save' : 'Create event' }),
      ev ? el('button', { type: 'button', class: 'danger', text: 'Sign out all door phones', onclick: async function () {
        if (!confirm('Sign out every phone scanning this event? They will need the PIN again.')) return;
        var r = await api('POST', '/api/admin/events/' + ev.id + '/signout-devices', {});
        toast(r.signedOut + ' phone(s) signed out');
      } }) : null,
    ]));
    parts.push(err);
    return el('form', { onsubmit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      try {
        var body = { name: name.value, venue: venue.value, startsAt: fromLocalInput(when.value) };
        if (pin.value) body.doorPin = pin.value;
        if (ev) body.archived = archived.checked;
        var res = ev ? await api('PATCH', '/api/admin/events/' + ev.id, body) : await api('POST', '/api/admin/events', body);
        onSaved(res.event);
      } catch (ex) { err.textContent = ex.message; }
    } }, parts);
  }

  function newEvent() {
    var close = modal('New event', eventForm(null, function (ev) { close(); location.hash = '#/event/' + ev.id; }));
  }

  // ------------------------------------------------------------------ event page

  async function renderEvent(id) {
    var data;
    try { data = await api('GET', '/api/admin/events/' + id); } catch (e) { if (e.status === 404) location.hash = ''; return; }
    var main = shell();
    var ev = data.event;
    var crumbBits = [ev.venue, ev.startsAt ? fmtDate(ev.startsAt) : '', fmtDoors(ev.startsAt)].filter(Boolean).join(' · ');
    main.appendChild(pageHead([{ text: 'Events', href: '#/' }, { text: crumbBits || 'No date set' }], ev.name + (ev.archived ? ' (archived)' : ''), [
      el('div', { class: 'pin-chip', title: 'Door staff type this to sign in' }, [el('span', { class: 'label xs', text: 'Door PIN' }), el('b', { text: ev.doorPin || '••••' })]),
      el('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener', text: 'Open door app' }),
      el('button', { type: 'button', text: 'Edit', onclick: function () { var close = modal('Edit event', eventForm(ev, function () { close(); route(); })); } }),
    ]));

    var overview = el('div', { id: 'overview' });
    main.appendChild(overview);
    renderOverview(overview, data);
    var tabsBox = el('div');
    main.appendChild(tabsBox);
    renderTabs(tabsBox, data);

    refreshTimer = setInterval(async function () {
      if (document.hidden || document.querySelector('.modal-back')) return;
      try { var fresh = await api('GET', '/api/admin/events/' + id); renderOverview(overview, fresh); data.stats = fresh.stats; } catch (e) { /* keep last view */ }
    }, 10000);
  }

  function renderOverview(box, data) {
    var st = data.stats;
    var rows = st.rows || {};
    box.textContent = '';
    var pct = st.valid ? Math.round(100 * st.scanned / st.valid) : 0;
    var platformCount = new Set(data.sources.map(function (s) { return s.platform; })).size;
    box.appendChild(el('div', { class: 'stats' }, [
      el('div', null, [el('div', { class: 'label sm', text: 'Checked in' }), el('div', { class: 'n', text: n(st.scanned) }), el('div', { class: 's', text: pct + '% of valid tickets' })]),
      el('div', null, [el('div', { class: 'label sm', text: 'Valid tickets' }), el('div', { class: 'n', text: n(st.valid) }), el('div', { class: 's', text: 'From ' + platformCount + ' platform' + (platformCount === 1 ? '' : 's') + ' · ' + n(rows.void) + ' void' })]),
      el('div', null, [el('div', { class: 'label sm', text: 'Not here yet' }), el('div', { class: 'n', text: n(Math.max(0, st.valid - st.scanned)) }), el('div', { class: 's', text: st.lastScanAt ? 'Last scan ' + fmtClock(st.lastScanAt) : 'No scans yet' })]),
    ]));
    var flags = st.flags || {};
    if (flags.double_entry || flags.voided_after_scan) {
      box.appendChild(el('div', { class: 'alert' }, [el('span', { class: 'tag warn', text: 'Check' }), el('div', null, [
        flags.double_entry ? flags.double_entry + ' ticket(s) got in twice while a phone was offline. ' : '',
        flags.voided_after_scan ? flags.voided_after_scan + ' ticket(s) were refunded, resold or transferred after they were scanned. ' : '',
        'Filter the Tickets tab by Flagged to see them.',
      ])]));
    }
    box.appendChild(el('div', { class: 'section-head' }, [el('h2', { text: 'Where tickets were sold' }), el('a', { class: 'btn sm', href: '#/event/' + data.event.id + '/add', text: 'Add source' })]));
    var byId = {};
    (st.bySource || []).forEach(function (s) { byId[s.source_id] = s; });
    if (!data.sources.length) {
      box.appendChild(el('div', { class: 'empty-card gap-bottom' }, ['No sources yet. Add where this event\'s tickets were sold: Shotgun, DICE, RA, Bucket Listers, Eventbrite, Posh or any CSV export.']));
      return;
    }
    box.appendChild(el('div', { class: 'sources' }, data.sources.map(function (s) { return sourceCard(data.event, s, byId[s.id] || { valid: 0, scanned: 0, void: 0 }); })));
  }

  function sourceStatus(s) {
    var when = s.lastSyncAt ? fmtClock(s.lastSyncAt) + ' · ' + ago(s.lastSyncAt) : '';
    if (s.kind === 'api') {
      if (s.lastSyncOk === false) return [el('span', { class: 'dot bad' }), el('span', { text: 'Last sync failed · ' + ago(s.lastSyncAt) })];
      if (s.lastSyncAt) return [el('span', { class: 'dot' }), el('span', { text: 'Synced ' + when })];
      return [el('span', { class: 'dot idle' }), el('span', { text: 'Not synced yet' })];
    }
    if (s.kind === 'webhook') {
      if (s.lastSyncOk === false) return [el('span', { class: 'dot bad' }), el('span', { text: 'Last webhook had no tickets · ' + ago(s.lastSyncAt) })];
      if (s.lastSyncAt) return [el('span', { class: 'dot' }), el('span', { text: 'Last sale received ' + when })];
      return [el('span', { class: 'dot idle' }), el('span', { text: 'Waiting for the first webhook' })];
    }
    if (!s.lastSyncAt) return [el('span', { class: 'dot idle' }), el('span', { text: 'No file uploaded yet' })];
    var stale = Date.now() - new Date(s.lastSyncAt).getTime() > STALE_MS;
    return [stale ? el('span', { class: 'tag stale', text: 'Stale' }) : el('span', { class: 'dot' }), el('span', { text: 'File uploaded ' + when })];
  }

  function sourceCard(ev, s, counts) {
    var defaultLabels = [s.platformName, s.platformName + ' (file)'];
    var custom = s.label && defaultLabels.indexOf(s.label) === -1 ? s.label : '';
    var safety = s.lastSyncMessage && /safety check/.test(s.lastSyncMessage);
    var actions = el('div', { class: 'actions' });
    if (s.kind === 'api') {
      actions.appendChild(el('button', { type: 'button', class: 'sm primary', text: 'Sync now', onclick: function (e) { runSync(s, {}, e.target); } }));
      actions.appendChild(el('button', { type: 'button', class: 'sm', text: 'Settings', onclick: function () { editApiSource(ev, s); } }));
      if (safety) actions.appendChild(el('button', { type: 'button', class: 'sm danger', text: 'Apply voids', onclick: function (e) { if (confirm('Void every ticket that is no longer on ' + s.platformName + '?')) runSync(s, { force: true }, e.target); } }));
    } else if (s.kind === 'webhook') {
      actions.appendChild(el('button', { type: 'button', class: 'sm primary', text: 'Webhook setup', onclick: function () { webhookSetup(ev, s); } }));
      actions.appendChild(el('a', { class: 'btn sm', href: '#/event/' + ev.id + '/upload/' + s.id, text: 'Upload file' }));
    } else {
      actions.appendChild(el('a', { class: 'btn sm primary', href: '#/event/' + ev.id + '/upload/' + s.id, text: 'Upload file' }));
    }
    actions.appendChild(el('span', { class: 'spacer' }));
    actions.appendChild(el('button', { type: 'button', class: 'text-btn', text: 'Remove', onclick: async function () {
      if (!confirm('Remove "' + s.label + '"? Its ' + counts.valid + ' tickets will stop scanning.')) return;
      await api('DELETE', '/api/admin/sources/' + s.id);
      route();
    } }));
    var showMsg = s.lastSyncOk === false || safety;
    return el('div', { class: 'source' }, [
      el('div', { class: 'head' }, [el('span', { class: 'badge', text: s.platformName }), custom ? el('span', { class: 'lbl', text: custom }) : null, el('span', { class: 'label sm', text: KIND_LABELS[s.kind] || s.kind })]),
      el('div', { class: 'nums' }, [
        el('div', null, [el('span', { class: 'label xs', text: 'Valid' }), el('b', { text: n(counts.valid) })]),
        el('div', null, [el('span', { class: 'label xs', text: 'In' }), el('b', { text: n(counts.scanned) })]),
        el('div', null, [el('span', { class: 'label xs', text: 'Void' }), el('b', { text: n(counts.void) })]),
      ]),
      el('div', { class: 'status', title: s.lastSyncMessage || '' }, sourceStatus(s)),
      showMsg ? el('div', { class: 'msg' + (s.lastSyncOk === false ? ' bad' : ''), text: s.lastSyncMessage }) : null,
      actions,
    ]);
  }

  async function runSync(s, opts, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    try {
      var res = await api('POST', '/api/admin/sources/' + s.id + '/sync', opts);
      toast((res.ok ? '' : 'Failed: ') + res.message, 7000);
    } catch (e) { toast(e.message, 7000); }
    route();
  }

  // ------------------------------------------------------------------ add a source

  var HELP = {
    shotgun: {
      api: ['In Shotgun Smartboard go to Settings → Integrations → Shotgun APIs.', 'Copy your Organizer ID and click Generate a token.', 'Find the event ID in the Smartboard address bar when the event is open.', 'Transfers cancel the old QR and issue a new one, so this pulls changes every minute, and right away when the door scans a code it doesn\'t know.'],
      file: ['Export the attendee list from Smartboard as CSV with the scan code column.'],
    },
    dice: {
      api: ['In MIO click your company name (bottom left) → Account Settings → Access Tokens.', 'Generate a Ticket holder API token and paste it below.', 'DICE keeps the ticket QR value behind restricted access. Ask your DICE rep to enable restricted fields (ticket code) on your Ticket Holders API token for door access control.', 'DICE creates each QR when the fan activates the ticket in the app, about 2 hours before the event. The list syncs every 2 minutes, and right away when the door scans a code it doesn\'t know.', 'Before the night, activate one test ticket and check it in the door app (More → Test mode). DICE calls its QR "animated": if the test doesn\'t match, DICE tickets need DICE\'s own scanner app (DICE Access) or name search.'],
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
    var main = shell();
    main.appendChild(pageHead([{ text: 'Events', href: '#/' }, { text: ev.name, href: '#/event/' + ev.id }, { text: 'Sources' }], 'Add a ticket source', [el('a', { class: 'btn', href: '#/event/' + ev.id, text: 'Cancel' })]));
    var left = el('div');
    var right = el('div', { class: 'side-card' });
    main.appendChild(el('div', { class: 'split' }, [left, right]));

    function step(num, title, body) {
      return el('div', { class: 'step' }, [el('div', { class: 'step-n', text: String(num) }), el('div', null, [el('h2', { text: title }), body])]);
    }

    function draw() {
      left.textContent = '';
      left.appendChild(step(1, 'Pick the platform', el('div', { class: 'pick-grid' }, Object.keys(PLATFORMS).map(function (p) {
        var on = state.platform === p;
        return el('button', { type: 'button', class: 'pick' + (on ? ' on' : ''), onclick: function () { state.platform = p; state.kind = PLATFORMS[p].kinds[0]; draw(); } }, [
          el('span', { text: PLATFORMS[p].name }),
          on ? el('span', { class: 'label', text: 'Selected' }) : added[p] ? el('span', { class: 'label', text: 'Added' }) : null,
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
      left.appendChild(step(2, 'How tickets get in', el('div', { class: 'pick-grid' }, kinds.map(function (k, i) {
        var on = state.kind === k;
        return el('button', { type: 'button', class: 'pick kind' + (on ? ' on' : ''), onclick: function () { state.kind = k; draw(); } }, [
          el('div', { class: 'top' }, [el('span', { text: KIND_NAMES[k] }), i === 0 && kinds.length > 1 ? el('span', { class: 'label', text: 'Recommended' }) : null]),
          el('div', { class: 'd', text: kindBlurb(p, k) }),
        ]);
      }))));
      var title = state.kind === 'api' ? 'Connect ' + PLATFORMS[p].name : state.kind === 'file' ? 'Upload from ' + PLATFORMS[p].name : 'Webhook from ' + PLATFORMS[p].name;
      left.appendChild(step(3, title, sourceForm(ev, p, state.kind, null)));
      afterNotes(p, state.kind).forEach(function (t) { right.appendChild(el('p', { text: t })); });
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
    parts.push(el('div', { class: 'head-actions' }, [submit, existing && platform === 'shotgun' ? el('button', { type: 'button', class: 'lg', text: 'Full re-sync', onclick: function (e) { if (close) close(); runSync(existing, { full: true }, e.target); } }) : null]));
    parts.push(result, err);
    return el('form', { onsubmit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      result.textContent = '';
      submit.disabled = true;
      var config = {};
      Object.keys(inputs).forEach(function (k) { config[k] = inputs[k].type === 'checkbox' ? inputs[k].checked : inputs[k].value; });
      try {
        if (existing) {
          await api('PATCH', '/api/admin/sources/' + existing.id, { label: label.value, config: config });
          if (close) close();
          route();
          return;
        }
        var res = await api('POST', '/api/admin/events/' + ev.id + '/sources', { platform: platform, kind: kind, label: label.value, config: config });
        if (kind === 'file') { location.hash = '#/event/' + ev.id + '/upload/' + res.source.id; return; }
        if (kind === 'webhook') { location.hash = '#/event/' + ev.id; setTimeout(function () { webhookSetup(ev, res.source); }, 300); return; }
        if (res.sync && res.sync.ok) {
          result.appendChild(el('div', { class: 'connect-result' }, [el('span', { class: 'ok', text: '✓' }), 'Connected. ' + res.sync.message]));
          setTimeout(function () { location.hash = '#/event/' + ev.id; }, 1800);
        } else {
          err.textContent = 'Added, but the first sync failed: ' + (res.sync ? res.sync.message : 'unknown error');
          result.appendChild(el('a', { class: 'btn', href: '#/event/' + ev.id, text: 'Back to the event' }));
        }
      } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
    } }, parts);
  }

  function editApiSource(ev, s) {
    var body = el('div');
    var close = modal(s.platformName + ' settings', body);
    var help = (HELP[s.platform] || {}).api || [];
    if (help.length) body.appendChild(el('ol', { class: 'howto' }, help.map(function (h) { return el('li', { text: h }); })));
    body.appendChild(sourceForm(ev, s.platform, 'api', s, close));
  }

  // ------------------------------------------------------------------ CSV upload

  async function renderUpload(eventId, sourceId) {
    var data;
    try { data = await api('GET', '/api/admin/events/' + eventId); } catch (e) { if (e.status === 404) location.hash = ''; return; }
    var ev = data.event;
    var s = data.sources.filter(function (x) { return x.id === sourceId; })[0];
    if (!s) { location.hash = '#/event/' + eventId; return; }
    var main = shell();
    var headActions = el('div', { class: 'head-actions' }, [el('a', { class: 'btn', href: '#/event/' + ev.id, text: 'Back to event' })]);
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
        el('div', { text: 'Drop the file here, or' }),
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
      headActions.appendChild(el('div', { class: 'file-chip' }, [
        el('span', { class: 'f', text: fileName }),
        el('span', { class: 'label xs', text: n(prev.rowCount) + ' rows' }),
        el('button', { type: 'button', class: 'text-btn', text: 'Replace', onclick: function () { input.value = ''; input.click(); } }),
      ]));
      var mapping = Object.assign({}, prev.mapping);
      var FIELDS = [['code', 'QR code'], ['name', 'Name'], ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['ticketType', 'Ticket type'], ['quantity', 'Quantity'], ['status', 'Status'], ['extId', 'Ticket / order ID']];
      var banner = el('div', { class: 'alert' }, [el('span', { class: 'tag warn', text: 'No QR column' }), el('div', null, ['This file has no QR code column. Guests from it can only be checked in with ', el('strong', { text: 'Search' }), ' at the door. Scanning their tickets will show NOT FOUND. If ' + (s.platform === 'other' ? 'the platform' : s.platformName) + ' can export ticket codes, upload that file instead.'])]);
      var previewTable = el('table', { class: 'data' });
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
        sampleCells[f[0]] = el('td', { class: 'sample' });
        function upd() {
          sel.className = f[0] === 'code' && !(mapping.code >= 0) ? 'none' : '';
          sampleCells[f[0]].textContent = mapping[f[0]] >= 0 ? sampleValues(mapping[f[0]]) : '—';
        }
        sel.addEventListener('change', function () { mapping[f[0]] = Number(sel.value); upd(); refresh(); });
        upd();
        return el('tr', null, [el('td', null, [el('strong', { text: f[1] })]), el('td', null, [sel]), sampleCells[f[0]]]);
      });

      function cell(row, k) { return mapping[k] >= 0 ? String(row[mapping[k]] || '').trim() : ''; }
      function drawPreview() {
        var nameOnly = !picked('code');
        var cols = (nameOnly ? [] : [['code', 'QR code']]).concat([['name', 'Name'], ['ticketType', 'Ticket type']]).concat(nameOnly && picked('quantity') ? [['quantity', 'Qty']] : []).concat([['status', 'Status']]);
        previewTable.textContent = '';
        previewTable.appendChild(el('thead', null, [el('tr', null, cols.map(function (c) { return el('th', { text: c[1] }); }))]));
        previewTable.appendChild(el('tbody', null, prev.sample.slice(0, 6).map(function (r) {
          return el('tr', null, cols.map(function (c) {
            if (c[0] === 'name') return el('td', null, [el('strong', { text: cell(r, 'name') || [cell(r, 'firstName'), cell(r, 'lastName')].filter(Boolean).join(' ') || cell(r, 'email') || '—' })]);
            if (c[0] === 'status') { var st = cell(r, 'status'); return el('td', null, [st && VOID_STATUS.test(st) ? el('span', { class: 'tag void', text: 'Void' }) : st || 'Valid']); }
            if (c[0] === 'code') return el('td', { class: 'email', text: cell(r, 'code') || '(no code: skipped)' });
            return el('td', { text: cell(r, c[0]) || '—' });
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
            summaryLine.textContent = n(sm.valid) + ' valid · ' + n(sm.void) + ' void' + (sm.nameOnly ? ' · name-only' : '');
          } catch (ex) { summaryLine.textContent = ''; }
        }, 200);
      }

      go.addEventListener('click', async function () {
        if (!picked('code') && !['name', 'firstName', 'lastName', 'email'].some(picked)) { result.className = 'error'; result.textContent = 'Pick the QR code column, or a name column for a list without codes.'; return; }
        go.disabled = true;
        result.className = 'muted'; result.textContent = 'Importing…';
        try {
          var mode = full.checked ? 'replace' : 'merge';
          var res = await api('POST', '/api/admin/sources/' + s.id + '/import?mode=' + mode + '&mapping=' + encodeURIComponent(JSON.stringify(mapping)), text, { contentType: 'text/csv; charset=utf-8' });
          result.className = 'ok-text';
          result.textContent = res.message;
          setTimeout(function () { location.hash = '#/event/' + ev.id; }, 1500);
        } catch (ex) { result.className = 'error'; result.textContent = ex.message; go.disabled = false; }
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
      body.appendChild(el('div', { class: 'section-head' }, [el('h2', { text: data.total + ' webhook(s) received' }), el('button', { type: 'button', class: 'sm', text: 'Refresh', onclick: render })]));
      if (!data.items.length) { body.appendChild(el('p', { class: 'muted', text: 'Nothing yet. Buy a test ticket, then refresh.' })); return; }
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
          if (/^#\/event\//.test(location.hash)) {
            var fresh = await api('GET', '/api/admin/events/' + ev.id);
            var ov = document.getElementById('overview');
            if (ov) renderOverview(ov, fresh);
          }
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

  function renderTabs(box, data) {
    var ev = data.event;
    var tabs = [['tickets', 'Tickets'], ['scans', 'Scan log'], ['test', 'Test a code'], ['devices', 'Door devices'], ['export', 'Export']];
    var current = 'tickets';
    var content = el('div');
    var bar = el('div', { class: 'tabs' });
    function draw() {
      bar.textContent = '';
      tabs.forEach(function (t) { bar.appendChild(el('button', { type: 'button', class: current === t[0] ? 'active' : '', text: t[1], onclick: function () { current = t[0]; draw(); } })); });
      content.textContent = '';
      ({ tickets: ticketsTab, scans: scansTab, test: testTab, devices: devicesTab, export: exportTab })[current](content, ev, data);
    }
    box.appendChild(bar);
    box.appendChild(content);
    draw();
  }

  function shortVoid(v) {
    var s = String(v || '');
    if (/missing|no longer|not in the latest/i.test(s)) return 'Not on list';
    if (/refund/i.test(s)) return 'Refunded';
    if (/resold|resale/i.test(s)) return 'Resold';
    if (/transfer/i.test(s)) return 'Transferred';
    if (/return/i.test(s)) return 'Returned';
    if (/cancel/i.test(s)) return 'Canceled';
    return 'Void';
  }

  function ticketsTab(box, ev, data) {
    var rows = data.stats.rows || {};
    var q = el('input', { class: 'search', type: 'search', placeholder: 'Search name, email or ticket code' });
    var status = '';
    var segs = [['', 'All', rows.all], ['scanned', 'In', rows.scanned], ['unscanned', 'Not here', rows.unscanned], ['void', 'Void', rows.void]];
    if (rows.flagged) segs.push(['flagged', 'Flagged', rows.flagged]);
    var seg = el('div', { class: 'seg' });
    function drawSeg() {
      seg.textContent = '';
      segs.forEach(function (sg) { seg.appendChild(el('button', { type: 'button', class: status === sg[0] ? 'on' : '', text: sg[1] + ' ' + n(sg[2]), onclick: function () { status = sg[0]; drawSeg(); load(); } })); });
    }
    var list = el('div', { class: 'table-wrap' });
    var timer;
    async function load() {
      var res = await api('GET', '/api/admin/events/' + ev.id + '/tickets?limit=200&q=' + encodeURIComponent(q.value) + '&status=' + status);
      list.textContent = '';
      if (!res.tickets.length) { list.appendChild(el('p', { class: 'muted', text: 'No tickets match.' })); return; }
      list.appendChild(el('table', { class: 'data' }, [
        el('thead', null, [el('tr', null, [['Guest'], ['Ticket type', 'hide-sm'], ['Platform', 'hide-sm'], ['Email', 'hide-sm'], ['QR', 'hide-sm'], ['Status'], ['']].map(function (h) { return el('th', { class: h[1], text: h[0] }); }))]),
        el('tbody', null, res.tickets.map(function (t) {
          var statusCell = t.status === 'void' ? el('span', { class: 'tag void', title: t.voidReason || '', text: 'VOID · ' + shortVoid(t.voidReason) })
            : t.scannedAt ? el('span', { class: 'tag in', text: 'IN ' + fmtClock(t.scannedAt) + (t.scannedBy ? ' · ' + t.scannedBy : '') })
            : el('span', { class: 'muted', text: 'Not here' });
          var action = null;
          if (t.status === 'valid' && !t.scannedAt) {
            action = el('button', { type: 'button', class: 'xs primary', text: 'Admit', onclick: async function (e) {
              e.target.disabled = true;
              try {
                var r = await api('POST', '/api/admin/events/' + ev.id + '/admit', { ticketId: t.id });
                toast(r.result === 'admitted' ? (t.holderName || 'Guest') + ' admitted' : 'Not admitted: ' + r.result.replace(/_/g, ' '));
              } catch (ex) { toast(ex.message); }
              load();
            } });
          } else if (t.scannedAt) {
            action = el('button', { type: 'button', class: 'text-btn', text: 'Undo', onclick: async function () { await api('POST', '/api/admin/tickets/' + t.id + '/undo', {}); load(); } });
          }
          return el('tr', null, [
            el('td', null, [el('strong', { text: t.holderName || '(no name)' }), el('span', { class: 'sub show-sm', text: [t.ticketType, platformName(t.platform), isMadeUp(t.code) ? 'no QR' : ''].filter(Boolean).join(' · ') })]),
            el('td', { class: 'hide-sm', text: t.ticketType || '' }),
            el('td', { class: 'hide-sm' }, [el('span', { class: 'badge', text: platformName(t.platform) })]),
            el('td', { class: 'email hide-sm', text: t.holderEmail || '' }),
            el('td', { class: 'hide-sm' }, [isMadeUp(t.code) ? el('span', { class: 'tag noqr', text: 'no QR' }) : 'Yes']),
            el('td', null, [statusCell, t.flag ? el('span', { class: 'tag flag', text: t.flag.replace(/_/g, ' ') }) : null]),
            el('td', { class: 'r' }, [action]),
          ]);
        })),
      ]));
      if (res.tickets.length === 200) list.appendChild(el('p', { class: 'more-note', text: 'Showing the first 200. Narrow the search, or export the full list.' }));
    }
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    drawSeg();
    box.appendChild(el('div', { class: 'toolbar-row' }, [q, seg]));
    box.appendChild(list);
    load();
  }

  async function scansTab(box, ev) {
    var res = await api('GET', '/api/admin/events/' + ev.id + '/scans?limit=300');
    if (!res.scans.length) { box.appendChild(el('p', { class: 'muted', text: 'No scans yet.' })); return; }
    var labels = { admitted: ['ok', 'Admitted'], duplicate: ['dup', 'Already scanned'], void: ['void', 'Not valid'], not_found: ['warn', 'Not found'], undo: ['muted', 'Undone'] };
    box.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data' }, [
      el('thead', null, [el('tr', null, ['Time', 'Result', 'Guest', 'Door', 'How'].map(function (h) { return el('th', { text: h }); }))]),
      el('tbody', null, res.scans.map(function (s) {
        var l = labels[s.result] || ['muted', s.result];
        return el('tr', null, [
          el('td', { class: 'num', text: fmtClock(s.scanned_at) }),
          el('td', null, [el('span', { class: 'tag ' + l[0], text: l[1] }), s.note ? el('span', { class: 'sub', text: s.note.replace(/_/g, ' ') }) : null]),
          el('td', null, [s.holder_name ? el('strong', { text: s.holder_name }) : (s.code_raw ? el('span', { class: 'mono', text: String(s.code_raw).slice(0, 40) }) : ''), el('span', { class: 'sub', text: [s.ticket_type, s.platform ? platformName(s.platform) : ''].filter(Boolean).join(' · ') })]),
          el('td', { text: s.device_name || '' }),
          el('td', { class: 'muted', text: s.method + (s.offline ? ' · offline' : '') }),
        ]);
      })),
    ])]));
  }

  function testTab(box, ev) {
    var input = el('input', { class: 'search', placeholder: 'Paste or type what a QR contains', spellcheck: 'false' });
    var out = el('div');
    box.appendChild(el('p', { class: 'muted', text: 'Scan a ticket with any QR reader app and paste the text here to check it matches. Nobody gets admitted.' }));
    box.appendChild(el('form', { class: 'toolbar-row', onsubmit: async function (e) {
      e.preventDefault();
      var res = await api('POST', '/api/admin/events/' + ev.id + '/lookup', { code: input.value });
      out.textContent = '';
      out.appendChild(el('p', { class: 'muted' }, ['Tried: ', el('span', { class: 'mono', text: res.keys.join('  |  ') || '(empty)' })]));
      if (!res.tickets.length) { out.appendChild(el('p', { class: 'error', text: 'No ticket has this code. If it came from a URL or has extra characters, check the source export uses the same value.' })); return; }
      res.tickets.forEach(function (t) {
        out.appendChild(el('div', { class: 'source' }, [
          el('div', { class: 'head' }, [el('strong', { text: t.holderName || '(no name)' }), el('span', { class: 'badge', text: platformName(t.platform) })]),
          el('div', { class: 'muted', text: [t.ticketType, t.status === 'void' ? 'VOID: ' + (t.voidReason || '') : t.scannedAt ? 'Scanned ' + fmtClock(t.scannedAt) + ' by ' + (t.scannedBy || '?') : 'Valid, not scanned'].filter(Boolean).join(' · ') }),
        ]));
      });
    } }, [input, el('button', { class: 'primary', type: 'submit', text: 'Check' })]));
    box.appendChild(out);
  }

  function devicesTab(box, ev, data) {
    box.appendChild(el('p', { class: 'muted', text: 'Phones signed in to the door app for this event.' }));
    if (!data.devices.length) { box.appendChild(el('p', { class: 'muted', text: 'None yet.' })); return; }
    box.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data' }, [
      el('thead', null, [el('tr', null, ['Device', 'Signed in', 'Last seen', ''].map(function (h) { return el('th', { text: h }); }))]),
      el('tbody', null, data.devices.map(function (d) {
        return el('tr', null, [
          el('td', null, [el('strong', { text: d.name }), d.revoked ? el('span', { class: 'sub', text: 'Signed out' }) : null]),
          el('td', { text: fmtDate(d.createdAt) + ' ' + fmtClock(d.createdAt) }),
          el('td', { text: ago(d.lastSeenAt) }),
          el('td', { class: 'r' }, [d.revoked ? null : el('button', { type: 'button', class: 'xs danger', text: 'Sign out', onclick: async function () { await api('POST', '/api/admin/devices/' + d.id + '/revoke', {}); route(); } })]),
        ]);
      })),
    ])]));
  }

  function exportTab(box, ev) {
    box.appendChild(el('p', { class: 'muted', text: 'Spreadsheets for settling with co-promoters: every ticket with its platform and check-in time, and every scan. DICE ticket holders are left out of downloads (DICE\'s token terms).' }));
    box.appendChild(el('div', { class: 'head-actions' }, [
      el('a', { class: 'btn', href: '/api/admin/events/' + ev.id + '/export/tickets.csv', text: 'Tickets CSV' }),
      el('a', { class: 'btn', href: '/api/admin/events/' + ev.id + '/export/scans.csv', text: 'Scan log CSV' }),
    ]));
  }

  // ------------------------------------------------------------------ start

  (async function start() {
    try { await api('GET', '/api/admin/me', null, { allow401: true }); route(); } catch (e) { renderLogin(); }
  })();
})();
