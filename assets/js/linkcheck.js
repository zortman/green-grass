/* Link block checker.
   Runs entirely in the visitor's browser, so results reflect THEIR
   network and filter. Two probes per site:
     1. network probe  — no-cors fetch of the origin (did the request go through?)
     2. content probe  — load /favicon.ico as an image (did we get the real
        site back, or a filter's block page?)
   A control request to a known-good host tells us if the device is offline. */

const CONTROL = 'https://www.gstatic.com/generate_204';

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function netProbe(url, ms) {
  const t0 = performance.now();
  try {
    await withTimeout(fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', redirect: 'follow' }), ms);
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, timeout: e.message === 'timeout', ms: Math.round(performance.now() - t0) };
  }
}

function imgProbe(url, ms) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => { clearTimeout(t); img.onload = img.onerror = null; resolve(ok); };
    const t = setTimeout(() => done(false), ms);
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

export function normalizeTarget(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return u; } catch { return null; }
}

let controlCache = null;
export async function isOnline() {
  if (controlCache && Date.now() - controlCache.at < 15000) return controlCache.ok;
  const r = await netProbe(CONTROL + '?t=' + Date.now(), 5000);
  controlCache = { ok: r.ok, at: Date.now() };
  return r.ok;
}

/**
 * Returns { url, host, status, label, detail, ms }
 * status: 'ok' | 'partial' | 'blocked' | 'offline' | 'invalid'
 */
export async function checkLink(input, { timeout = 7000 } = {}) {
  const u = normalizeTarget(input);
  if (!u) return { url: input, host: input, status: 'invalid', label: 'Invalid URL', detail: 'That doesn’t look like a web address.' };
  if (u.protocol === 'http:' && location.protocol === 'https:') {
    // Mixed content would always fail from an https page — test https instead.
    u.protocol = 'https:';
  }
  const bust = `?gg=${Date.now()}`;
  const [net, fav] = await Promise.all([
    netProbe(u.origin + '/' + bust, timeout),
    imgProbe(u.origin + '/favicon.ico' + bust, timeout),
  ]);
  const base = { url: u.href, host: u.host, ms: net.ms };
  if (net.ok && fav) return { ...base, status: 'ok', label: 'Reachable', detail: 'The site responded and served its own content.' };
  if (net.ok) return { ...base, status: 'partial', label: 'Reachable (unverified)', detail: 'The request went through, but we couldn’t confirm the real site loaded. It may be fine, or a filter may be showing a block page.' };
  const online = await isOnline();
  if (!online) return { ...base, status: 'offline', label: 'You’re offline', detail: 'The control check failed too, so this result can’t be trusted.' };
  if (fav) return { ...base, status: 'ok', label: 'Reachable', detail: 'Site content loaded.' };
  return { ...base, status: 'blocked', label: net.timeout ? 'Blocked or timed out' : 'Blocked or down', detail: 'Other sites load fine, but this one didn’t. It’s likely filtered on this network, or the site is down.' };
}

export async function checkMany(list, onResult, concurrency = 4) {
  const queue = [...list];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const r = await checkLink(item.url ?? item);
      onResult?.(item, r);
    }
  });
  await Promise.all(workers);
}
