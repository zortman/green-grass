/* =====================================================================
   GREEN GRASS EMULATOR — runtime
   Runs any HTML document inside a sandboxed iframe.
   - Strict isolation (default): the file runs in an opaque origin and
     can't touch this site's storage or sign-in. A storage shim gives it
     a working localStorage/sessionStorage/cookie that is persisted by
     the parent page, so game saves survive reloads.
   - Compatibility mode: same-origin, for trusted files that need real
     IndexedDB etc.
   - A console bridge forwards logs and errors to the host page.
   ===================================================================== */

const SANDBOX_STRICT =
  'allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-downloads allow-orientation-lock allow-presentation';
const ALLOW = 'fullscreen; autoplay; gamepad; clipboard-read; clipboard-write; accelerometer; gyroscope; microphone; camera';

/* ---------- source helpers ---------- */
export function extractDriveId(input) {
  const s = String(input || '').trim();
  const m =
    s.match(/\/file\/d\/([\w-]{20,})/) ||
    s.match(/[?&]id=([\w-]{20,})/) ||
    s.match(/\/d\/([\w-]{20,})/) ||
    s.match(/^([\w-]{20,})$/);
  return m ? m[1] : null;
}

export function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  // github.com/<u>/<r>/blob/<b>/file.html -> raw
  const gh = s.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (gh) s = `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
  return s;
}

export async function fetchDriveHtml(id, settings = {}) {
  const errors = [];
  if (settings.emulatorApi) {
    try {
      const api = settings.emulatorApi.trim();
      const r = await fetch(`${api}${api.includes('?') ? '&' : '?'}id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok) return { html: j.html, name: j.name || 'Drive file' };
      errors.push(j.error || 'Backend returned an error');
    } catch (e) {
      errors.push('Emulator backend unreachable');
    }
  }
  if (settings.driveApiKey) {
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(settings.driveApiKey)}`);
      if (r.ok) return { html: await r.text(), name: 'Drive file' };
      errors.push(`Drive API responded ${r.status}${r.status === 404 ? ' (is the file shared "Anyone with the link"?)' : ''}`);
    } catch {
      errors.push('Drive API unreachable');
    }
  }
  if (!settings.emulatorApi && !settings.driveApiKey) {
    const e = new Error('No Drive backend is configured yet. An admin needs to deploy the Green Grass Emulator backend (see SETUP.md).');
    e.code = 'NO_BACKEND';
    throw e;
  }
  throw new Error(errors.join(' · '));
}

export async function fetchUrlHtml(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.text();
}

/* ---------- document building ---------- */
function shimScript({ channel, storageKey, initial }) {
  const init = JSON.stringify(initial || {}).replace(/</g, '\\u003c');
  return `<script>(function(){var CH=${JSON.stringify(channel)},KEY=${JSON.stringify(storageKey || '')},INIT=${init};
function post(m){try{m.__gg=CH;parent.postMessage(m,'*')}catch(e){}}
function fmt(v){try{if(v instanceof Error)return v.stack||String(v);if(v&&typeof v==='object')return JSON.stringify(v).slice(0,2000);return String(v)}catch(e){return String(v)}}
['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){try{post({t:'console',level:l,args:[].slice.call(arguments).map(fmt)})}catch(e){}return o&&o.apply(console,arguments)}});
addEventListener('error',function(e){post({t:'console',level:'error',args:[(e.message||'Script error')+(e.lineno?' (line '+e.lineno+')':'')]})});
addEventListener('unhandledrejection',function(e){post({t:'console',level:'error',args:['Unhandled rejection: '+fmt(e.reason)]})});
var blocked=false;try{window.localStorage.getItem('__gg')}catch(e){blocked=true}
if(blocked){
 var timer=null;function save(){clearTimeout(timer);timer=setTimeout(function(){post({t:'storage',key:KEY,data:ls})},250)}
 function mk(data,persist){var api={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null},setItem:function(k,v){data[String(k)]=String(v);if(persist)save()},removeItem:function(k){delete data[String(k)];if(persist)save()},clear:function(){for(var k in data)delete data[k];if(persist)save()},key:function(i){return Object.keys(data)[i]||null}};
  return new Proxy(api,{get:function(t,p){if(p==='length')return Object.keys(data).length;if(p in t)return t[p];return typeof p==='string'&&Object.prototype.hasOwnProperty.call(data,p)?data[p]:undefined},set:function(t,p,v){t.setItem(p,v);return true},deleteProperty:function(t,p){t.removeItem(p);return true},has:function(t,p){return p in t||Object.prototype.hasOwnProperty.call(data,p)},ownKeys:function(){return Object.keys(data)},getOwnPropertyDescriptor:function(t,p){if(Object.prototype.hasOwnProperty.call(data,p))return{value:data[p],enumerable:true,configurable:true,writable:true}}})}
 var ls=INIT.ls||{},LS=mk(ls,!!KEY),SS=mk({},false),jar={};
 try{Object.defineProperty(window,'localStorage',{configurable:true,get:function(){return LS}})}catch(e){}
 try{Object.defineProperty(window,'sessionStorage',{configurable:true,get:function(){return SS}})}catch(e){}
 try{Object.defineProperty(document,'cookie',{configurable:true,get:function(){return Object.keys(jar).map(function(k){return k+'='+jar[k]}).join('; ')},set:function(v){var p=String(v).split(';')[0],i=p.indexOf('=');if(i>0)jar[p.slice(0,i).trim()]=p.slice(i+1).trim()}})}catch(e){}
}
post({t:'ready'});})();<\/script>`;
}

export function buildDocument(html, { channel, storageKey, initial, baseUrl, bridge = true } = {}) {
  let src = String(html || '');
  const head = [];
  if (baseUrl) head.push(`<base href="${baseUrl.replace(/"/g, '&quot;')}">`);
  if (bridge) head.push(shimScript({ channel, storageKey, initial }));
  const inject = head.join('');
  if (!inject) return src;
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
  if (/^\s*<!doctype[^>]*>/i.test(src)) return src.replace(/^\s*<!doctype[^>]*>/i, (m) => m + inject);
  return inject + src;
}

