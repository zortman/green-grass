/* Green Grass Emulator — page UI.
   Load HTML from a file, pasted code, a URL, or a Google Drive link and
   run it in the sandboxed runner. Files can be saved to a local library
   (IndexedDB, stays on this device). */
import { mountRunner, extractDriveId, normalizeUrl, fetchDriveHtml, fetchUrlHtml, clearSaveData } from './runner.js';
import { $, $$, esc, icon, toast, fmtBytes, timeAgo, store, downloadText, confirmDialog, modal } from './ui.js';

/* ---------- tiny IndexedDB wrapper ---------- */
const DB_NAME = 'gg-emulator';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('files', mode);
    const out = fn(t.objectStore('files'));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
const lib = {
  all: () => tx('readonly', (s) => s.getAll()).then((r) => (r || []).sort((a, b) => b.updated - a.updated)).catch(() => []),
  put: (f) => tx('readwrite', (s) => s.put(f)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
};

const SAMPLE = `<!doctype html>
<html><head><style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#07110b;color:#e8f3ec;font:600 18px system-ui}
  button{font:inherit;padding:12px 22px;border-radius:12px;border:0;background:#3ee07f;color:#04130a;cursor:pointer}
</style></head><body>
  <div style="text-align:center">
    <p id="n">Clicks: 0</p>
    <button onclick="c()">Click me</button>
    <p style="opacity:.6;font-size:13px">Your count is saved even in strict sandbox mode.</p>
  </div>
<script>
  let n = +(localStorage.getItem('clicks') || 0);
  const el = document.getElementById('n');
  el.textContent = 'Clicks: ' + n;
  function c(){ n++; localStorage.setItem('clicks', n); el.textContent = 'Clicks: ' + n; console.log('clicked', n); }
<\/script></body></html>`;

export async function mountEmulator(root, site, params = {}) {
  const settings = site.settings;
  let runner = null;
  let current = null; // { name, html?, src?, baseUrl?, key }
  let tab = store.get('gg.emu.tab', 'file');
  let isolation = store.get('gg.emu.iso', 'strict');

  root.innerHTML = `
  <div class="page-head">
    <div>
      <span class="eyebrow">${icon('cpu')} Built-in</span>
      <h1>Green Grass Emulator</h1>
      <p class="muted">Run any HTML file in a secure sandbox — from your device, pasted code, a link, or Google Drive.</p>
    </div>
  </div>
  <div class="emu">
    <div class="emu-panel card">
      <div class="seg" role="tablist">
        <button data-tab="file">${icon('upload')}File</button>
        <button data-tab="paste">${icon('code')}Paste</button>
        <button data-tab="url">${icon('globe')}URL</button>
        <button data-tab="drive">${icon('cloud')}Drive</button>
      </div>
      <div class="emu-src" data-pane="file">
        <label class="drop">
          <input type="file" accept=".html,.htm,text/html" hidden />
          ${icon('upload', 'lg')}
          <strong>Drop an HTML file here</strong>
          <span class="muted small">or click to browse — nothing is uploaded anywhere</span>
        </label>
      </div>
      <div class="emu-src" data-pane="paste">
        <textarea class="input code" rows="10" spellcheck="false" placeholder="<!doctype html>..."></textarea>
        <div class="row gap"><button class="btn primary" data-run-paste>${icon('play')}<span>Run code</span></button><button class="btn ghost" data-sample>Load sample</button></div>
      </div>
      <div class="emu-src" data-pane="url">
        <label class="field"><span>Page or raw file URL</span><input class="input" data-url placeholder="https://raw.githubusercontent.com/.../index.html"/></label>
        <p class="muted small">GitHub file links are converted to raw automatically. Sites that block embedding will fall back to direct framing.</p>
        <button class="btn primary" data-run-url>${icon('play')}<span>Load URL</span></button>
      </div>
      <div class="emu-src" data-pane="drive">
        <label class="field"><span>Google Drive share link or file ID</span><input class="input" data-drive placeholder="https://drive.google.com/file/d/.../view"/></label>
        <p class="muted small">The file must be shared as <em>Anyone with the link</em>.${settings.emulatorApi || settings.driveApiKey ? '' : ' <strong class="warn-text">No Drive backend configured yet — see SETUP.md.</strong>'}</p>
        <button class="btn primary" data-run-drive>${icon('play')}<span>Load from Drive</span></button>
      </div>

      <div class="emu-opts">
        <div class="opt">
          <div><strong>Isolation</strong><p class="muted small" data-iso-help></p></div>
          <div class="seg seg-sm"><button data-iso="strict">Strict</button><button data-iso="compat">Compatible</button></div>
        </div>
      </div>

      <div class="emu-lib">
        <div class="row between"><span class="eyebrow">${icon('folder')} Library</span><span class="muted small" data-lib-count></span></div>
        <div class="lib-list"></div>
      </div>
    </div>

    <div class="emu-stage-wrap" data-fs>
      <div class="stage-bar">
        <div class="stage-title">${icon('file')}<span data-title>Nothing running</span><span class="muted small" data-size></span></div>
        <div class="stage-actions">
          <button class="icon-btn" data-act="reload" title="Restart" disabled>${icon('refresh')}</button>
          <button class="icon-btn" data-act="save" title="Save to library" disabled>${icon('save')}</button>
          <button class="icon-btn" data-act="download" title="Download .html" disabled>${icon('download')}</button>
          <button class="icon-btn" data-act="popout" title="Open in new tab" disabled>${icon('external')}</button>
          <button class="icon-btn" data-act="stop" title="Stop" disabled>${icon('stop')}</button>
          <button class="icon-btn" data-act="fs" title="Fullscreen" disabled>${icon('maximize')}</button>
        </div>
      </div>
      <div class="stage">
        <div class="stage-empty">
          <div class="stage-empty-icon">${icon('cpu', 'xl')}</div>
          <h3>Ready when you are</h3>
          <p class="muted">Pick a source on the left. Files run in a sandbox that can't read your data on this site.</p>
        </div>
      </div>
      <div class="console" data-console>
        <div class="console-head"><span>${icon('terminal')} Console <span class="badge" data-errs hidden></span></span><div class="row gap-sm"><button class="icon-btn sm" data-clear title="Clear">${icon('trash')}</button><button class="icon-btn sm" data-collapse title="Toggle">${icon('chevronDown')}</button></div></div>
        <div class="console-log"></div>
      </div>
    </div>
  </div>`;

  const stage = $('.stage', root);
  const consoleEl = $('[data-console]', root);
  const consoleLog = $('.console-log', root);
  let errCount = 0;
  if (store.get('gg.emu.console', false)) consoleEl.classList.add('open');

  /* ---------- tabs & options ---------- */
  function setTab(t) {
    tab = t; store.set('gg.emu.tab', t);
    $$('[data-tab]', root).forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $$('[data-pane]', root).forEach((p) => (p.hidden = p.dataset.pane !== t));
  }
  $$('[data-tab]', root).forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  setTab(tab);

  function setIso(v) {
    isolation = v; store.set('gg.emu.iso', v);
    $$('[data-iso]', root).forEach((b) => b.classList.toggle('active', b.dataset.iso === v));
    $('[data-iso-help]', root).textContent = v === 'strict'
      ? 'Recommended. The file can’t access this site. Saves still work.'
      : 'For trusted files that need IndexedDB. The file can access this site’s storage.';
  }
  $$('[data-iso]', root).forEach((b) => (b.onclick = () => { setIso(b.dataset.iso); if (current) run(current); }));
  setIso(isolation);

  /* ---------- console ---------- */
  function log(level, args) {
    const line = document.createElement('div');
    line.className = `log log-${level}`;
    line.textContent = args.join(' ');
    consoleLog.append(line);
    while (consoleLog.children.length > 300) consoleLog.firstChild.remove();
    consoleLog.scrollTop = consoleLog.scrollHeight;
    if (level === 'error') { errCount++; const b = $('[data-errs]', root); b.hidden = false; b.textContent = `${errCount} error${errCount > 1 ? 's' : ''}`; }
  }
  $('[data-clear]', root).onclick = () => { consoleLog.innerHTML = ''; errCount = 0; $('[data-errs]', root).hidden = true; };
  $('[data-collapse]', root).onclick = () => { consoleEl.classList.toggle('open'); store.set('gg.emu.console', consoleEl.classList.contains('open')); };
  $('.console-head', root).ondblclick = () => $('[data-collapse]', root).click();

  /* ---------- running ---------- */
  function setRunning(on) {
    $$('[data-act]', root).forEach((b) => (b.disabled = !on));
    if (on && current?.src) { $('[data-act="save"]', root).disabled = true; $('[data-act="download"]', root).disabled = true; }
  }

  function run(item) {
    current = item;
    runner?.destroy();
    $('[data-clear]', root).click();
    $('[data-title]', root).textContent = item.name;
    $('[data-size]', root).textContent = item.html ? fmtBytes(new Blob([item.html]).size) : item.src ? 'direct frame' : '';
    runner = mountRunner(stage, {
      html: item.html, src: item.src, baseUrl: item.baseUrl, isolation,
      storageKey: item.key, title: item.name, onConsole: log,
    });
    setRunning(true);
    log('info', [`Running ${item.name} (${item.src ? 'direct' : isolation} mode)`]);
  }

  function stop() {
    runner?.destroy(); runner = null; current = null;
    stage.innerHTML = `<div class="stage-empty"><div class="stage-empty-icon">${icon('cpu', 'xl')}</div><h3>Stopped</h3><p class="muted">Pick something to run.</p></div>`;
    $('[data-title]', root).textContent = 'Nothing running';
    $('[data-size]', root).textContent = '';
    setRunning(false);
  }

  function keyFor(name, html) {
    let h = 0; const s = name + (html || '').length;
    for (const c of s) h = (h * 33 + c.charCodeAt(0)) >>> 0;
    return 'file-' + h.toString(36);
  }

  function loading(msg) {
    stage.innerHTML = `<div class="stage-empty"><div class="stage-empty-icon">${icon('refresh', 'xl spin')}</div><h3>${esc(msg)}</h3></div>`;
  }
  function failed(title, msg) {
    stage.innerHTML = `<div class="stage-empty"><div class="stage-empty-icon danger">${icon('alert', 'xl')}</div><h3>${esc(title)}</h3><p class="muted">${esc(msg)}</p></div>`;
  }

  // File
  const input = $('input[type=file]', root);
  const drop = $('.drop', root);
  const readFile = async (file) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast('That file is over 25 MB.', 'error');
    const html = await file.text();
    run({ name: file.name, html, key: keyFor(file.name, html) });
  };
  input.onchange = () => readFile(input.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));
  // Drop anywhere on the stage too
  const wrap = $('.emu-stage-wrap', root);
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('drop', (e) => { e.preventDefault(); readFile(e.dataTransfer.files[0]); });

  // Paste
  const ta = $('[data-pane="paste"] textarea', root);
  ta.value = store.get('gg.emu.paste', '');
  ta.addEventListener('input', () => store.set('gg.emu.paste', ta.value.slice(0, 200000)));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const p = ta.selectionStart; ta.setRangeText('  ', p, ta.selectionEnd, 'end'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('[data-run-paste]', root).click();
  });
  $('[data-sample]', root).onclick = () => { ta.value = SAMPLE; store.set('gg.emu.paste', SAMPLE); };
  $('[data-run-paste]', root).onclick = () => {
    if (!ta.value.trim()) return toast('Paste some HTML first.', 'warning');
    run({ name: 'Pasted code', html: ta.value, key: 'pasted' });
  };

  // URL
  $('[data-run-url]', root).onclick = async () => {
    const url = normalizeUrl($('[data-url]', root).value);
    if (!url) return toast('Enter a URL.', 'warning');
    loading('Fetching page…');
    try {
      const html = await fetchUrlHtml(url);
      const base = url.replace(/[^/]*([?#].*)?$/, '');
      run({ name: url.split('/').filter(Boolean).pop() || url, html, baseUrl: base, key: keyFor(url, '') });
    } catch {
      // CORS blocked — frame it directly instead.
      run({ name: url, src: url, key: null });
      log('warn', ['This site doesn’t allow its code to be fetched, so it’s framed directly. If it stays blank, the site blocks embedding — use "Open in new tab".']);
    }
  };

  // Drive
  async function runDrive(raw, name) {
    const id = extractDriveId(raw);
    if (!id) return toast('That doesn’t look like a Drive link or file ID.', 'warning');
    loading('Loading from Google Drive…');
    try {
      const r = await fetchDriveHtml(id, settings);
      run({ name: name || r.name, html: r.html, key: 'drive-' + id });
    } catch (e) {
      failed('Couldn’t load that file', e.message);
    }
  }
  $('[data-run-drive]', root).onclick = () => runDrive($('[data-drive]', root).value);

  /* ---------- toolbar ---------- */
  $$('[data-act]', root).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act;
    if (!runner) return;
    if (a === 'reload') runner.reload();
    if (a === 'fs') runner.fullscreen();
    if (a === 'popout') runner.popout();
    if (a === 'stop') stop();
    if (a === 'download' && current?.html) downloadText(/\.html?$/i.test(current.name) ? current.name : current.name.replace(/[^\w.-]+/g, '_') + '.html', current.html);
    if (a === 'save' && current?.html) {
      const id = current.libId || crypto.randomUUID?.() || String(Date.now());
      await lib.put({ id, name: current.name, html: current.html, key: current.key, size: current.html.length, updated: Date.now() });
      current.libId = id;
      toast('Saved to your library.', 'success');
      renderLib();
    }
  }));

  /* ---------- library ---------- */
  async function renderLib() {
    const items = await lib.all();
    $('[data-lib-count]', root).textContent = items.length ? `${items.length} saved` : '';
    const el = $('.lib-list', root);
    if (!items.length) { el.innerHTML = `<p class="muted small lib-empty">Saved files appear here. They stay on this device only.</p>`; return; }
    el.innerHTML = items.map((f) => `<div class="lib-item" data-id="${esc(f.id)}">
      <button class="lib-main" data-open>${icon('file')}<span><strong>${esc(f.name)}</strong><small class="muted">${fmtBytes(f.size)} · ${timeAgo(f.updated)}</small></span></button>
      <button class="icon-btn sm" data-ren title="Rename">${icon('edit')}</button>
      <button class="icon-btn sm" data-rm title="Delete">${icon('trash')}</button>
    </div>`).join('');
    $$('.lib-item', el).forEach((row) => {
      const f = items.find((x) => x.id === row.dataset.id);
      $('[data-open]', row).onclick = () => run({ name: f.name, html: f.html, key: f.key, libId: f.id });
      $('[data-rm]', row).onclick = async () => {
        if (!(await confirmDialog(`Remove "${f.name}" from your library? Its save data will be cleared too.`, { okLabel: 'Remove', danger: true }))) return;
        await lib.del(f.id); if (f.key) clearSaveData(f.key); renderLib();
      };
      $('[data-ren]', row).onclick = () => {
        modal({
          title: 'Rename file',
          body: `<label class="field"><span>Name</span><input class="input" value="${esc(f.name)}"/></label>`,
          actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Save', kind: 'primary', onClick: async (m) => { f.name = $('input', m).value.trim() || f.name; f.updated = Date.now(); await lib.put(f); renderLib(); } }],
        });
      };
    });
  }
  renderLib();

  // Deep links: #/emulator?drive=<id>
  if (params.drive) { setTab('drive'); $('[data-drive]', root).value = params.drive; runDrive(params.drive); }

  return () => runner?.destroy();
}
