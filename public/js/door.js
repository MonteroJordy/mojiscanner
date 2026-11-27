/* Door app: login, offline guest list, scanning, results, search, sync. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Codes = window.DoorCodes;

  var PLATFORM_NAMES = { shotgun: 'Shotgun', dice: 'DICE', ra: 'RA', bucketlisters: 'Bucket Listers', eventbrite: 'Eventbrite', posh: 'Posh', other: 'Other' };
  var VERDICTS = { admitted: 'Admit', duplicate: 'Already scanned', void: 'Not valid', not_found: 'Not found' };
  var WORDS = { admitted: 'Admit', duplicate: 'Already<br>scanned', void: 'Not<br>valid', not_found: 'Not<br>found' };
  var TAGS = { admitted: ['ok', 'Admit'], duplicate: ['dup', 'Already'], void: ['void', 'Not valid'], not_found: ['warn', 'Not found'] };
  var GLYPHS = { admitted: '✓', duplicate: '2×', void: '✕', not_found: '?' };
  var DEVICE_NAMES = ['Door 1', 'Door 2', 'VIP', 'Box office'];

  var session = load('door.session');
  var settings = Object.assign({ sound: true, test: false, nocamera: false }, load('door.settings') || {});

  var db = null;                 // IndexedDB for this event
  var tickets = new Map();       // id -> compact ticket {id,k,c,p,n,e,y,s,v,a,b}
  var byKey = new Map();         // code key -> Set(ids)
  var outbox = new Map();        // clientScanId -> queued scan
  var cursor = { rev: 0, id: 0 };
  var online = navigator.onLine !== false;
  var lastSyncAt = 0;
  var syncing = false;
  var syncError = '';
  var scanner = null;
  var handling = false;
  var resultTimer = null;
  var lastCode = '';
  var lastCodeAt = 0;
  var recent = [];
  var wakeLock = null;
  var audioCtx = null;
  var syncTimer = null;
  var hardwareListening = false;
  var testShowing = false;
  var lastAdmit = null;          // { id, name, at }: the undo bar on the scan screen

  // sign-in: 01 PIN → 02 event and door
  var pinValue = '';
  var pinLengths = [4];
  var doorEventsList = [];       // tonight's and upcoming events (no PIN needed to list them)
  var unlocked = [];             // events the typed PIN opens, with ticket and platform counts
  var setupEventId = null;
  var targetEvent = null;        // "Pick another": the event whose PIN we're asking for
  var unlocking = false;
  var deviceChoice = load('door.deviceName');

  // ------------------------------------------------------------------ utils

  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtShort(iso) { return fmtTime(iso).replace(/\s?[AP]M$/i, ''); }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] === undefined || attrs[k] === null) return;
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function show(id) { $(id).hidden = false; }
  function hide(id) { $(id).hidden = true; }
  function isMadeUp(t) { return !!(t && t.k && t.k.indexOf('NOQR-') === 0); }
  function eventLine(ev) { return [ev.name, ev.venue].filter(Boolean).join(' · '); }

  async function api(method, path, body, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 10000);
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (session && session.token) headers.Authorization = 'Bearer ' + session.token;
      var res = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: 'no-store' });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) { var err = new Error(data.error || 'HTTP ' + res.status); err.status = res.status; throw err; }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ IndexedDB

  function idbOpen(name) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      var req = indexedDB.open(name, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        d.createObjectStore('tickets', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: 'clientScanId' });
        d.createObjectStore('meta');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbTx(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!db) return resolve(null);
      var tx = db.transaction(store, mode);
      var out = fn(tx.objectStore(store));
      tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }
  function idbAll(store) { return idbTx(store, 'readonly', function (s) { return s.getAll(); }); }
  function idbPutMany(store, items) { return idbTx(store, 'readwrite', function (s) { items.forEach(function (i) { s.put(i); }); }); }
  function idbDeleteMany(store, keys) { return idbTx(store, 'readwrite', function (s) { keys.forEach(function (k) { s.delete(k); }); }); }
  function idbSetMeta(key, value) { return idbTx('meta', 'readwrite', function (s) { s.put(value, key); }); }
  function idbGetMeta(key) { return idbTx('meta', 'readonly', function (s) { return s.get(key); }); }

  // ------------------------------------------------------------------ local guest list

  function indexTicket(t) {
    var old = tickets.get(t.id);
    if (old && old.k !== t.k) { var set = byKey.get(old.k); if (set) set.delete(t.id); }
    tickets.set(t.id, t);
    var s = byKey.get(t.k);
    if (!s) { s = new Set(); byKey.set(t.k, s); }
    s.add(t.id);
  }

  function fromPublic(p) {
    return { id: p.id, k: Codes.codeKey(p.code), c: p.code, p: p.platform, n: p.holderName, e: p.holderEmail, y: p.ticketType, s: p.status, v: p.voidReason, a: p.scannedAt, b: p.scannedBy };
  }

  function rowsForKey(key) {
    var ids = byKey.get(key);
    return ids ? Array.from(ids, function (id) { return tickets.get(id); }).filter(Boolean) : [];
  }

  function localDecide(raw, ticketId) {
    var rows = [];
    if (ticketId) {
      var t = tickets.get(ticketId);
      if (t) {
        rows = rowsForKey(t.k);
        rows.sort(function (a, b) { return a.id === ticketId ? -1 : b.id === ticketId ? 1 : 0; });
      }
    } else {
      var keys = Codes.candidateKeys(raw);
      for (var i = 0; i < keys.length && !rows.length; i++) rows = rowsForKey(keys[i]);
    }
    var d = Codes.decide(rows.map(function (r) { return { row: r, status: r.s, scanned_at: r.a }; }));
    return { result: d.result, row: d.ticket ? d.ticket.row : null };
  }

  function markScannedLocally(key, at) {
    var changed = [];
    rowsForKey(key).forEach(function (r) {
      if (r.s === 'valid' && !r.a) { r.a = at; r.b = session.device.name; changed.push(r); }
    });
    if (changed.length) idbPutMany('tickets', changed).catch(function () {});
  }

  function counts() {
    var valid = new Set(), scanned = new Set();
    tickets.forEach(function (t) {
      if (t.s !== 'valid') return;
      valid.add(t.k);
      if (t.a) scanned.add(t.k);
    });
    return { valid: valid.size, scanned: scanned.size };
  }

  var countsQueued = false;
  function renderCounts() {
    if (countsQueued) return;
    countsQueued = true;
    setTimeout(function () {
      countsQueued = false;
      var c = counts();
      $('count-in').textContent = c.scanned.toLocaleString();
      $('count-total').textContent = c.valid.toLocaleString();
      $('search-counts').textContent = c.scanned.toLocaleString() + ' / ' + c.valid.toLocaleString();
    }, 150);
  }

  // ------------------------------------------------------------------ sync

  function setOnline(v) { online = v; renderStatus(); }

  function renderStatus() {
    var queued = outbox.size;
    var loading = cursor.rev === 0 && tickets.size === 0;
    var state = !online ? 'offline' : syncError ? 'error' : loading ? 'loading' : 'online';
    $('net').className = 'net ' + state;
    $('sync-text').textContent = state === 'offline' ? 'Offline' + (queued ? ' · ' + queued + ' saved' : '')
      : state === 'error' ? 'Sync error'
      : state === 'loading' ? 'Loading list'
      : queued ? 'Online · ' + queued + ' to sync'
      : 'Online';
    $('sync-title').textContent = lastSyncAt ? 'Synced ' + fmtTime(new Date(lastSyncAt).toISOString()) : 'Not synced yet';
    $('data-status').textContent = tickets.size.toLocaleString() + ' tickets · ' + queued + ' waiting' + (syncError ? ' · ' + syncError : '') + (!online ? ' · offline' : '');
  }

  async function flushOutbox() {
    if (!outbox.size) return;
    var batch = Array.from(outbox.values()).sort(function (a, b) { return a.scannedAt.localeCompare(b.scannedAt); }).slice(0, 200);
    var res = await api('POST', '/api/door/scans', { scans: batch }, 20000);
    var done = [];
    (res.results || []).forEach(function (r) {
      done.push(r.clientScanId);
      outbox.delete(r.clientScanId);
      if (r.ticket) { var t = fromPublic(r.ticket); indexTicket(t); }
    });
    await idbDeleteMany('outbox', done).catch(function () {});
  }

  async function pullChanges() {
    for (var page = 0; page < 100; page++) {
      var res = await api('GET', '/api/door/tickets?rev=' + cursor.rev + '&id=' + cursor.id, null, 20000);
      if (res.tickets.length) {
        res.tickets.forEach(indexTicket);
        await idbPutMany('tickets', res.tickets).catch(function () {});
      }
      cursor = res.cursor;
      await idbSetMeta('cursor', cursor).catch(function () {});
      renderCounts();
      renderStatus();
      if (!res.more) break;
    }
  }

  async function syncNow() {
    if (syncing || !session) return;
    syncing = true;
    try {
      await flushOutbox();
      await pullChanges();
      lastSyncAt = Date.now();
      syncError = '';
      setOnline(true);
    } catch (e) {
      if (e.status === 401) { sessionExpired(); return; }
      if (e.status) syncError = e.message; else setOnline(false);
    } finally {
      syncing = false;
      renderStatus();
    }
  }

  // ------------------------------------------------------------------ scanning

  async function handleCode(raw, method, ticketId) {
    if (!session || handling) return;
    if (!$('result').hidden) {
      // ADMIT moves on with the next QR; problems stay until Done, a tap or the timer.
      // A handheld scanner or a deliberate action always moves on.
      if (method === 'camera' && (!$('result').classList.contains('admitted') || raw === lastCode)) return;
      dismissResult();
    }
    if (testShowing && method === 'camera') return; // a test result is on screen: "Scan another" first
    var now = Date.now();
    if (!ticketId && raw === lastCode && now - lastCodeAt < 2500) return; // same QR still in front of the camera
    lastCode = raw || ''; lastCodeAt = now;
    if (settings.test && !ticketId) { showTest(raw); return; }

    handling = true;
    if (scanner) scanner.pause();
    var clientScanId = uuid();
    var scannedAt = new Date().toISOString();
    var local = localDecide(raw, ticketId);
    var out = null;

    if (navigator.onLine !== false) {
      try {
        var res = await api('POST', '/api/door/scan', { code: ticketId ? undefined : raw, ticketId: ticketId || undefined, clientScanId: clientScanId, scannedAt: scannedAt, method: method }, 2500);
        if (res.ticket) indexTicket(fromPublic(res.ticket));
        out = { result: res.result, row: res.ticket ? tickets.get(res.ticket.id) : null, offline: false, rechecking: !!res.rechecking };
        setOnline(true);
      } catch (e) {
        if (e.status === 401) { handling = false; sessionExpired(); return; }
        if (!e.status || e.status >= 500) setOnline(false);
      }
    }
    if (!out) {
      out = { result: local.result, row: local.row, offline: true };
      if (local.result === 'admitted') markScannedLocally(local.row.k, scannedAt);
      var q = { clientScanId: clientScanId, code: ticketId ? undefined : raw, ticketId: ticketId || undefined, scannedAt: scannedAt, method: method, localResult: local.result };
      outbox.set(clientScanId, q);
      idbPutMany('outbox', [q]).catch(function () {});
    }
    recent.unshift({ at: scannedAt, result: out.result, row: out.row, raw: raw, offline: out.offline, method: method });
    if (recent.length > 40) recent.pop();
    renderCounts();
    renderStatus();
    handling = false;
    showResult(out, raw);
  }

  function voidReason(v) {
    var s = String(v || '');
    if (/no longer on|not in the latest|missing/i.test(s)) return 'Not on the list anymore';
    if (/refund/i.test(s)) return 'Refunded';
    if (/resold|resale/i.test(s)) return 'Resold';
    if (/cancel/i.test(s)) return 'Canceled';
    if (/transfer/i.test(s)) return 'Transferred';
    if (/return/i.test(s)) return 'Returned';
    if (/payment plan|unpaid|pending/i.test(s)) return 'Not paid yet';
    return 'No longer valid';
  }

  function showResult(out, raw) {
    var r = out.row;
    var res = out.result;
    var box = $('result');
    box.className = 'result ' + res;
    var glyph = res === 'not_found' && out.rechecking ? '10' : GLYPHS[res] || '';
    $('r-glyph').textContent = glyph;
    $('r-glyph').className = 'r-glyph' + (glyph.length > 1 ? ' small' : '');
    $('r-verdict').innerHTML = WORDS[res] || '';
    $('r-offline').hidden = !out.offline;

    var name = '', line1 = '', line2 = '';
    var platform = r ? (PLATFORM_NAMES[r.p] || r.p) : '';
    if (res === 'admitted') {
      name = r ? (r.n || 'Ticket holder') : '';
      line1 = r && r.y ? r.y : '';
      line2 = out.offline ? 'Saved on this phone. Syncs when back online.' : '';
      if (r) { lastAdmit = { id: r.id, name: name, at: new Date().toISOString() }; renderLastAdmit(); }
    } else if (res === 'duplicate') {
      name = r ? (r.n || 'Ticket holder') : '';
      line1 = r && r.a ? 'First scanned ' + fmtTime(r.a) + (r.b ? (/scanner$/i.test(r.b) ? ' by ' : ' at ') + r.b : '') : 'Already used';
      line2 = [r && r.y, platform].filter(Boolean).join(' · ');
    } else if (res === 'void') {
      name = r ? (r.n || 'Ticket holder') : '';
      line1 = voidReason(r && r.v);
      var why = r && r.v ? String(r.v).trim() : '';
      line2 = (why && why.toLowerCase() !== line1.toLowerCase() ? why.replace(/\.?$/, '. ') : '') + 'Do not admit.';
    } else if (res === 'not_found') {
      line1 = out.rechecking ? 'Checking the ticket platforms.' : 'Not on any list.';
      line2 = out.rechecking ? 'Scan again in 10 seconds.' : 'Ask for their name or email.';
    }
    $('r-who').textContent = name;
    $('r-who').hidden = !name;
    $('r-detail').textContent = line1;
    $('r-detail').hidden = !line1;
    $('r-what').textContent = line2;
    $('r-what').hidden = !line2;
    $('r-platform').textContent = platform;
    $('r-badge-row').hidden = !(res === 'admitted' && platform);
    $('r-actions').hidden = res === 'admitted';
    $('r-search').hidden = !(res === 'not_found' && !out.rechecking);

    box.hidden = false;
    feedback(res);
    var dur = res === 'admitted' ? 1500 : 4000;
    var fill = $('r-fill');
    fill.style.transition = 'none';
    fill.style.width = '100%';
    void fill.offsetWidth;
    fill.style.transition = 'width ' + dur + 'ms linear';
    fill.style.width = '0%';
    clearTimeout(resultTimer);
    resultTimer = setTimeout(dismissResult, dur);
    // Keep the camera reading during ADMIT so the next guest's QR can come straight in.
    if (res === 'admitted' && scanner && pagesClosed()) scanner.resume();
  }

  function renderLastAdmit() {
    var box = $('last-admit');
    if (!lastAdmit || settings.test) { box.hidden = true; return; }
    $('last-admit-text').textContent = lastAdmit.name + ' admitted · ' + fmtShort(lastAdmit.at);
    box.hidden = false;
  }

  function dismissResult() {
    clearTimeout(resultTimer);
    $('result').hidden = true;
    if (scanner && pagesClosed()) scanner.resume();
  }

  // ------------------------------------------------------------------ test mode

  function applyTestMode() {
    $('scan').classList.toggle('test-mode', !!settings.test);
    $('test-banner').hidden = !settings.test;
    if (!settings.test) closeTest();
    renderLastAdmit();
  }

  function showTest(raw) {
    var local = localDecide(raw);
    var r = local.row;
    testShowing = true;
    if (scanner) scanner.pause();
    $('t-raw').textContent = raw;
    var rows = $('t-rows');
    rows.textContent = '';
    function kv(k, v) { rows.appendChild(el('div', { class: 'kv' }, [el('span', { class: 'k', text: k }), v])); }
    kv('On the list', el('span', { class: 'v yes', text: r ? 'YES' : 'NO' }));
    if (r) {
      kv('Guest', el('span', { class: 'v', text: [r.n || 'Ticket holder', r.y].filter(Boolean).join(' · ') }));
      kv('Platform', el('span', { class: 'v', text: PLATFORM_NAMES[r.p] || r.p }));
      kv('Status', el('span', { class: 'v', text: r.s !== 'valid' ? 'Void · ' + voidReason(r.v) : r.a ? 'Valid · scanned ' + fmtTime(r.a) : 'Valid · not scanned' }));
    }
    var tag = TAGS[local.result];
    kv('Door would show', el('span', { class: 'v' }, [el('span', { class: 'tag ' + tag[0], text: tag[1] })]));
    $('test-sheet').hidden = false;
    $('scan').classList.add('testing');
    feedback(local.result === 'admitted' ? 'admitted' : 'other');
  }

  function closeTest() {
    testShowing = false;
    $('test-sheet').hidden = true;
    $('scan').classList.remove('testing');
    lastCode = '';
    if (scanner && pagesClosed() && $('result').hidden) scanner.resume();
  }

  // ------------------------------------------------------------------ feedback

  async function undo(ticketId) {
    try {
      var res = await api('POST', '/api/door/undo', { ticketId: ticketId }, 4000);
      if (res.ticket) indexTicket(fromPublic(res.ticket));
      var t = tickets.get(ticketId);
      if (t) rowsForKey(t.k).forEach(function (x) { x.a = null; x.b = null; });
      recent.forEach(function (r) { if (r.row && r.row.id === ticketId && r.result === 'admitted') r.undone = true; });
      if (lastAdmit && lastAdmit.id === ticketId) lastAdmit = null;
      renderLastAdmit();
      renderCounts();
      renderRecent();
      toast('Undone. That ticket can be scanned again.');
    } catch (e) {
      toast(e.status ? e.message : 'Undo needs a connection.');
    }
  }

  function feedback(result) {
    var good = result === 'admitted';
    if (navigator.vibrate) navigator.vibrate(good ? 60 : [180, 80, 180]);
    if (!settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      var t = audioCtx.currentTime;
      o.type = good ? 'sine' : 'square';
      o.frequency.setValueAtTime(good ? 880 : 220, t);
      if (!good) o.frequency.setValueAtTime(170, t + 0.18);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(good ? 0.3 : 0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (good ? 0.14 : 0.4));
      o.start(t); o.stop(t + (good ? 0.15 : 0.42));
    } catch (e) { /* no audio */ }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // ------------------------------------------------------------------ search / type code / more

  // A typed code (no spaces, has a digit) is checked like a scan; names and emails just filter the list.
  function looksLikeCode(raw) { return raw.length >= 4 && !/\s|@/.test(raw) && /\d/.test(raw); }

  function checkTypedCode(raw) {
    closePages(true);
    lastCode = '';
    handleCode(raw, 'manual');
  }

  function renderSearch() {
    var raw = $('search-input').value.trim();
    var q = raw.toLowerCase();
    var list = $('search-results');
    var empty = $('search-empty');
    list.textContent = '';
    empty.textContent = '';
    empty.hidden = true;
    $('search-clear').hidden = !q;
    $('search-order').hidden = true;
    if (q.length < 2) { $('search-count').textContent = q ? 'Keep typing' : ''; return; }
    // The exact code under a QR finds that ticket directly, ahead of everything else.
    var exact = new Set();
    Codes.candidateKeys(raw).forEach(function (k) { rowsForKey(k).forEach(function (t) { exact.add(t.id); }); });
    var key = Codes.codeKey(q);
    var hits = [];
    tickets.forEach(function (t) {
      if (exact.has(t.id) || (t.n && t.n.toLowerCase().indexOf(q) !== -1) || (t.e && t.e.toLowerCase().indexOf(q) !== -1) || (!isMadeUp(t) && t.k && t.k.indexOf(key) !== -1)) hits.push(t);
    });
    function rank(t) { return exact.has(t.id) ? 0 : t.s !== 'valid' ? 3 : t.a ? 2 : 1; } // not in yet first
    hits.sort(function (a, b) { return rank(a) - rank(b) || String(a.n || '').localeCompare(String(b.n || '')); });
    $('search-count').textContent = hits.length ? hits.length + (hits.length === 1 ? ' guest' : ' guests') + (hits.length > 60 ? ' · first 60' : '') : '';
    $('search-order').hidden = hits.length < 2;
    hits.slice(0, 60).forEach(function (t) {
      var right = t.s !== 'valid' ? el('span', { class: 'void-tag', text: 'VOID' })
        : t.a ? el('span', { class: 'in-tag', text: 'IN ' + fmtTime(t.a) })
        : el('button', { type: 'button', class: 'primary admit', text: 'Admit', 'aria-label': 'Admit ' + (t.n || 'guest'), onclick: function () { closePages(true); handleCode(null, 'search', t.id); } });
      list.appendChild(el('li', null, [
        el('div', { class: 'who' }, [
          el('div', { class: 'nm' }, [t.n || '(no name)', isMadeUp(t) ? el('span', { class: 'tag noqr', text: 'no QR' }) : null]),
          el('div', { class: 'meta', text: [t.y, PLATFORM_NAMES[t.p] || t.p, t.e].filter(Boolean).join(' · ') }),
        ]),
        right,
      ]));
    });
    if (!hits.length) {
      empty.hidden = false;
      if (looksLikeCode(raw)) {
        empty.appendChild(el('p', { text: 'No guest on this phone has that code. It may be a ticket sold in the last few minutes.' }));
        empty.appendChild(el('button', { type: 'button', class: 'primary check-code', text: 'Check code ' + raw.toUpperCase(), onclick: function () { checkTypedCode(raw); } }));
      } else {
        empty.appendChild(el('p', { text: 'No guests match. Check the spelling, or try their email.' }));
      }
    }
  }

  function resultTag(result) {
    var t = TAGS[result] || ['muted', result];
    return el('span', { class: 'tag ' + t[0], text: t[1] });
  }

  function renderRecent() {
    var list = $('recent');
    list.textContent = '';
    $('recent-empty').hidden = recent.length > 0;
    recent.slice(0, 25).forEach(function (r) {
      var row = r.row;
      var canUndo = r.result === 'admitted' && row && !r.undone;
      list.appendChild(el('div', { class: 'item' }, [
        el('span', { class: 'time', text: fmtShort(r.at) }),
        el('span', { class: 'nm', text: row ? (row.n || 'Ticket holder') : String(r.raw || '').slice(0, 40) }),
        r.undone ? el('span', { class: 'tag muted', text: 'Undone' }) : resultTag(r.result),
        canUndo ? el('button', { type: 'button', class: 'undo', text: 'Undo', onclick: function () { undo(row.id); } }) : el('span', { class: 'undo-space' }),
      ]));
    });
  }

  function pagesClosed() { return $('search').hidden && $('menu').hidden; }

  function openPage(id) {
    closePages(true);
    if (scanner) scanner.pause();
    show(id);
  }
  function closePages(keepPaused) {
    ['search', 'menu'].forEach(hide);
    if (!keepPaused && scanner && $('result').hidden && !testShowing) scanner.resume();
  }

  // ------------------------------------------------------------------ camera

  async function startCamera() {
    var msg = $('camera-msg');
    msg.hidden = true;
    var noCam = !!settings.nocamera;
    $('scanner-mode').hidden = !noCam;
    $('frame').hidden = noCam;
    $('scan-hint').hidden = noCam;
    $('btn-camera').hidden = noCam;
    if (noCam) { $('btn-torch').hidden = true; if (scanner) scanner.stopCamera(); return; }
    if (!scanner) scanner = new window.DoorScanner($('video'), function (text, method) { handleCode(text, method); });
    try {
      var info = await scanner.start();
      $('btn-torch').hidden = !info.torch;
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera access is blocked. Allow the camera for this site in your browser settings, then reload.'
        : (e && e.message) || 'Could not start the camera.';
      msg.hidden = false;
      $('scan-hint').hidden = true;
    }
  }

  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  }

  // ------------------------------------------------------------------ 01 door PIN

  function maxPinLen() { return Math.max.apply(null, pinLengths.concat([4])); }

  function renderPinBoxes() {
    var len = Math.max(maxPinLen(), pinValue.length);
    var wrap = $('pin-boxes');
    wrap.style.setProperty('--pin-len', String(len));
    wrap.textContent = '';
    for (var i = 0; i < len; i++) wrap.appendChild(el('div', { class: 'pin-box' + (i < pinValue.length ? ' filled' : '') }));
  }

  function setPinTitle(forEvent) {
    var title = $('pin-title');
    title.textContent = '';
    if (forEvent) { title.appendChild(document.createTextNode('Enter the PIN for')); title.appendChild(el('br')); title.appendChild(document.createTextNode(forEvent.name)); }
    else { title.appendChild(document.createTextNode('Enter tonight’s')); title.appendChild(el('br')); title.appendChild(document.createTextNode('door PIN')); }
    $('pin-sub').textContent = forEvent ? [forEvent.venue, fmtWhen(forEvent.startsAt)].filter(Boolean).join(' · ') || 'The promoter has it on the event page.' : 'The promoter has it on the event page.';
  }

  async function showPin(message, forEvent) {
    ['scan', 'setup', 'pick'].forEach(hide);
    show('pin');
    targetEvent = forEvent || null;
    pinValue = '';
    setPinTitle(targetEvent);
    $('pin-error').textContent = message || '';
    renderPinBoxes();
    try {
      var res = await api('GET', '/api/door/events');
      doorEventsList = res.events || [];
      pinLengths = (res.pinLengths && res.pinLengths.length) ? res.pinLengths : [4];
      renderPinBoxes();
      if (!doorEventsList.length && !message) $('pin-error').textContent = 'No events are open for scanning yet. Create one in the admin first.';
    } catch (e) {
      if (!message) $('pin-error').textContent = 'Could not reach the server. Check the connection.';
    }
  }

  function pressKey(k) {
    if (unlocking || $('pin').hidden) return;
    if (k === 'back') pinValue = pinValue.slice(0, -1);
    else if (/^\d$/.test(k) && pinValue.length < 12) pinValue += k;
    else return;
    $('pin-error').textContent = '';
    renderPinBoxes();
    if (k !== 'back' && pinLengths.indexOf(pinValue.length) !== -1) tryUnlock();
  }

  async function tryUnlock() {
    unlocking = true;
    try {
      var res = await api('POST', '/api/door/unlock', { pin: pinValue });
      unlocked = res.events || [];
      if (targetEvent && unlocked.some(function (e) { return e.id === targetEvent.id; })) setupEventId = targetEvent.id;
      showSetup();
    } catch (e) {
      if (e.status === 401 && pinValue.length < maxPinLen()) return; // a longer PIN may still be on its way
      wrongPin(e.status === 401 ? 'Wrong PIN' : e.status === 429 ? e.message : 'Could not reach the server. Check the connection.');
    } finally {
      unlocking = false;
    }
  }

  function wrongPin(message) {
    var boxes = $('pin-boxes');
    boxes.classList.remove('shake');
    void boxes.offsetWidth;
    boxes.classList.add('shake');
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    $('pin-error').textContent = message;
    setTimeout(function () { pinValue = ''; renderPinBoxes(); }, 380);
  }

  // ------------------------------------------------------------------ 02 event and door

  function liveRank(e) {
    var t = Date.parse(e.startsAt);
    if (isNaN(t)) return 2;
    var now = Date.now();
    return now >= t - 12 * 3600e3 && now <= t + 10 * 3600e3 ? 0 : 1;
  }

  function eventCard(e, on, onclick) {
    var stats = e.tickets !== undefined ? el('div', { class: 'st' }, [el('span', { text: Number(e.tickets).toLocaleString() + ' tickets' }), el('span', { class: 'm', text: e.platforms + (e.platforms === 1 ? ' platform' : ' platforms') })]) : null;
    return el('button', { type: 'button', class: 'ev-card' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false', 'data-id': e.id, onclick: onclick }, [
      el('div', { class: 'nm', text: e.name }),
      el('div', { class: 'wh', text: [e.venue, fmtWhen(e.startsAt)].filter(Boolean).join(' · ') || 'No date set' }),
      stats,
    ]);
  }

  function showSetup() {
    ['pin', 'pick'].forEach(hide);
    show('setup');
    $('setup-error').textContent = '';
    var list = unlocked.slice().sort(function (a, b) { return liveRank(a) - liveRank(b) || String(a.startsAt).localeCompare(String(b.startsAt)); });
    if (!list.some(function (e) { return e.id === setupEventId; })) {
      // Tonight is pre-picked. Two shows tonight on the same PIN: the person picks, so nobody scans the wrong list.
      setupEventId = list.length === 1 || (list.length > 1 && liveRank(list[0]) < liveRank(list[1])) ? list[0].id : null;
    }
    $('setup-when').textContent = list.length > 1 ? (liveRank(list[0]) === 0 ? 'Tonight: pick one' : 'Pick one') : (list[0] && liveRank(list[0]) === 0 ? 'Tonight' : 'Next up');
    var box = $('setup-events');
    box.textContent = '';
    list.forEach(function (e) { box.appendChild(eventCard(e, e.id === setupEventId, function () { setupEventId = e.id; showSetup(); })); });
    $('pick-another').hidden = !doorEventsList.some(function (e) { return !list.some(function (u) { return u.id === e.id; }); });
    if (DEVICE_NAMES.indexOf(deviceChoice) === -1) deviceChoice = DEVICE_NAMES[0];
    var grid = $('door-grid');
    grid.textContent = '';
    DEVICE_NAMES.forEach(function (name) {
      var on = name === deviceChoice;
      grid.appendChild(el('button', { type: 'button', class: on ? 'on' : '', role: 'radio', 'aria-checked': on ? 'true' : 'false', text: name, onclick: function () { deviceChoice = name; showSetup(); } }));
    });
    $('start-btn').disabled = !setupEventId;
  }

  function showPick() {
    hide('setup');
    show('pick');
    var list = $('pick-list');
    list.textContent = '';
    doorEventsList.forEach(function (e) {
      var open = unlocked.filter(function (u) { return u.id === e.id; })[0];
      list.appendChild(eventCard(open || e, e.id === setupEventId, function () {
        if (open) { setupEventId = e.id; showSetup(); }
        else showPin('', e);
      }));
    });
  }

  async function startFromSetup() {
    $('setup-error').textContent = '';
    if (!setupEventId) { $('setup-error').textContent = 'Pick the event first.'; return; }
    $('start-btn').disabled = true;
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* ignore */ }
    try {
      var res = await api('POST', '/api/door/login', { eventId: setupEventId, pin: pinValue, deviceName: deviceChoice });
      session = { token: res.token, event: res.event, device: res.device };
      save('door.session', session);
      save('door.deviceName', deviceChoice);
      pinValue = '';
      hide('setup');
      await startScanning();
    } catch (e) {
      var ev = doorEventsList.filter(function (x) { return x.id === setupEventId; })[0];
      if (e.status === 401 && ev) showPin('That PIN doesn’t open this event.', ev);
      else $('setup-error').textContent = e.message || 'Could not sign in';
    } finally {
      $('start-btn').disabled = false;
    }
  }

  async function startScanning() {
    ['pin', 'setup', 'pick'].forEach(hide);
    show('scan');
    lastAdmit = null;
    renderLastAdmit();
    $('menu-device').textContent = session.device.name;
    $('btn-logout').textContent = 'Sign out of ' + session.device.name;
    applyTestMode();
    tickets.clear(); byKey.clear(); outbox.clear();
    cursor = { rev: 0, id: 0 };
    try {
      db = await idbOpen('door-' + session.event.id);
      var stored = await idbAll('tickets');
      (stored || []).forEach(indexTicket);
      var q = await idbAll('outbox');
      (q || []).forEach(function (s) { outbox.set(s.clientScanId, s); });
      var c = await idbGetMeta('cursor');
      if (c && typeof c.rev === 'number') cursor = c;
    } catch (e) {
      db = null; // works from memory only (some private browsing modes)
    }
    renderCounts();
    renderStatus();
    startCamera();
    if (!hardwareListening) { window.listenForHardwareScanner(function (code, method) { handleCode(code, method); }); hardwareListening = true; }
    keepAwake();
    clearInterval(syncTimer);
    syncTimer = setInterval(function () { if (!document.hidden) syncNow(); }, 4000);
    syncNow();
  }

  function sessionExpired() {
    stopEverything();
    session = null;
    save('door.session', null);
    showPin('This phone was signed out. Enter the PIN again.');
  }

  function stopEverything() {
    clearInterval(syncTimer);
    if (scanner) scanner.stopCamera();
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    closePages(true);
    closeTest();
    hide('result');
  }

  async function logout() {
    if (outbox.size && !confirm(outbox.size + ' scans have not uploaded yet. Sign out anyway? They will be lost.')) return;
    var name = session && session.event ? 'door-' + session.event.id : null;
    stopEverything();
    if (db) { db.close(); db = null; }
    if (name && window.indexedDB) indexedDB.deleteDatabase(name); // guest details don't stay on a shared phone
    session = null;
    save('door.session', null);
    tickets.clear(); byKey.clear(); outbox.clear(); recent = []; lastAdmit = null;
    showPin('');
  }

  // ------------------------------------------------------------------ wire up

  function bind() {
    // 01 PIN: on-screen keypad, or a keyboard
    $('keypad').addEventListener('click', function (e) { var b = e.target.closest('button[data-key]'); if (b) pressKey(b.getAttribute('data-key')); });
    document.addEventListener('keydown', function (e) {
      if ($('pin').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); pressKey(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); pressKey('back'); }
    });
    // 02 event and door
    $('start-btn').addEventListener('click', startFromSetup);
    $('pick-another').addEventListener('click', showPick);
    $('pick-close').addEventListener('click', showSetup);

    $('result').addEventListener('click', dismissResult);
    $('r-done').addEventListener('click', function (e) { e.stopPropagation(); dismissResult(); });
    $('r-search').addEventListener('click', function (e) { e.stopPropagation(); dismissResult(); openSearch(); });
    $('last-undo').addEventListener('click', function () { if (lastAdmit) undo(lastAdmit.id); });

    $('btn-search').addEventListener('click', openSearch);
    $('search-input').addEventListener('input', renderSearch);
    $('search-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var raw = $('search-input').value.trim();
      if (looksLikeCode(raw)) checkTypedCode(raw);
    });
    $('search-clear').addEventListener('click', function () { $('search-input').value = ''; renderSearch(); $('search-input').focus(); });
    $('search-close').addEventListener('click', function () { closePages(); });

    $('btn-menu').addEventListener('click', function () { renderRecent(); renderStatus(); openPage('menu'); });
    function openSearch() { openPage('search'); $('search-input').value = ''; renderSearch(); setTimeout(function () { $('search-input').focus(); }, 50); }
    $('menu-close').addEventListener('click', function () { closePages(); });
    $('btn-camera').addEventListener('click', async function () {
      if (settings.nocamera || !scanner) return startCamera();
      try { var info = await scanner.nextCamera(); if (info) $('btn-torch').hidden = !info.torch; else toast('Only one camera on this phone.'); } catch (e) { toast('Could not switch camera.'); }
    });
    $('btn-torch').addEventListener('click', async function () {
      var on = await scanner.toggleTorch();
      $('btn-torch').classList.toggle('on', !!on);
    });
    $('t-again').addEventListener('click', closeTest);
    $('t-exit').addEventListener('click', function () { settings.test = false; save('door.settings', settings); $('set-test').checked = false; applyTestMode(); });
    $('btn-sync-now').addEventListener('click', function () { syncNow(); toast('Syncing…'); });
    $('btn-logout').addEventListener('click', logout);
    $('set-sound').checked = settings.sound;
    $('set-test').checked = settings.test;
    $('set-nocamera').checked = settings.nocamera;
    $('set-sound').addEventListener('change', function (e) { settings.sound = e.target.checked; save('door.settings', settings); });
    $('set-test').addEventListener('change', function (e) { settings.test = e.target.checked; save('door.settings', settings); applyTestMode(); });
    $('set-nocamera').addEventListener('change', function (e) { settings.nocamera = e.target.checked; save('door.settings', settings); startCamera(); });
    window.addEventListener('online', function () { setOnline(true); syncNow(); });
    window.addEventListener('offline', function () { setOnline(false); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && session) { keepAwake(); syncNow(); }
    });
  }

  bind();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* offline cache unavailable */ });
  }
  if (session && session.token) startScanning(); else showPin();

  // Exposed for automated tests only.
  window.__door = { handleCode: handleCode, state: function () { return { tickets: tickets.size, outbox: outbox.size, online: online, cursor: cursor, counts: counts() }; } };
})();
