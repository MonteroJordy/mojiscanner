'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ConnectorError extends Error {
  constructor(message, { status, hint } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/**
 * JSON request with a timeout and retries for 429/5xx. Never logs tokens.
 * `fetchImpl` is injectable so tests can point connectors at a fake platform.
 */
async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 3, platform = 'API' } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt <= retries) { await sleep(500 * 2 ** attempt); continue; }
      throw new ConnectorError(`${platform}: network error (${err.name === 'TimeoutError' ? 'timed out' : err.message})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const detail = data && (data.error_description || data.message || data.error || (data.errors && data.errors[0] && data.errors[0].message));
      const hint = res.status === 401 || res.status === 403 ? 'Check the token: it may be wrong, expired, or missing permissions.' : undefined;
      throw new ConnectorError(`${platform}: HTTP ${res.status}${detail ? ` – ${String(detail).slice(0, 300)}` : ''}`, { status: res.status, hint });
    }
    if (data === null) throw new ConnectorError(`${platform}: expected JSON, got something else`);
    return data;
  }
}

module.exports = { requestJson, ConnectorError, sleep };
