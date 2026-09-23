/* Green Grass — Admin dashboard.
   Access: owner (CONFIG.OWNER_EMAIL) or a live admin code; enforced by firestore.rules. */
import { CONFIG, isFirebaseConfigured } from './config.js';
import { getFB, signInGoogle, signInGuest, signOut, onUser } from './fb.js';
import { adminStatus, redeemCode, generateCode } from './access.js';
import { loadSeed, mergeSettings } from './data.js';
import {
  $, $$, esc, icon, md, toast, modal, confirmDialog, slugify, fmtDate, timeAgo, fmtBytes,
  installIcons, applyTheme, setTheme, gameLogo, LOGO_SVG, downloadText, debounce, store,
} from './ui.js';
import { mountRunner, extractDriveId, fetchDriveHtml, normalizeUrl } from './runner.js';

applyTheme();
installIcons();

const CHUNK = 300000; // chars per Firestore chunk doc (< 1 MiB even for 3-byte chars)
let fb, db, fs, me, access = {};
const S = { games: [], links: [], patchnotes: [], reports: [], bans: [], codes: [], settings: {} };
let section = store.get('gg.admin.section', 'overview');

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: 'chart' },
  { id: 'games', label: 'Games', icon: 'gamepad' },
  { id: 'links', label: 'Links', icon: 'link' },
  { id: 'notes', label: 'Patch Notes', icon: 'notes' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'reports', label: 'Reports', icon: 'inbox' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
  { id: 'backup', label: 'Backup', icon: 'database' },
  { id: 'codes', label: 'Admin codes', icon: 'shield', owner: true },
];
const LINK_CATS = { static: 'Unblocked static site', useful: 'Useful site', tools: 'Tools & source code' };
const NOTE_TAGS = ['new', 'fix', 'improvement', 'notice'];

const root = document.getElementById('admin');

/* =================================================================
   GATES
   ================================================================= */
function gate(inner) {
  root.innerHTML = `<div class="gate"><div class="gate-card card">${LOGO_SVG}${inner}</div></div>`;
}

async function boot() {
  try { sessionStorage.removeItem('gg.adminRetry'); } catch {}
  if (!isFirebaseConfigured()) {
    gate(`<h1>Admin setup</h1>
      <p class="muted">The dashboard needs Firebase. It's free and takes about 10 minutes.</p>
      <ol class="setup-steps">
        <li>Create a project at <a href="https://console.firebase.google.com" target="_blank" rel="noopener">console.firebase.google.com</a>.</li>
        <li><strong>Build → Authentication</strong> → enable <em>Google</em>. Add your GitHub Pages domain under <em>Settings → Authorized domains</em>.</li>
        <li><strong>Build → Firestore Database</strong> → create a database (production mode).</li>
        <li>Open <strong>Firestore → Rules</strong>, paste <code>firestore.rules</code> from this repo, put your owner email in it, and Publish.</li>
        <li><strong>Project settings → Your apps → Web</strong> → copy the config into <code>assets/js/config.js</code>, and set <code>OWNER_EMAIL</code>.</li>
        <li>Commit, push, reload this page.</li>
      </ol>
      <p class="muted small">Full walkthrough: <code>SETUP.md</code></p>`);
    return;
  }
  gate(`<div class="boot">${icon('refresh', 'xl spin')}</div>`);
  fb = await getFB();
  if (!fb) { gate(`<h1>Couldn't load Firebase</h1><p class="muted">Check your connection, or whether gstatic.com is blocked on this network.</p>`); return; }
  ({ db, fs } = fb);
  try { await fb.au.getRedirectResult(fb.auth); } catch {}
  onUser(async (u) => {
    me = u;
    if (!u) {
      gate(`<h1>Admin sign in</h1><p class="muted">Sign in, then enter your admin code if you have one.</p>
        <button class="btn primary lg" data-in>${icon('user')}<span>Sign in with Google</span></button>
        <button class="btn ghost" data-guest>Continue without Google</button>
        <p class="muted small">Use a personal Google account. School accounts may be blocked by your district.</p>
        <a class="muted small" href="./">Back to site</a>`);
      $('[data-in]').onclick = () => signInGoogle().catch((e) => toast(e.message, 'error'));
      $('[data-guest]').onclick = () => signInGuest().catch((e) => toast(
        /admin-restricted|operation-not-allowed/.test(e.code || '') ? 'Guest sign-in is off. The owner needs to enable Anonymous sign-in in Firebase.' : e.message, 'error', 6000));
      return;
    }
    gate(`<div class="boot">${icon('refresh', 'xl spin')}</div>`);
    access = await adminStatus(fb, u);
    if (!access.admin) return codeGate(u);
    await loadAll();
    shell();
  });
}

function codeGate(u) {
  const who = u.isAnonymous ? 'Guest session' : (u.email || 'Your account');
  gate(`<h1>Enter admin code</h1>
    <p class="muted">${access.stale ? 'Your previous admin code was revoked. ' : ''}Signed in as <strong>${esc(who)}</strong>. Ask the owner for an admin code.</p>
    <form class="stack code-form" data-form>
      <input class="input code-input" data-code placeholder="GG-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" maxlength="24"/>
      <button class="btn primary lg" type="submit">${icon('shieldCheck')}<span>Unlock dashboard</span></button>
    </form>
    ${u.isAnonymous ? '<p class="muted small">Guest admin access only lasts on this browser. If you clear your browser data you’ll need a new code.</p>' : ''}
    <div class="row gap"><button class="btn ghost" data-out>${icon('logout')}<span>Sign out</span></button><a class="btn ghost" href="./">Back to site</a></div>`);
  $('[data-out]').onclick = () => signOut();
  const input = $('[data-code]');
  input.focus();
  $('[data-form]').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('[data-form] button');
    btn.disabled = true;
    try {
      await redeemCode(fb, u, input.value);
      toast('Admin access granted', 'success');
      access = await adminStatus(fb, u);
      await loadAll();
      shell();
    } catch (err) {
      toast(err.message, 'error', 5000);
      btn.disabled = false;
    }
  };
}

/* =================================================================
   DATA
   ================================================================= */
const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999);

async function loadAll() {
  const [g, l, n, r, b, s] = await Promise.all([
    fs.getDocs(fs.collection(db, 'games')),
    fs.getDocs(fs.collection(db, 'links')),
    fs.getDocs(fs.collection(db, 'patchnotes')),
    fs.getDocs(fs.query(fs.collection(db, 'reports'), fs.orderBy('createdAt', 'desc'), fs.limit(200))).catch(() => ({ docs: [] })),
    fs.getDocs(fs.collection(db, 'bans')).catch(() => ({ docs: [] })),
    fs.getDoc(fs.doc(db, 'settings', 'site')),
  ]);
  S.games = list(g).sort(byOrder);
  S.links = list(l).sort(byOrder);
  S.patchnotes = list(n).sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  S.reports = list(r);
  S.bans = list(b);
  S.codes = access.owner
    ? list(await fs.getDocs(fs.collection(db, 'adminCodes')).catch(() => ({ docs: [] })))
      .sort((x, y) => (y.createdAt?.seconds || 0) - (x.createdAt?.seconds || 0))
    : [];
  S.settingsExists = s.exists();
  S.settings = mergeSettings(s.exists() ? s.data() : (await loadSeed()).settings);
}

async function saveSettings(patch) {
  await fs.setDoc(fs.doc(db, 'settings', 'site'), { ...patch, updatedAt: fs.serverTimestamp() }, { merge: true });
  Object.assign(S.settings, patch);
  S.settingsExists = true;
}

/* =================================================================
   SHELL
   ================================================================= */