/* ---------- persisted storage for sandboxed files ---------- */
const SKEY = (k) => `gg.emu.${k}`;
function readStore(k) { try { return JSON.parse(localStorage.getItem(SKEY(k)) || '{}'); } catch { return {}; } }
function writeStore(k, data) { try { localStorage.setItem(SKEY(k), JSON.stringify(data)); } catch {} }
export function clearSaveData(k) { try { localStorage.removeItem(SKEY(k)); } catch {} }

/* ---------- mounting ---------- */
/**
 * mountRunner(host, opts)
 *  opts.html        string  — HTML to run (srcdoc)
 *  opts.src         string  — or a URL to frame directly
 *  opts.isolation   'strict' | 'compat'
 *  opts.storageKey  string  — namespace for persisted saves
 *  opts.baseUrl     string  — resolves relative assets for URL-loaded docs
 *  opts.onConsole   (level, args) => void
 *  opts.title       string
 */
export function mountRunner(host, opts = {}) {
  host.innerHTML = '';
  const channel = 'gg' + Math.random().toString(36).slice(2);
  const iframe = document.createElement('iframe');
  iframe.className = 'runner-frame';
  iframe.title = opts.title || 'Game';
  iframe.setAttribute('allow', ALLOW);
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');

  const onMsg = (e) => {
    if (e.source !== iframe.contentWindow || !e.data || e.data.__gg !== channel) return;
    const m = e.data;
    if (m.t === 'console') opts.onConsole?.(m.level, m.args);
    else if (m.t === 'storage' && opts.storageKey && m.key === opts.storageKey) writeStore(opts.storageKey, { ls: m.data });
    else if (m.t === 'ready') opts.onReady?.();
  };
  window.addEventListener('message', onMsg);

  const load = () => {
    if (opts.src) {
      // Cross-origin page: allow-same-origin keeps ITS origin, not ours.
      iframe.setAttribute('sandbox', SANDBOX_STRICT + ' allow-same-origin');
      iframe.removeAttribute('srcdoc');
      iframe.src = opts.src;
    } else {
      iframe.setAttribute('sandbox', opts.isolation === 'compat' ? SANDBOX_STRICT + ' allow-same-origin' : SANDBOX_STRICT);
      const initial = opts.storageKey ? readStore(opts.storageKey) : {};
      iframe.srcdoc = buildDocument(opts.html, { channel, storageKey: opts.storageKey, initial, baseUrl: opts.baseUrl });
    }
  };
  load();
  host.append(iframe);

  return {
    iframe,
    reload() {
      // Re-setting srcdoc/src always re-navigates the frame.
      load();
    },
    fullscreen() {
      const el = host.closest('[data-fs]') || host;
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.().catch(() => {});
    },
    popout() {
      const html = opts.src ? null : buildDocument(opts.html, { baseUrl: opts.baseUrl, bridge: false });
      if (opts.src) return window.open(opts.src, '_blank', 'noopener');
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    destroy() {
      window.removeEventListener('message', onMsg);
      iframe.remove();
    },
  };
}
