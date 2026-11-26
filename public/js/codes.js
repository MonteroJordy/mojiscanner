/*
 * Shared by the server and the door app, so a code is matched the same way online and offline.
 *
 * Every platform's QR holds a string. We store that string as-is (`code`) and also a lookup key
 * (`code_key`): trimmed, invisible characters removed, upper-cased. When something is scanned we
 * try a few candidate keys, because some tickets wrap the code in a URL and some hardware scanners
 * add a prefix.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DoorCodes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Control characters, zero-width characters and BOMs that scanners and spreadsheets leave behind.
  var INVISIBLE = /[\u0000-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g;

  function clean(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(INVISIBLE, '').trim();
  }

  function codeKey(value) {
    return clean(value).toUpperCase();
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /** Keys to try for a scanned value, most specific first. */
  function candidateKeys(raw) {
    var seen = {};
    var out = [];
    function add(v) {
      var k = codeKey(v);
      if (k && !seen[k]) { seen[k] = true; out.push(k); }
    }
    var c = clean(raw);
    if (!c) return out;
    add(c);

    // AIM symbology prefix some handheld scanners add, e.g. "]Q1" for QR codes.
    var aim = /^\][A-Za-z][0-9A-Za-z](.+)$/.exec(c);
    if (aim) add(aim[1]);

    // Tickets that encode a URL: try the last path segment, every query value and the fragment.
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(c)) {
      if (typeof URL === 'function') {
        try {
          var u = new URL(c);
          var segs = u.pathname.split('/').filter(Boolean);
          if (segs.length) add(safeDecode(segs[segs.length - 1]));
          u.searchParams.forEach(function (v) { if (v) add(v); });
          if (u.hash && u.hash.length > 1) add(safeDecode(u.hash.slice(1)));
        } catch (e) { /* not a URL after all */ }
      }
    } else {
      // Values like "TICKET:12345" or "ID=12345".
      var kv = /^[A-Za-z_ ]{1,20}[:=]\s*([^\s]+)$/.exec(c);
      if (kv) add(kv[1]);
    }

    return out;
  }

  /**
   * Decide what happens at the door, given every ticket row that matches the scanned value.
   * Mirrors the server logic so offline decisions agree with online ones.
   */
  function decide(rows) {
    if (!rows || rows.length === 0) return { result: 'not_found' };
    var valid = rows.filter(function (r) { return r.status === 'valid'; });
    if (valid.length === 0) return { result: 'void', ticket: rows[0] };
    var unscanned = valid.filter(function (r) { return !r.scanned_at; });
    if (unscanned.length === 0) {
      var first = valid.slice().sort(function (a, b) { return String(a.scanned_at).localeCompare(String(b.scanned_at)); })[0];
      return { result: 'duplicate', ticket: first };
    }
    return { result: 'admitted', ticket: unscanned[0] };
  }

  return { clean: clean, codeKey: codeKey, candidateKeys: candidateKeys, decide: decide };
});