function shell() {
  const openReports = S.reports.filter((r) => r.status !== 'resolved').length;
  root.innerHTML = `
  <div class="app admin-app">
    <aside class="sidebar">
      <a class="brand" href="./">${LOGO_SVG}<span>${esc(CONFIG.siteName)}<small class="admin-tag">Admin</small></span></a>
      <nav class="nav"><div class="nav-group">
        ${SECTIONS.filter((s) => !s.owner || access.owner).map((s) => `<a class="nav-item" href="#" data-s="${s.id}">${icon(s.icon)}<span>${s.label}</span>${s.id === 'reports' && openReports ? `<span class="nav-count">${openReports}</span>` : ''}</a>`).join('')}
      </div>
      <div class="nav-group"><span class="nav-label">Site</span>
        <a class="nav-item" href="./" target="_blank">${icon('external')}<span>View site</span></a>
      </div></nav>
      <div class="sidebar-foot">
        <div class="me-card">${me.photoURL ? `<img src="${esc(me.photoURL)}" alt="" referrerpolicy="no-referrer"/>` : ''}<div class="me-meta"><strong>${esc(me.displayName || (me.isAnonymous ? 'Guest admin' : 'Admin'))}</strong><span class="muted small">${access.owner ? 'Owner' : 'Admin'}${me.email ? ' · ' + esc(me.email) : ''}</span></div></div>
        <div class="row gap-sm">
          <button class="icon-btn" data-theme-toggle title="Toggle theme">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
          <button class="icon-btn" data-refresh title="Reload data">${icon('refresh')}</button>
          <button class="icon-btn" data-out title="Sign out">${icon('logout')}</button>
        </div>
      </div>
    </aside>
    <div class="scrim" data-scrim></div>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" data-menu>${icon('menu')}</button>
        <h2 class="topbar-title"></h2>
        <div class="topbar-right" data-actions></div>
      </header>
      <main class="view" id="view"></main>
    </div>
  </div>`;
  $$('[data-s]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.dataset.s); }));
  $('[data-out]').onclick = () => signOut();
  $('[data-refresh]').onclick = async () => { await loadAll(); shell(); toast('Data reloaded', 'success', 1500); };
  $('[data-theme-toggle]').onclick = () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); shell(); };
  $('[data-menu]').onclick = () => document.body.classList.toggle('nav-open');
  $('[data-scrim]').onclick = () => document.body.classList.remove('nav-open');
  go(section);
}

function go(s) {
  if (!SECTIONS.some((x) => x.id === s && (!x.owner || access.owner))) s = 'overview';
  section = s; store.set('gg.admin.section', s);
  document.body.classList.remove('nav-open');
  $$('[data-s]').forEach((a) => a.classList.toggle('active', a.dataset.s === s));
  const meta = SECTIONS.find((x) => x.id === s);
  $('.topbar-title').textContent = meta.label;
  document.title = `${meta.label} · Admin · ${CONFIG.siteName}`;
  const view = $('#view');
  view.innerHTML = '';
  $('[data-actions]').innerHTML = '';
  view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
  ({ overview, games, links, notes, chat, reports, settings, backup, codes })[s](view);
}
const actions = (html) => { $('[data-actions]').innerHTML = html; return $('[data-actions]'); };

/* =================================================================
   OVERVIEW
   ================================================================= */
function overview(view) {
  const plays = S.games.reduce((n, g) => n + (g.plays || 0), 0);
  const open = S.reports.filter((r) => r.status !== 'resolved');
  const top = [...S.games].sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, 6);
  const maxPlays = Math.max(1, ...top.map((g) => g.plays || 0));
  const empty = !S.games.length && !S.links.length && !S.patchnotes.length;
  view.innerHTML = `
  ${empty ? `<div class="callout callout-tip">${icon('zap')}<div><strong>Fresh database</strong><p>Import the starter data (your 7 games, links and patch notes from the doc) to get going.</p><button class="btn primary sm" data-import-seed style="margin-top:10px">${icon('download')}<span>Import starter data</span></button></div></div>` : ''}
  <div class="stat-grid">
    ${[['gamepad', 'Games', S.games.length, `${S.games.filter((g) => g.hidden).length} hidden`], ['play', 'Total plays', plays.toLocaleString(), 'All time'], ['link', 'Links', S.links.length, `${Object.keys(LINK_CATS).length} categories`], ['notes', 'Patch notes', S.patchnotes.length, S.patchnotes[0]?.title || '—'], ['inbox', 'Open reports', open.length, `${S.reports.length} total`], ['ban', 'Chat bans', S.bans.length, 'Active']]
      .map(([i, l, v, sub]) => `<div class="card stat"><div class="stat-icon">${icon(i)}</div><div><span class="muted small">${l}</span><strong>${v}</strong><small class="muted">${esc(sub)}</small></div></div>`).join('')}
  </div>
  <div class="split">
    <div class="card">
      <div class="section-head"><h2>Most played</h2><a class="link-more" href="#" data-go="games">Manage ${icon('arrowRight')}</a></div>
      ${top.length ? `<div class="bars">${top.map((g) => `<div class="bar-row">${gameLogo(g, 'mini-logo')}<span class="bar-label">${esc(g.title)}</span><div class="bar"><span style="width:${((g.plays || 0) / maxPlays) * 100}%"></span></div><span class="bar-val">${(g.plays || 0).toLocaleString()}</span></div>`).join('')}</div>` : '<p class="muted">No games yet.</p>'}
    </div>
    <div class="card">
      <div class="section-head"><h2>Recent reports</h2><a class="link-more" href="#" data-go="reports">View all ${icon('arrowRight')}</a></div>
      ${open.length ? `<div class="mini-list">${open.slice(0, 5).map((r) => `<div class="mini-item"><span class="badge badge-warn">${esc(r.type)}</span><span class="mini-text">${esc(r.message)}</span><span class="muted small">${r.createdAt ? timeAgo(r.createdAt) : ''}</span></div>`).join('')}</div>` : `<p class="muted">${icon('check')} Inbox zero.</p>`}
    </div>
  </div>
  <div class="card">
    <div class="section-head"><h2>System health</h2><button class="btn sm" data-health>${icon('activity')}<span>Run checks</span></button></div>
    <div class="health" data-health-list></div>
  </div>`;
  $$('[data-go]', view).forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.dataset.go); }));
  $('[data-import-seed]', view)?.addEventListener('click', importSeed);
  const hl = $('[data-health-list]', view);
  const row = (ok, label, detail) => `<div class="health-row"><span class="status-dot ${ok === null ? 'checking' : ok ? 's-ok' : 's-blocked'}"></span><strong>${label}</strong><span class="muted small">${detail}</span></div>`;
  const runHealth = async () => {
    const rows = [
      [true, 'Firebase connected', `Project ${esc(CONFIG.firebase.projectId)}`],
      [true, access.owner ? 'Signed in as owner' : 'Signed in with admin code', esc(me.email || 'Guest session')],
    ];
    hl.innerHTML = rows.map((r) => row(...r)).join('') + row(null, 'Security rules', 'Testing admin write…') + row(null, 'Emulator backend', 'Testing…');
    let rulesOk = false;
    try { await fs.setDoc(fs.doc(db, 'settings', 'health'), { at: fs.serverTimestamp(), by: me.email }); rulesOk = true; } catch {}
    rows.push([rulesOk, 'Security rules', rulesOk ? 'Admin writes allowed' : 'Write denied — are your emails in firestore.rules and the rules published?']);
    let emuOk = false, emuMsg = 'Not configured — Drive games use the legacy fallback';
    if (S.settings.emulatorApi) {
      try { const j = await (await fetch(S.settings.emulatorApi + '?id=health')).json(); emuOk = j && 'ok' in j; emuMsg = emuOk ? 'Backend responding' : 'Unexpected response'; }
      catch { emuMsg = 'Unreachable — check the deployment access is "Anyone"'; }
    } else if (S.settings.driveApiKey) { emuOk = true; emuMsg = 'Using Drive API key'; }
    rows.push([emuOk, 'Emulator backend', emuMsg]);
    hl.innerHTML = rows.map((r) => row(...r)).join('');
  };
  $('[data-health]', view).onclick = runHealth;
  runHealth();
}

async function importSeed() {
  if (!(await confirmDialog('Import the starter games, links, patch notes and settings from data/seed.json? Existing items with the same IDs will be overwritten.', { okLabel: 'Import' }))) return;
  const seed = await loadSeed();
  const batch = fs.writeBatch(db);
  const noId = ({ id, ...rest }) => rest;
  for (const g of seed.games) batch.set(fs.doc(db, 'games', g.id), { ...noId(g), createdAt: fs.serverTimestamp() });
  for (const l of seed.links) batch.set(fs.doc(db, 'links', l.id), noId(l));
  for (const n of seed.patchnotes) batch.set(fs.doc(db, 'patchnotes', n.id), noId(n));
  batch.set(fs.doc(db, 'settings', 'site'), { ...S.settings, ...seed.settings, updatedAt: fs.serverTimestamp() }, { merge: true });
  try {
    await batch.commit();
    toast('Starter data imported.', 'success');
    await loadAll(); shell();
  } catch (e) { toast(e.message, 'error', 6000); }
}

/* =================================================================
   GAMES
   ================================================================= */
function games(view) {
  actions(`<button class="btn primary" data-new>${icon('plus')}<span>Add game</span></button>`).querySelector('[data-new]').onclick = () => gameEditor();
  let q = '';
  view.innerHTML = `
  <div class="toolbar"><label class="search-field">${icon('search')}<input class="input" placeholder="Filter games" data-q/></label></div>
  <div class="table-wrap card flush"><table class="table">
    <thead><tr><th></th><th>Game</th><th>Source</th><th>Plays</th><th>Status</th><th></th></tr></thead>
    <tbody></tbody></table></div>`;
  const tbody = $('tbody', view);
  const render = () => {
    const rows = S.games.filter((g) => !q || `${g.title} ${g.category}`.toLowerCase().includes(q));
    tbody.innerHTML = rows.length ? rows.map((g, i) => `<tr data-id="${esc(g.id)}">
      <td class="order-cell"><button class="icon-btn sm" data-up ${i === 0 || q ? 'disabled' : ''}>${icon('chevronDown', 'flip')}</button><button class="icon-btn sm" data-down ${i === rows.length - 1 || q ? 'disabled' : ''}>${icon('chevronDown')}</button></td>
      <td><div class="cell-game">${gameLogo(g, 'mini-logo')}<div><strong>${esc(g.title)}</strong><span class="muted small">${esc(g.category || '—')}</span></div></div></td>
      <td><span class="badge">${{ html: 'Uploaded HTML', file: 'Site file', drive: 'Google Drive', url: 'Web URL' }[g.source] || g.source}</span>${g.fileSize ? `<span class="muted small"> ${fmtBytes(g.fileSize)}</span>` : ''}</td>
      <td>${(g.plays || 0).toLocaleString()}</td>
      <td><div class="row gap-sm">${g.hidden ? '<span class="badge badge-muted">Hidden</span>' : '<span class="badge badge-accent">Live</span>'}${g.featured ? '<span class="badge badge-warn">Featured</span>' : ''}</div></td>
      <td class="row-actions"><button class="icon-btn sm" data-test title="Test">${icon('play')}</button><button class="icon-btn sm" data-edit title="Edit">${icon('edit')}</button><button class="icon-btn sm" data-del title="Delete">${icon('trash')}</button></td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state">${icon('gamepad', 'xl')}<p class="muted">No games yet. Click <strong>Add game</strong>.</p></div></td></tr>`;
    $$('tr[data-id]', tbody).forEach((tr) => {
      const g = S.games.find((x) => x.id === tr.dataset.id);
      $('[data-edit]', tr).onclick = () => gameEditor(g);
      $('[data-test]', tr).onclick = () => testGame(g);
      $('[data-del]', tr).onclick = async () => {
        if (!(await confirmDialog(`Delete "${g.title}"? This also deletes any uploaded file.`, { okLabel: 'Delete', danger: true }))) return;
        try { await deleteChunks(g.id); await fs.deleteDoc(fs.doc(db, 'games', g.id)); S.games = S.games.filter((x) => x.id !== g.id); render(); toast('Game deleted', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      };
      $('[data-up]', tr).onclick = () => move(g, -1);
      $('[data-down]', tr).onclick = () => move(g, 1);
    });
  };
  const move = async (g, dir) => {
    const i = S.games.indexOf(g), j = i + dir;
    if (j < 0 || j >= S.games.length) return;
    [S.games[i], S.games[j]] = [S.games[j], S.games[i]];
    S.games.forEach((x, k) => (x.order = k + 1));
    render();
    const batch = fs.writeBatch(db);
    S.games.forEach((x) => batch.update(fs.doc(db, 'games', x.id), { order: x.order }));
    batch.commit().catch((e) => toast(e.message, 'error'));
  };
  $('[data-q]', view).oninput = debounce((e) => { q = e.target.value.toLowerCase().trim(); render(); }, 100);
  render();
}

async function deleteChunks(id) {
  const snap = await fs.getDocs(fs.collection(db, 'gameFiles', id, 'chunks'));
  if (snap.empty) return;
  const batch = fs.writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

async function writeChunks(id, html) {
  await deleteChunks(id);
  const parts = [];
  for (let i = 0; i < html.length; i += CHUNK) parts.push(html.slice(i, i + CHUNK));
  // Firestore requests max out at ~10 MiB — write a few chunks per batch.
  for (let i = 0; i < parts.length; i += 8) {
    const batch = fs.writeBatch(db);
    parts.slice(i, i + 8).forEach((d, k) => batch.set(fs.doc(db, 'gameFiles', id, 'chunks', String(i + k).padStart(4, '0')), { i: i + k, d }));
    await batch.commit();
  }
  return parts.length;
}

/* Resize an image file to a square WebP data URL (cover-crop). */
function resizeLogo(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      let url = c.toDataURL('image/webp', 0.88);
      if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/png');
      URL.revokeObjectURL(img.src);
      resolve(url);
    };
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}

function gameEditor(g = null) {
  const isNew = !g;
  const d = g ? { ...g } : { title: '', category: '', description: '', controls: '', source: 'html', driveId: '', url: '', logo: '', featured: false, hidden: false, tags: [] };
  let pendingHtml = null; // new HTML upload text
  const cats = [...new Set(S.games.map((x) => x.category).filter(Boolean))];

  const m = modal({
    title: isNew ? 'Add game' : `Edit ${g.title}`,
    wide: true,
    body: `<div class="editor-grid">
      <div class="stack">
        <label class="field"><span>Title</span><input class="input" data-f="title" maxlength="80" value="${esc(d.title)}" placeholder="e.g. Meteor Mayhem"/></label>
        <div class="two">
          <label class="field"><span>Category</span><input class="input" data-f="category" list="cat-list" maxlength="30" value="${esc(d.category)}" placeholder="Arcade"/><datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
          <label class="field"><span>Tags <em class="muted">(comma separated)</em></span><input class="input" data-f="tags" value="${esc((d.tags || []).join(', '))}" placeholder="2-player, retro"/></label>
        </div>
        <label class="field"><span>Description</span><textarea class="input" rows="2" data-f="description" maxlength="300">${esc(d.description)}</textarea></label>
        <label class="field"><span>Controls <em class="muted">(optional)</em></span><input class="input" data-f="controls" maxlength="120" value="${esc(d.controls || '')}" placeholder="WASD to move, click to shoot"/></label>

        <div class="field"><span>Game source</span>
          <div class="seg" data-src>
            <button data-v="html">${icon('upload')}Upload HTML</button>
            <button data-v="file">${icon('folder')}Site file</button>
            <button data-v="drive">${icon('cloud')}Drive</button>
            <button data-v="url">${icon('globe')}Web URL</button>
          </div>
        </div>
        <div data-pane="file">
          <label class="field"><span>File path in the repo</span><input class="input" data-f="file" value="${esc(d.file || '')}" placeholder="games/my-game.html"/></label>
          <p class="muted small">Put the .html file in the repo's <code>games/</code> folder and push. Loads straight from the site — no database or Drive needed.</p>
        </div>
        <div data-pane="html">
          <label class="drop small-drop"><input type="file" accept=".html,.htm,text/html" hidden data-html/>${icon('upload')}<strong data-html-label>${g?.source === 'html' && g.fileSize ? `Current file: ${fmtBytes(g.fileSize)} — drop a new one to replace` : 'Drop the game’s .html file'}</strong><span class="muted small">Single-file HTML games work best. Stored in the database and served through the emulator.</span></label>
        </div>
        <div data-pane="drive">
          <label class="field"><span>Drive share link or file ID</span><input class="input" data-f="driveId" value="${esc(d.driveId || '')}" placeholder="https://drive.google.com/file/d/.../view"/></label>
          <p class="muted small">Share the file as <em>Anyone with the link</em>. Loaded through your emulator backend.</p>
        </div>
        <div data-pane="url">
          <label class="field"><span>Game URL</span><input class="input" data-f="url" value="${esc(d.url || '')}" placeholder="https://..."/></label>
          <p class="muted small">Framed directly. The site must allow embedding.</p>
        </div>
        <div class="toggles">
          <label class="switch"><input type="checkbox" data-f="featured" ${d.featured ? 'checked' : ''}/><span></span>Featured on home page</label>
          <label class="switch"><input type="checkbox" data-f="hidden" ${d.hidden ? 'checked' : ''}/><span></span>Hidden from site</label>
        </div>
      </div>
      <div class="stack">
        <div class="field"><span>Logo</span>
          <label class="logo-drop" data-logo-drop>
            <input type="file" accept="image/*" hidden data-logo-file/>
            <div class="logo-preview" data-logo-preview></div>
            <span class="muted small">Click or drop an image<br/>Cropped to a square, 256×256</span>
          </label>
          <input class="input" data-f="logo" placeholder="…or an image URL / assets/logos/name.png" value="${esc(d.logo?.startsWith('data:') ? '' : d.logo || '')}"/>
          ${d.logo ? `<button class="btn ghost sm" data-logo-clear>${icon('x')}<span>Remove logo</span></button>` : ''}
        </div>
        <button class="btn" data-preview>${icon('play')}<span>Test play</span></button>
      </div>
    </div>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: isNew ? 'Add game' : 'Save changes', kind: 'primary', icon: 'save', onClick: save },
    ],
  });
  const el = m.el;
  const f = (k) => $(`[data-f="${k}"]`, el);

  // source switching
  const setSrc = (v) => {
    d.source = v;
    $$('[data-src] button', el).forEach((b) => b.classList.toggle('active', b.dataset.v === v));
    $$('[data-pane]', el).forEach((p) => (p.hidden = p.dataset.pane !== v));
  };
  $$('[data-src] button', el).forEach((b) => (b.onclick = (e) => { e.preventDefault(); setSrc(b.dataset.v); }));
  setSrc(d.source);

  // html upload
  const htmlInput = $('[data-html]', el);
  const takeHtml = async (file) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('Keep uploaded games under 8 MB.', 'error');
    pendingHtml = await file.text();
    $('[data-html-label]', el).textContent = `${file.name} · ${fmtBytes(file.size)} — ready`;
    if (!f('title').value) f('title').value = file.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };
  htmlInput.onchange = () => takeHtml(htmlInput.files[0]);
  const hd = htmlInput.closest('.drop');
  hd.addEventListener('dragover', (e) => { e.preventDefault(); hd.classList.add('over'); });
  hd.addEventListener('dragleave', () => hd.classList.remove('over'));
  hd.addEventListener('drop', (e) => { e.preventDefault(); hd.classList.remove('over'); takeHtml(e.dataTransfer.files[0]); });

  // logo
  const renderLogo = () => { $('[data-logo-preview]', el).innerHTML = gameLogo({ title: f('title').value || 'Game', logo: d.logo }, 'logo-big'); };
  renderLogo();
  f('title').addEventListener('input', debounce(renderLogo, 200));
  const logoFile = $('[data-logo-file]', el);
  const takeLogo = async (file) => {
    if (!file) return;
    try { d.logo = await resizeLogo(file); f('logo').value = ''; renderLogo(); } catch (e) { toast(e.message, 'error'); }
  };
  logoFile.onchange = () => takeLogo(logoFile.files[0]);
  const ld = $('[data-logo-drop]', el);
  ld.addEventListener('dragover', (e) => { e.preventDefault(); ld.classList.add('over'); });
  ld.addEventListener('dragleave', () => ld.classList.remove('over'));
  ld.addEventListener('drop', (e) => { e.preventDefault(); ld.classList.remove('over'); takeLogo(e.dataTransfer.files[0]); });
  f('logo').addEventListener('change', () => { if (f('logo').value.trim()) { d.logo = f('logo').value.trim(); renderLogo(); } });
  $('[data-logo-clear]', el)?.addEventListener('click', (e) => { e.preventDefault(); d.logo = ''; f('logo').value = ''; renderLogo(); });

  $('[data-preview]', el).onclick = async () => {
    const draft = collect();
    if (draft.source === 'html' && !pendingHtml && !g?.fileSize) return toast('Upload an HTML file first.', 'warning');
    testGame(draft, pendingHtml);
  };

  function collect() {
    return {
      ...d,
      title: f('title').value.trim(),
      category: f('category').value.trim() || 'Game',
      tags: f('tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8),
      description: f('description').value.trim(),
      controls: f('controls').value.trim(),
      driveId: extractDriveId(f('driveId').value) || '',
      file: f('file').value.trim(),
      url: f('url').value.trim(),
      featured: f('featured').checked,
      hidden: f('hidden').checked,
    };
  }

  async function save() {
    const data = collect();
    if (!data.title) { toast('Give the game a title.', 'warning'); return false; }
    if (data.source === 'drive' && !data.driveId) { toast('Enter a valid Drive link or file ID.', 'warning'); return false; }
    if (data.source === 'file' && !/^[\w./-]+\.html?$/i.test(data.file)) { toast('Enter a path like games/my-game.html', 'warning'); return false; }
    if (data.source === 'url' && !/^https?:\/\//i.test(normalizeUrl(data.url))) { toast('Enter a valid URL.', 'warning'); return false; }
    if (data.source === 'html' && !pendingHtml && !(g?.source === 'html' && g.fileSize)) { toast('Upload the game’s HTML file.', 'warning'); return false; }
    if (data.logo && data.logo.length > 700000) { toast('That logo is too large. Try a smaller image.', 'warning'); return false; }

    let id = g?.id;
    if (!id) { id = slugify(data.title); let n = 2; while (S.games.some((x) => x.id === id)) id = `${slugify(data.title)}-${n++}`; }
    const doc = {
      title: data.title, category: data.category, tags: data.tags, description: data.description, controls: data.controls,
      source: data.source, file: data.source === 'file' ? data.file.replace(/^\.?\//, '') : '', driveId: data.source === 'drive' ? data.driveId : '', url: data.source === 'url' ? normalizeUrl(data.url) : '',
      logo: data.logo || '', featured: data.featured, hidden: data.hidden,
      order: g?.order ?? (Math.max(0, ...S.games.map((x) => x.order || 0)) + 1),
      plays: g?.plays || 0,
      fileSize: data.source === 'html' ? (pendingHtml ? new Blob([pendingHtml]).size : g?.fileSize || 0) : 0,
      updatedAt: fs.serverTimestamp(),
      ...(isNew ? { createdAt: fs.serverTimestamp() } : {}),
    };
    try {
      if (data.source === 'html' && pendingHtml) { toast('Uploading game file…', 'info', 2000); await writeChunks(id, pendingHtml); }
      else if (data.source !== 'html' && g?.source === 'html') await deleteChunks(id);
      await fs.setDoc(fs.doc(db, 'games', id), doc, { merge: true });
      const local = { id, ...doc, updatedAt: new Date() };
      if (isNew) S.games.push(local); else Object.assign(S.games.find((x) => x.id === id), local);
      toast(isNew ? 'Game added' : 'Game saved', 'success');
      go('games');
    } catch (e) { toast(e.message, 'error', 6000); return false; }
  }
}

async function testGame(g, html = null) {
  const m = modal({ title: `Test: ${g.title || 'Untitled'}`, wide: true, body: `<div class="test-stage stage" data-fs></div><p class="muted small" style="margin-top:10px">Runs exactly as players will see it.</p>` });
  const stage = $('.test-stage', m.el);
  let runner;
  try {
    if (g.source === 'url') runner = mountRunner(stage, { src: normalizeUrl(g.url), title: g.title });
    else {
      stage.innerHTML = `<div class="stage-empty">${icon('refresh', 'xl spin')}</div>`;
      let src = html;
      if (!src && g.source === 'html') {
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'gameFiles', g.id, 'chunks'), fs.orderBy('i')));
        src = snap.docs.map((x) => x.data().d).join('');
      }
      if (!src && g.source === 'file') {
        const r = await fetch(g.file, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${g.file} wasn't found on the site. Did you push it to the games/ folder?`);
        src = await r.text();
      }
      if (!src && g.source === 'drive') src = (await fetchDriveHtml(g.driveId, S.settings)).html;
      runner = mountRunner(stage, { html: src, title: g.title, storageKey: 'admin-test' });
    }
  } catch (e) {
    stage.innerHTML = `<div class="stage-empty"><div class="stage-empty-icon danger">${icon('alert', 'xl')}</div><h3>Couldn't load</h3><p class="muted">${esc(e.message)}</p></div>`;
  }
  const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { runner?.destroy(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
}

/* =================================================================
   LINKS
   ================================================================= */
function links(view) {
  actions(`<button class="btn primary" data-new>${icon('plus')}<span>Add link</span></button>`).querySelector('[data-new]').onclick = () => linkEditor();
  view.innerHTML = Object.entries(LINK_CATS).map(([cat, label]) => {
    const items = S.links.filter((l) => (l.category || 'useful') === cat);
    return `<section><div class="section-head"><h2>${label}</h2><span class="muted small">${items.length}</span></div>
      <div class="table-wrap card flush"><table class="table"><tbody>
      ${items.map((l) => `<tr data-id="${esc(l.id)}"><td><div class="cell-game"><div><strong>${esc(l.title)}</strong><a class="muted small ellip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a></div></div></td><td class="muted small">${esc(l.description || '')}</td><td class="num">#${l.order ?? ''}</td>
      <td class="row-actions"><button class="icon-btn sm" data-edit>${icon('edit')}</button><button class="icon-btn sm" data-del>${icon('trash')}</button></td></tr>`).join('') || `<tr><td class="muted">No links in this category.</td></tr>`}
      </tbody></table></div></section>`;
  }).join('');
  $$('tr[data-id]', view).forEach((tr) => {
    const l = S.links.find((x) => x.id === tr.dataset.id);
    $('[data-edit]', tr).onclick = () => linkEditor(l);
    $('[data-del]', tr).onclick = async () => {
      if (!(await confirmDialog(`Delete "${l.title}"?`, { okLabel: 'Delete', danger: true }))) return;
      try { await fs.deleteDoc(fs.doc(db, 'links', l.id)); S.links = S.links.filter((x) => x.id !== l.id); go('links'); } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function linkEditor(l = null) {
  const d = l || { title: '', url: '', category: 'static', description: '', order: Math.max(0, ...S.links.map((x) => x.order || 0)) + 1 };
  modal({
    title: l ? 'Edit link' : 'Add link',
    body: `<div class="stack">
      <label class="field"><span>Title</span><input class="input" data-f="title" maxlength="80" value="${esc(d.title)}"/></label>
      <label class="field"><span>URL</span><input class="input" data-f="url" value="${esc(d.url)}" placeholder="https://"/></label>
      <div class="two">
        <label class="field"><span>Category</span><select class="input select" data-f="category">${Object.entries(LINK_CATS).map(([k, v]) => `<option value="${k}" ${d.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>Order</span><input class="input" type="number" data-f="order" value="${d.order ?? ''}"/></label>
      </div>
      <label class="field"><span>Description</span><input class="input" data-f="description" maxlength="160" value="${esc(d.description || '')}"/></label>
    </div>`,
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: 'Save', kind: 'primary', onClick: async (el) => {
      const v = (k) => $(`[data-f="${k}"]`, el).value.trim();
      let url = v('url'); if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (!v('title') || !url) { toast('Title and URL are required.', 'warning'); return false; }
      const id = l?.id || slugify(v('title')) + '-' + Date.now().toString(36).slice(-4);
      const doc = { title: v('title'), url, category: v('category'), description: v('description'), order: Number(v('order')) || 0 };
      try {
        await fs.setDoc(fs.doc(db, 'links', id), doc);
        const i = S.links.findIndex((x) => x.id === id);
        if (i >= 0) S.links[i] = { id, ...doc }; else S.links.push({ id, ...doc });
        S.links.sort(byOrder); toast('Link saved', 'success'); go('links');
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
}

/* =================================================================
   PATCH NOTES
   ================================================================= */
function notes(view) {
  actions(`<button class="btn primary" data-new>${icon('plus')}<span>New patch note</span></button>`).querySelector('[data-new]').onclick = () => noteEditor();
  view.innerHTML = `<div class="stack">${S.patchnotes.map((n) => `
    <div class="card note-row" data-id="${esc(n.id)}">
      <div class="note-main">
        <div class="row gap-sm wrap">${n.version ? `<span class="ver">v${esc(n.version)}</span>` : ''}${(n.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}${n.pinned ? `<span class="badge badge-accent">${icon('pin')}Pinned</span>` : ''}<span class="muted small">${n.date ? fmtDate(n.date) : 'No date'}</span></div>
        <h3>${esc(n.title)}</h3>
        <p class="muted small ellip">${esc((n.body || '').replace(/[#*>\[\]()`-]/g, '').slice(0, 180))}</p>
      </div>
      <div class="row-actions"><button class="icon-btn sm" data-edit>${icon('edit')}</button><button class="icon-btn sm" data-del>${icon('trash')}</button></div>
    </div>`).join('') || `<div class="empty-state card">${icon('notes', 'xl')}<p class="muted">No patch notes yet.</p></div>`}</div>`;
  $$('.note-row', view).forEach((row) => {
    const n = S.patchnotes.find((x) => x.id === row.dataset.id);
    $('[data-edit]', row).onclick = () => noteEditor(n);
    $('[data-del]', row).onclick = async () => {
      if (!(await confirmDialog(`Delete "${n.title}"?`, { okLabel: 'Delete', danger: true }))) return;
      try { await fs.deleteDoc(fs.doc(db, 'patchnotes', n.id)); S.patchnotes = S.patchnotes.filter((x) => x.id !== n.id); go('notes'); } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function noteEditor(n = null) {
  const today = new Date().toISOString().slice(0, 10);
  const d = n || { version: '', title: '', date: today, tags: ['new'], body: '', pinned: false, order: Math.max(0, ...S.patchnotes.map((x) => x.order || 0)) + 10 };
  const m = modal({
    title: n ? 'Edit patch note' : 'New patch note',
    wide: true,
    body: `<div class="editor-grid even">
      <div class="stack">
        <div class="two">
          <label class="field"><span>Version <em class="muted">(optional)</em></span><input class="input" data-f="version" maxlength="16" value="${esc(d.version || '')}" placeholder="2.1"/></label>
          <label class="field"><span>Date</span><input class="input" type="date" data-f="date" value="${esc(d.date || '')}"/></label>
        </div>
        <label class="field"><span>Title</span><input class="input" data-f="title" maxlength="100" value="${esc(d.title)}"/></label>
        <div class="field"><span>Tags</span><div class="row gap-sm wrap">${NOTE_TAGS.map((t) => `<label class="check-chip"><input type="checkbox" value="${t}" ${(d.tags || []).includes(t) ? 'checked' : ''}/><span>${t}</span></label>`).join('')}</div></div>
        <label class="field"><span>Body <em class="muted">(Markdown: **bold**, - lists, [link](url), &gt; [!warning])</em></span><textarea class="input code" rows="12" data-f="body">${esc(d.body || '')}</textarea></label>
        <div class="two">
          <label class="switch"><input type="checkbox" data-f="pinned" ${d.pinned ? 'checked' : ''}/><span></span>Pin to top</label>
          <label class="field"><span>Sort order <em class="muted">(higher = newer)</em></span><input class="input" type="number" data-f="order" value="${d.order ?? 0}"/></label>
        </div>
      </div>
      <div class="field"><span>Preview</span><div class="card prose md-preview" data-prev></div></div>
    </div>`,
    actions: [{ label: 'Cancel', kind: 'ghost' }, { label: n ? 'Save' : 'Publish', kind: 'primary', icon: 'send', onClick: async (el) => {
      const v = (k) => $(`[data-f="${k}"]`, el);
      if (!v('title').value.trim()) { toast('Title is required.', 'warning'); return false; }
      const id = n?.id || slugify(v('title').value) + '-' + Date.now().toString(36).slice(-4);
      const doc = {
        version: v('version').value.trim(), date: v('date').value, title: v('title').value.trim(), body: v('body').value,
        tags: $$('.check-chip input:checked', el).map((c) => c.value), pinned: v('pinned').checked, order: Number(v('order').value) || 0,
      };
      try {
        await fs.setDoc(fs.doc(db, 'patchnotes', id), doc);
        const i = S.patchnotes.findIndex((x) => x.id === id);
        if (i >= 0) S.patchnotes[i] = { id, ...doc }; else S.patchnotes.push({ id, ...doc });
        S.patchnotes.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
        toast('Patch note saved', 'success'); go('notes');
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
  const body = $('[data-f="body"]', m.el), prev = $('[data-prev]', m.el);
  const upd = () => (prev.innerHTML = md(body.value) || '<p class="muted">Nothing yet.</p>');
  body.addEventListener('input', debounce(upd, 120)); upd();
}

/* =================================================================
   CHAT
   ================================================================= */
function chat(view) {
  const chans = S.settings.chatChannels?.length ? [...S.settings.chatChannels] : [{ id: 'general', name: 'general', topic: '' }];
  view.innerHTML = `
  <div class="split">
    <div class="card">
      <div class="section-head"><h2>Channels</h2><button class="btn sm" data-add>${icon('plus')}<span>Add</span></button></div>
      <div class="stack" data-chans></div>
      <div class="row gap" style="margin-top:14px"><button class="btn primary" data-save-chans>${icon('save')}<span>Save channels</span></button></div>
    </div>
    <div class="card">
      <div class="section-head"><h2>Banned users</h2><span class="muted small">${S.bans.length}</span></div>
      <div class="mini-list" data-bans></div>
      <p class="muted small" style="margin-top:12px">Ban users from the chat itself — hover a message and click the ban icon.</p>
    </div>
  </div>
  <div class="card">
    <div class="section-head"><h2>Moderation</h2><select class="input select" style="width:200px" data-mod-chan>${chans.map((c) => `<option value="${esc(c.id)}">#${esc(c.name)}</option>`).join('')}</select></div>
    <div class="row gap wrap" style="margin-bottom:14px">
      <button class="btn sm" data-lock>${icon('lock')}<span>Lock channel</span></button>
      <button class="btn sm" data-unpin>${icon('pin')}<span>Clear pinned</span></button>
      <button class="btn sm danger" data-clear>${icon('trash')}<span>Delete all messages</span></button>
    </div>
    <div class="mod-log" data-mod-log></div>
  </div>`;

  const renderChans = () => {
    $('[data-chans]', view).innerHTML = chans.map((c, i) => `<div class="chan-edit" data-i="${i}">
      <span class="muted">#</span><input class="input" data-k="name" value="${esc(c.name)}" placeholder="name" maxlength="24"/>
      <input class="input" data-k="topic" value="${esc(c.topic || '')}" placeholder="Topic" maxlength="80"/>
      <button class="icon-btn sm" data-rm ${chans.length < 2 ? 'disabled' : ''}>${icon('trash')}</button></div>`).join('');
    $$('.chan-edit', view).forEach((row) => {
      const c = chans[+row.dataset.i];
      $$('input', row).forEach((inp) => (inp.oninput = () => { c[inp.dataset.k] = inp.value; if (inp.dataset.k === 'name' && c.isNew) c.id = slugify(inp.value); }));
      $('[data-rm]', row).onclick = () => { chans.splice(+row.dataset.i, 1); renderChans(); };
    });
  };
  renderChans();
  $('[data-add]', view).onclick = () => { chans.push({ id: 'channel-' + (chans.length + 1), name: 'new-channel', topic: '', isNew: true }); renderChans(); };
  $('[data-save-chans]', view).onclick = async () => {
    const clean = chans.map((c) => ({ id: slugify(c.id || c.name).slice(0, 32), name: slugify(c.name).slice(0, 24), topic: (c.topic || '').slice(0, 80) }));
    if (new Set(clean.map((c) => c.id)).size !== clean.length) return toast('Channel names must be unique.', 'warning');
    try { await saveSettings({ chatChannels: clean }); toast('Channels saved', 'success'); go('chat'); } catch (e) { toast(e.message, 'error'); }
  };

  const bansEl = $('[data-bans]', view);
  bansEl.innerHTML = S.bans.length ? S.bans.map((b) => `<div class="mini-item" data-uid="${esc(b.id)}">${icon('ban')}<span class="mini-text"><strong>${esc(b.name || 'Unknown')}</strong> <span class="muted small">${b.at ? timeAgo(b.at) : ''}</span></span><button class="btn sm ghost" data-unban>Unban</button></div>`).join('') : '<p class="muted">Nobody is banned.</p>';
  $$('[data-unban]', bansEl).forEach((b) => (b.onclick = async () => {
    const uid = b.closest('[data-uid]').dataset.uid;
    try { await fs.deleteDoc(fs.doc(db, 'bans', uid)); S.bans = S.bans.filter((x) => x.id !== uid); toast('Unbanned', 'success'); go('chat'); } catch (e) { toast(e.message, 'error'); }
  }));

  const sel = $('[data-mod-chan]', view);
  let unsub = null, chanData = {};
  const load = () => {
    unsub?.();
    const cid = sel.value;
    fs.getDoc(fs.doc(db, 'channels', cid)).then((s) => {
      chanData = s.exists() ? s.data() : {};
      $('[data-lock]', view).innerHTML = chanData.locked ? `${icon('unlock')}<span>Unlock channel</span>` : `${icon('lock')}<span>Lock channel</span>`;
    });
    const q = fs.query(fs.collection(db, 'channels', cid, 'messages'), fs.orderBy('createdAt', 'desc'), fs.limit(50));
    unsub = fs.onSnapshot(q, (snap) => {
      const log = $('[data-mod-log]', view);
      if (!log) return unsub?.();
      log.innerHTML = snap.docs.length ? snap.docs.map((d) => { const m = d.data(); return `<div class="mod-msg" data-id="${d.id}"><strong>${esc(m.name)}</strong><span class="mini-text">${esc(m.text)}</span><span class="muted small">${m.createdAt ? timeAgo(m.createdAt) : ''}</span><button class="icon-btn sm" data-del>${icon('trash')}</button></div>`; }).join('') : '<p class="muted">No messages.</p>';
      $$('[data-del]', log).forEach((b) => (b.onclick = () => fs.deleteDoc(fs.doc(db, 'channels', cid, 'messages', b.closest('[data-id]').dataset.id)).catch((e) => toast(e.message, 'error'))));
    });
  };
  sel.onchange = load; load();
  $('[data-lock]', view).onclick = async () => {
    try { await fs.setDoc(fs.doc(db, 'channels', sel.value), { locked: !chanData.locked }, { merge: true }); toast(chanData.locked ? 'Unlocked' : 'Locked', 'success'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  $('[data-unpin]', view).onclick = () => fs.setDoc(fs.doc(db, 'channels', sel.value), { pinned: null }, { merge: true }).then(() => toast('Pinned message cleared', 'success'), (e) => toast(e.message, 'error'));
  $('[data-clear]', view).onclick = async () => {
    if (!(await confirmDialog(`Permanently delete every message in #${sel.selectedOptions[0].text.slice(1)}?`, { okLabel: 'Delete all', danger: true }))) return;
    let total = 0;
    try {
      for (;;) {
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'channels', sel.value, 'messages'), fs.limit(400)));
        if (snap.empty) break;
        const batch = fs.writeBatch(db); snap.docs.forEach((d) => batch.delete(d.ref)); await batch.commit(); total += snap.size;
      }
      toast(`Deleted ${total} messages`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* =================================================================
   REPORTS
   ================================================================= */
function reports(view) {
  let filter = 'open';
  const render = () => {
    const items = S.reports.filter((r) => filter === 'all' || (filter === 'open' ? r.status !== 'resolved' : r.status === 'resolved'));
    view.innerHTML = `<div class="chips">${['open', 'resolved', 'all'].map((f) => `<button class="chip ${filter === f ? 'active' : ''}" data-f="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div>
    <div class="stack">${items.map((r) => `<div class="card report ${r.status === 'resolved' ? 'resolved' : ''}" data-id="${r.id}">
      <div class="row between wrap gap"><div class="row gap-sm"><span class="badge badge-warn">${esc(r.type)}</span>${r.contact ? `<span class="small">from <strong>${esc(r.contact)}</strong></span>` : ''}</div><span class="muted small">${r.createdAt ? timeAgo(r.createdAt) : ''}${r.page ? ` · ${esc(r.page)}` : ''}</span></div>
      <p class="report-msg">${esc(r.message)}</p>
      <div class="row gap-sm"><button class="btn sm" data-toggle>${icon(r.status === 'resolved' ? 'refresh' : 'check')}<span>${r.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</span></button><button class="btn sm ghost" data-del>${icon('trash')}<span>Delete</span></button></div>
    </div>`).join('') || `<div class="empty-state card">${icon('inbox', 'xl')}<p class="muted">Nothing here.</p></div>`}</div>`;
    $$('[data-f]', view).forEach((b) => (b.onclick = () => { filter = b.dataset.f; render(); }));
    $$('.report', view).forEach((el) => {
      const r = S.reports.find((x) => x.id === el.dataset.id);
      $('[data-toggle]', el).onclick = async () => {
        const status = r.status === 'resolved' ? 'open' : 'resolved';
        try { await fs.updateDoc(fs.doc(db, 'reports', r.id), { status }); r.status = status; render(); } catch (e) { toast(e.message, 'error'); }
      };
      $('[data-del]', el).onclick = async () => {
        try { await fs.deleteDoc(fs.doc(db, 'reports', r.id)); S.reports = S.reports.filter((x) => x.id !== r.id); render(); } catch (e) { toast(e.message, 'error'); }
      };
    });
  };
  render();
}

/* =================================================================
   SETTINGS
   ================================================================= */
function settings(view) {
  const s = S.settings;
  const a = s.announcement || {};
  view.innerHTML = `
  <div class="stack settings">
    <section class="card">
      <div class="section-head"><h2>${icon('megaphone')} Announcement banner</h2></div>
      <div class="stack">
        <label class="switch"><input type="checkbox" data-k="ann.enabled" ${a.enabled ? 'checked' : ''}/><span></span>Show banner on every page</label>
        <div class="two">
          <label class="field"><span>Style</span><select class="input select" data-k="ann.level">${['info', 'success', 'warning', 'danger'].map((l) => `<option ${a.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Message</span><input class="input" data-k="ann.text" maxlength="200" value="${esc(a.text || '')}"/></label>
      </div>
    </section>

    <section class="card">
      <div class="section-head"><h2>${icon('cpu')} Emulator</h2></div>
      <div class="stack">
        <label class="field"><span>Emulator backend URL <em class="muted">(your deployed apps-script/GGEmulator.gs /exec URL)</em></span><input class="input" data-k="emulatorApi" value="${esc(s.emulatorApi || '')}" placeholder="https://script.google.com/macros/s/.../exec"/></label>
        <label class="field"><span>Drive API key <em class="muted">(optional alternative)</em></span><input class="input" data-k="driveApiKey" value="${esc(s.driveApiKey || '')}" placeholder="AIza..."/></label>
        <label class="field"><span>Legacy emulator URL <em class="muted">(fallback button for Drive games)</em></span><input class="input" data-k="legacyEmulatorUrl" value="${esc(s.legacyEmulatorUrl || '')}"/></label>
        <div class="row gap"><button class="btn sm" data-test-emu>${icon('activity')}<span>Test backend with a Drive link</span></button></div>
      </div>
    </section>

    <section class="card">
      <div class="section-head"><h2>${icon('chat')} Chat & onboarding</h2></div>
      <div class="stack">
        <label class="switch"><input type="checkbox" data-k="chatGuests" ${s.chatGuests ? 'checked' : ''}/><span></span>Allow guests to chat without a Google account <em class="muted small">(enable Anonymous sign-in in Firebase first)</em></label>
        <label class="field"><span>Legacy chat URL (C-App)</span><input class="input" data-k="legacyChatUrl" value="${esc(s.legacyChatUrl || '')}"/></label>
        <label class="switch"><input type="checkbox" data-k="onboardingEnabled" ${s.onboardingEnabled !== false ? 'checked' : ''}/><span></span>Show the welcome tour to first-time visitors</label>
      </div>
    </section>

    <section class="card">
      <div class="section-head"><h2>${icon('book')} The Method page</h2></div>
      <div class="editor-grid even">
        <textarea class="input code" rows="18" data-k="methodMarkdown">${esc(s.methodMarkdown || '')}</textarea>
        <div class="card prose md-preview" data-prev></div>
      </div>
    </section>
  </div>`;
  const bar = actions(`<span class="muted small" data-dirty></span><button class="btn primary" data-save>${icon('save')}<span>Save settings</span></button>`);
  const prev = $('[data-prev]', view), mdEl = $('[data-k="methodMarkdown"]', view);
  const upd = () => (prev.innerHTML = md(mdEl.value));
  mdEl.addEventListener('input', debounce(upd, 150)); upd();
  view.addEventListener('input', () => ($('[data-dirty]', bar).textContent = 'Unsaved changes'));

  $('[data-save]', bar).onclick = async () => {
    const v = (k) => $(`[data-k="${k}"]`, view);
    const patch = {
      announcement: { enabled: v('ann.enabled').checked, level: v('ann.level').value, text: v('ann.text').value.trim() },
      emulatorApi: v('emulatorApi').value.trim(),
      driveApiKey: v('driveApiKey').value.trim(),
      legacyEmulatorUrl: v('legacyEmulatorUrl').value.trim(),
      legacyChatUrl: v('legacyChatUrl').value.trim(),
      chatGuests: v('chatGuests').checked,
      onboardingEnabled: v('onboardingEnabled').checked,
      methodMarkdown: v('methodMarkdown').value,
    };
    if (!S.settingsExists) patch.chatChannels = S.settings.chatChannels || [];
    try { await saveSettings(patch); $('[data-dirty]', bar).textContent = ''; toast('Settings saved', 'success'); } catch (e) { toast(e.message, 'error'); }
  };

  $('[data-test-emu]', view).onclick = () => {
    modal({
      title: 'Test emulator backend',
      body: `<label class="field"><span>Drive link to a shared HTML file</span><input class="input" placeholder="https://drive.google.com/file/d/.../view"/></label><p class="muted small" style="margin-top:8px">Uses the values currently typed in the form (save to apply them site-wide).</p>`,
      actions: [{ label: 'Close', kind: 'ghost' }, { label: 'Run test', kind: 'primary', onClick: async (el) => {
        const id = extractDriveId($('input', el).value);
        if (!id) { toast('Enter a Drive link.', 'warning'); return false; }
        try {
          const r = await fetchDriveHtml(id, { emulatorApi: $('[data-k="emulatorApi"]', view).value.trim(), driveApiKey: $('[data-k="driveApiKey"]', view).value.trim() });
          toast(`Success: loaded ${r.name} (${fmtBytes(r.html.length)})`, 'success', 5000);
        } catch (e) { toast(e.message, 'error', 7000); }
        return false;
      } }],
    });
  };
}

/* =================================================================
   BACKUP
   ================================================================= */
function backup(view) {
  view.innerHTML = `
  <div class="split">
    <div class="card stack">
      <h2>${icon('download')} Export</h2>
      <p class="muted">Download everything (games, links, patch notes, settings) as JSON. Uploaded game files are not included unless you tick the box.</p>
      <label class="switch"><input type="checkbox" data-files/><span></span>Include uploaded game files (can be large)</label>
      <button class="btn primary" data-export>${icon('download')}<span>Download backup</span></button>
    </div>
    <div class="card stack">
      <h2>${icon('upload')} Import</h2>
      <p class="muted">Restore from a backup, or load the starter data from <code>data/seed.json</code>. Items with matching IDs are overwritten.</p>
      <label class="btn"><input type="file" accept=".json,application/json" hidden data-import/>${icon('upload')}<span>Import backup file</span></label>
      <button class="btn" data-seed>${icon('database')}<span>Import starter data</span></button>
    </div>
  </div>`;
  $('[data-seed]', view).onclick = importSeed;
  $('[data-export]', view).onclick = async () => {
    const out = { exportedAt: new Date().toISOString(), settings: S.settings, games: S.games, links: S.links, patchnotes: S.patchnotes, files: {} };
    if ($('[data-files]', view).checked) {
      for (const g of S.games.filter((x) => x.source === 'html')) {
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'gameFiles', g.id, 'chunks'), fs.orderBy('i')));
        out.files[g.id] = snap.docs.map((d) => d.data().d).join('');
      }
    }
    const clean = JSON.stringify(out, (k, v) => (v && typeof v === 'object' && 'seconds' in v && 'nanoseconds' in v ? new Date(v.seconds * 1000).toISOString() : v), 2);
    downloadText(`green-grass-backup-${new Date().toISOString().slice(0, 10)}.json`, clean, 'application/json');
  };
  $('[data-import]', view).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast('That isn’t valid JSON.', 'error'); }
    if (!(await confirmDialog(`Import ${data.games?.length || 0} games, ${data.links?.length || 0} links and ${data.patchnotes?.length || 0} patch notes?`, { okLabel: 'Import' }))) return;
    try {
      const strip = ({ id, createdAt, updatedAt, ...rest }) => rest;
      const ops = [
        ...(data.games || []).map((x) => [fs.doc(db, 'games', x.id), strip(x)]),
        ...(data.links || []).map((x) => [fs.doc(db, 'links', x.id), strip(x)]),
        ...(data.patchnotes || []).map((x) => [fs.doc(db, 'patchnotes', x.id), strip(x)]),
      ];
      for (let i = 0; i < ops.length; i += 400) { const b = fs.writeBatch(db); ops.slice(i, i + 400).forEach(([r, d]) => b.set(r, d)); await b.commit(); }
      if (data.settings) { const { updatedAt, ...st } = data.settings; await saveSettings(st); }
      for (const [id, html] of Object.entries(data.files || {})) await writeChunks(id, html);
      toast('Import complete', 'success'); await loadAll(); shell();
    } catch (err) { toast(err.message, 'error', 6000); }
  };
}

/* =================================================================
   ADMIN CODES (owner only)
   ================================================================= */
function codes(view) {
  const bar = actions(`<input class="input code-label" data-label maxlength="40" placeholder="Label (optional), e.g. For Ethan"/><button class="btn primary" data-gen>${icon('plus')}<span>Generate code</span></button>`);
  const used = S.codes.filter((c) => c.redeemedBy).length;
  view.innerHTML = `
  <div class="callout callout-note">${icon('info')}<div><strong>How admin codes work</strong>
    <p>Each code gives <strong>one person</strong> admin access. They sign in at <code>/admin.html</code> (personal Google account, or "Continue without Google") and enter the code. <strong>Delete a code to remove that person's access instantly.</strong> Only you can see this page.</p></div></div>
  <div class="row between"><span class="muted small">${S.codes.length} code${S.codes.length === 1 ? '' : 's'} · ${used} in use · ${S.codes.length - used} unused</span></div>
  <div class="table-wrap card flush"><table class="table">
    <thead><tr><th>Code</th><th>Label</th><th>Status</th><th>Created</th><th></th></tr></thead>
    <tbody>${S.codes.length ? S.codes.map((c) => `<tr data-id="${esc(c.id)}">
      <td><div class="row gap-sm"><code class="code-chip">${esc(c.id)}</code><button class="icon-btn sm" data-copy title="Copy">${icon('copy')}</button></div></td>
      <td>${esc(c.label || '') || '<span class="muted">—</span>'}</td>
      <td>${c.redeemedBy
        ? `<div class="row gap-sm"><span class="badge badge-accent">${icon('check')}In use</span><span class="small">${esc(c.redeemedName || c.redeemedEmail || 'Guest')}${c.redeemedEmail && c.redeemedName ? ` <span class="muted">· ${esc(c.redeemedEmail)}</span>` : ''}</span></div>`
        : '<span class="badge badge-muted">Unused</span>'}</td>
      <td class="muted small">${c.createdAt ? timeAgo(c.createdAt) : ''}</td>
      <td class="row-actions"><button class="btn sm ghost" data-del>${icon('trash')}<span>${c.redeemedBy ? 'Revoke' : 'Delete'}</span></button></td>
    </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state">${icon('shield', 'xl')}<p class="muted">No codes yet. Click <strong>Generate code</strong>.</p></div></td></tr>`}</tbody>
  </table></div>`;

  $('[data-gen]', bar).onclick = async () => {
    const label = $('[data-label]', bar).value.trim().slice(0, 40);
    const code = generateCode();
    try {
      await fs.setDoc(fs.doc(db, 'adminCodes', code), { label, redeemedBy: null, createdAt: fs.serverTimestamp() });
      S.codes.unshift({ id: code, label, redeemedBy: null, createdAt: new Date() });
      navigator.clipboard?.writeText(code).catch(() => {});
      toast(`Generated ${code} (copied)`, 'success', 4000);
      go('codes');
    } catch (e) { toast(e.message, 'error'); }
  };
  $$('tr[data-id]', view).forEach((tr) => {
    const c = S.codes.find((x) => x.id === tr.dataset.id);
    $('[data-copy]', tr).onclick = () => navigator.clipboard?.writeText(c.id).then(() => toast('Code copied', 'success', 1400));
    $('[data-del]', tr).onclick = async () => {
      const who = c.redeemedName || c.redeemedEmail || 'this person';
      const ok = await confirmDialog(c.redeemedBy ? `Revoke ${c.id}? ${who} will lose admin access immediately.` : `Delete unused code ${c.id}?`, { okLabel: c.redeemedBy ? 'Revoke' : 'Delete', danger: true });
      if (!ok) return;
      try {
        const batch = fs.writeBatch(db);
        batch.delete(fs.doc(db, 'adminCodes', c.id));
        if (c.redeemedBy) batch.delete(fs.doc(db, 'admins', c.redeemedBy));
        await batch.commit();
        S.codes = S.codes.filter((x) => x.id !== c.id);
        toast(c.redeemedBy ? `Access revoked for ${who}` : 'Code deleted', 'success');
        go('codes');
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

boot();
