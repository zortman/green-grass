/* Green Grass — main site app (hash router + views). */
import { CONFIG } from './config.js';
import { loadSite, getCached, favs, recents, submitReport } from './data.js';
import {
  $, $$, esc, icon, md, toast, modal, store, gameLogo, fmtDate, debounce,
  installIcons, applyTheme, setTheme, LOGO_SVG, ACCENTS, setAccent,
} from './ui.js';
import { playGame, downloadGame, SOURCE_LABEL } from './player.js';
import { checkLink, checkMany } from './linkcheck.js';
import { shouldOnboard, openOnboarding } from './onboarding.js';

applyTheme();
installIcons();

const site = { siteName: CONFIG.siteName, settings: {}, games: [], links: [], patchnotes: [] };
let cleanup = null;

const NAV = [
  { group: 'Browse', items: [
    { r: 'home', label: 'Home', icon: 'home' },
    { r: 'games', label: 'Games', icon: 'gamepad' },
    { r: 'emulator', label: 'Emulator', icon: 'cpu' },
  ] },
  { group: 'Community', items: [
    { r: 'chat', label: 'Chat', icon: 'chat' },
    { r: 'notes', label: 'Patch Notes', icon: 'notes' },
  ] },
  { group: 'Resources', items: [
    { r: 'method', label: 'The Method', icon: 'book' },
    { r: 'links', label: 'Links', icon: 'link' },
    { r: 'checker', label: 'Link Checker', icon: 'shieldCheck' },
  ] },
];

const LINK_GROUPS = [
  { id: 'static', title: 'Unblocked static sites', desc: 'Mirrors that are usually reachable on school networks.' },
  { id: 'useful', title: 'Useful sites', desc: 'Handy tools and references.' },
  { id: 'tools', title: 'Tools & source code', desc: 'Our utilities and the source for past projects.' },
];

/* ================================================================
   SHELL
   ================================================================ */
function renderShell() {
  document.body.insertAdjacentHTML('beforeend', `
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <a class="brand" href="#/home">${LOGO_SVG}<span>${esc(site.siteName)}</span></a>
      <nav class="nav">
        ${NAV.map((g) => `<div class="nav-group"><span class="nav-label">${g.group}</span>${g.items.map((n) =>
          `<a class="nav-item" href="#/${n.r}" data-r="${n.r}">${icon(n.icon)}<span>${n.label}</span></a>`).join('')}</div>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="accent-row">${ACCENTS.map((a) => `<button class="dot-swatch" data-accent="${a.id}" style="--c:${a.c}" title="${a.name}" aria-label="${a.name} accent"></button>`).join('')}</div>
        <div class="row gap-sm">
          <button class="icon-btn" data-theme-toggle title="Toggle theme">${icon('moon')}</button>
          <button class="icon-btn" data-tour title="Replay welcome tour">${icon('compass')}</button>
          <button class="icon-btn" data-report title="Report a problem">${icon('flag')}</button>
          <a class="icon-btn" href="admin.html" title="Admin">${icon('shield')}</a>
        </div>
      </div>
    </aside>
    <div class="scrim" data-scrim></div>
    <div class="main">
      <div id="announce"></div>
      <header class="topbar">
        <button class="icon-btn menu-btn" data-menu aria-label="Menu">${icon('menu')}</button>
        <button class="search-trigger" data-palette>${icon('search')}<span>Search games, pages, links</span><kbd>/</kbd></button>
        <div class="topbar-right"><a class="btn sm" href="#/emulator">${icon('cpu')}<span>Open emulator</span></a></div>
      </header>
      <main id="view" tabindex="-1"></main>
      <footer class="site-foot">
        <span>${esc(site.siteName)} · <span class="muted">${esc(CONFIG.tagline)}</span></span>
        <span class="muted small" data-source></span>
      </footer>
    </div>
  </div>`);

  $('[data-menu]').onclick = () => document.body.classList.toggle('nav-open');
  $('[data-scrim]').onclick = () => document.body.classList.remove('nav-open');
  $('[data-theme-toggle]').onclick = () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); syncThemeIcon(); };
  $('[data-tour]').onclick = () => openOnboarding(site);
  $('[data-report]').onclick = () => openReport();
  $('[data-palette]').onclick = openPalette;
  $$('[data-accent]').forEach((b) => (b.onclick = () => { setAccent(b.dataset.accent); syncAccent(); }));
  syncThemeIcon(); syncAccent();

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); openPalette(); }
  });
}

function syncThemeIcon() {
  const b = $('[data-theme-toggle]');
  if (b) b.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
}
function syncAccent() {
  const a = store.get('gg.accent', 'meadow');
  $$('.sidebar [data-accent]').forEach((b) => b.classList.toggle('active', b.dataset.accent === a));
}

function renderAnnouncement() {
  const a = site.settings.announcement;
  const el = $('#announce');
  const dismissed = store.get('gg.announce.dismissed', '');
  if (!a?.enabled || !a.text || dismissed === a.text) { el.innerHTML = ''; return; }
  const ic = { warning: 'alert', danger: 'alert', success: 'check', info: 'megaphone' }[a.level] || 'megaphone';
  el.innerHTML = `<div class="announce announce-${esc(a.level || 'info')}">${icon(ic)}<span>${esc(a.text)}</span><button class="icon-btn sm" aria-label="Dismiss">${icon('x')}</button></div>`;
  $('button', el).onclick = () => { store.set('gg.announce.dismissed', a.text); el.innerHTML = ''; };
}

/* ================================================================
   ROUTER
   ================================================================ */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  return { route: parts[0] || 'home', arg: parts[1] ? decodeURIComponent(parts[1]) : null, params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  const { route: r, arg, params } = parseHash();
  cleanup?.(); cleanup = null;
  document.body.classList.remove('nav-open');
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.r === r || (r === 'play' && a.dataset.r === 'games')));
  const view = $('#view');
  view.className = `view view-${r}`;
  view.innerHTML = '';
  const views = { home, games, play, emulator, chat, method, links, notes, checker };
  const fn = views[r] || notFound;
  const title = { home: '', games: 'Games', emulator: 'Emulator', chat: 'Chat', method: 'The Method', links: 'Links', notes: 'Patch Notes', checker: 'Link Checker' }[r];
  document.title = title ? `${title} · ${site.siteName}` : `${site.siteName} — ${CONFIG.tagline}`;
  const res = await fn(view, arg, params);
  if (typeof res === 'function') cleanup = res;
  view.classList.add('enter');
  if (r !== 'play') window.scrollTo({ top: 0 });
}

/* ================================================================
   COMPONENTS
   ================================================================ */
function gameCard(g) {
  const fav = favs.has(g.id);
  return `<a class="game-card" href="#/play/${encodeURIComponent(g.id)}" data-id="${esc(g.id)}">
    <div class="gc-art">${gameLogo(g, 'gc-logo')}<span class="gc-play">${icon('play')}</span></div>
    <div class="gc-body">
      <div class="gc-title">${esc(g.title)}</div>
      <div class="gc-meta"><span>${esc(g.category || 'Game')}</span>${g.featured ? `<span class="dot"></span><span class="accent-text">Featured</span>` : ''}</div>
    </div>
    <button class="fav-btn ${fav ? 'on' : ''}" data-fav="${esc(g.id)}" aria-label="${fav ? 'Remove from' : 'Add to'} favorites">${icon('star')}</button>
  </a>`;
}

function bindFavs(root, onChange) {
  $$('[data-fav]', root).forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const on = favs.toggle(b.dataset.fav);
    b.classList.toggle('on', on);
    toast(on ? 'Added to favorites' : 'Removed from favorites', 'success', 1600);
    onChange?.();
  }));
}

function sectionHead(title, link, linkLabel = 'View all') {
  return `<div class="section-head"><h2>${title}</h2>${link ? `<a class="link-more" href="${link}">${linkLabel}${icon('arrowRight')}</a>` : ''}</div>`;
}

function tagBadge(t) {
  const map = { new: 'accent', fix: 'info', improvement: 'violet', notice: 'warn' };
  return `<span class="badge badge-${map[t] || 'muted'}">${esc(t)}</span>`;
}

function favicon(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; } catch { return ''; }
}

/* ================================================================
   VIEWS
   ================================================================ */
function home(root) {
  const featured = site.games.filter((g) => g.featured);
  const recent = recents.all().map((id) => site.games.find((g) => g.id === id)).filter(Boolean).slice(0, 6);
  const latest = site.patchnotes[0];
  const cats = new Set(site.games.map((g) => g.category)).size;

  root.innerHTML = `
  <section class="hero">
    <div class="hero-glow"></div>
    <div class="hero-grass" aria-hidden="true"></div>
    <div class="hero-inner">
      <span class="pill">${icon('zap')}<span>${latest ? `New: ${esc(latest.title)}` : 'Welcome'}</span></span>
      <h1>${esc(site.siteName)}</h1>
      <p class="lead">${esc(CONFIG.tagline)} Play instantly, run your own HTML files, and chat with everyone — no installs.</p>
      <div class="row gap wrap">
        <a class="btn primary lg" href="#/games">${icon('gamepad')}<span>Browse games</span></a>
        <a class="btn lg" href="#/emulator">${icon('cpu')}<span>Open the emulator</span></a>
      </div>
      <div class="stats">
        <div><strong>${site.games.length}</strong><span>Games</span></div>
        <div><strong>${cats}</strong><span>Categories</span></div>
        <div><strong>${site.links.length}</strong><span>Links</span></div>
        <div><strong>${latest?.version ? 'v' + esc(latest.version) : site.patchnotes.length}</strong><span>${latest?.version ? 'Latest' : 'Updates'}</span></div>
      </div>
    </div>
  </section>

  ${recent.length ? `<section>${sectionHead('Continue playing', '#/games?cat=__recent')}<div class="game-grid">${recent.map(gameCard).join('')}</div></section>` : ''}

  <section>${sectionHead('Featured', '#/games')}<div class="game-grid">${(featured.length ? featured : site.games.slice(0, 6)).map(gameCard).join('')}</div></section>

  <section class="split">
    <div class="card quick">
      ${sectionHead('Get around')}
      <div class="quick-grid">
        ${[['book', 'The Method', 'How Green Grass works', '#/method'], ['link', 'Links', 'Unblocked & useful sites', '#/links'], ['chat', 'Chat', 'Talk with the community', '#/chat'], ['shieldCheck', 'Link Checker', 'Is it blocked for you?', '#/checker']]
          .map(([i, t, d, h]) => `<a class="quick-tile" href="${h}"><span class="qt-icon">${icon(i)}</span><span><strong>${t}</strong><small>${d}</small></span>${icon('chevronRight', 'qt-arrow')}</a>`).join('')}
      </div>
    </div>
    ${latest ? `<a class="card latest" href="#/notes">
      <div class="row between"><span class="eyebrow">${icon('notes')} Latest update</span>${latest.date ? `<span class="muted small">${fmtDate(latest.date)}</span>` : ''}</div>
      <h3>${latest.version ? `<span class="ver">v${esc(latest.version)}</span>` : ''}${esc(latest.title)}</h3>
      <div class="prose clamp">${md(latest.body)}</div>
      <span class="link-more">Read all patch notes ${icon('arrowRight')}</span>
    </a>` : ''}
  </section>`;
  bindFavs(root);
}

function games(root, _arg, params) {
  const cats = [...new Set(site.games.map((g) => g.category || 'Game'))].sort();
  let cat = params.cat || 'all';
  let q = params.q || '';
  let sort = store.get('gg.sort', 'featured');

  root.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">${icon('gamepad')} Library</span><h1>Games</h1><p class="muted">${site.games.length} games. Everything runs right in your browser.</p></div></div>
  <div class="toolbar">
    <label class="search-field">${icon('search')}<input class="input" type="search" placeholder="Search games" value="${esc(q)}" data-q/></label>
    <select class="input select" data-sort>
      <option value="featured">Featured first</option><option value="az">A – Z</option><option value="popular">Most played</option><option value="new">Newest</option>
    </select>
  </div>
  <div class="chips" data-chips></div>
  <div class="game-grid" data-grid></div>`;

  const chips = $('[data-chips]', root);
  const grid = $('[data-grid]', root);
  $('[data-sort]', root).value = sort;

  function renderChips() {
    const all = [['all', 'All'], ['__fav', 'Favorites'], ['__recent', 'Recent'], ...cats.map((c) => [c, c])];
    chips.innerHTML = all.map(([id, label]) => `<button class="chip ${cat === id ? 'active' : ''}" data-cat="${esc(id)}">${id === '__fav' ? icon('star') : id === '__recent' ? icon('clock') : ''}${esc(label)}</button>`).join('');
    $$('[data-cat]', chips).forEach((b) => (b.onclick = () => { cat = b.dataset.cat; renderChips(); renderGrid(); }));
  }

  function renderGrid() {
    let list = [...site.games];
    if (cat === '__fav') { const f = favs.all(); list = list.filter((g) => f.includes(g.id)); }
    else if (cat === '__recent') { const r = recents.all(); list = r.map((id) => list.find((g) => g.id === id)).filter(Boolean); }
    else if (cat !== 'all') list = list.filter((g) => (g.category || 'Game') === cat);
    if (q) { const s = q.toLowerCase(); list = list.filter((g) => `${g.title} ${g.category} ${g.description} ${(g.tags || []).join(' ')}`.toLowerCase().includes(s)); }
    if (cat !== '__recent') {
      if (sort === 'az') list.sort((a, b) => a.title.localeCompare(b.title));
      if (sort === 'popular') list.sort((a, b) => (b.plays || 0) - (a.plays || 0));
      if (sort === 'new') list.sort((a, b) => (b.createdAt?.seconds || b.order || 0) - (a.createdAt?.seconds || a.order || 0));
      if (sort === 'featured') list.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    }
    grid.innerHTML = list.length ? list.map(gameCard).join('') : `<div class="empty-state wide">${icon(cat === '__fav' ? 'star' : 'search', 'xl')}<h3>${cat === '__fav' ? 'No favorites yet' : 'Nothing found'}</h3><p class="muted">${cat === '__fav' ? 'Tap the star on any game to save it here.' : 'Try a different search or category.'}</p></div>`;
    bindFavs(grid, () => cat === '__fav' && renderGrid());
  }

  $('[data-q]', root).addEventListener('input', debounce((e) => { q = e.target.value.trim(); renderGrid(); }, 120));
  $('[data-sort]', root).onchange = (e) => { sort = e.target.value; store.set('gg.sort', sort); renderGrid(); };
  renderChips(); renderGrid();
  if (!params.q) $('[data-q]', root).focus({ preventScroll: true });
}

async function play(root, id) {
  const g = site.games.find((x) => x.id === id);
  if (!g) return notFound(root);
  const more = site.games.filter((x) => x.id !== g.id && x.category === g.category).concat(site.games.filter((x) => x.id !== g.id && x.category !== g.category)).slice(0, 6);
  root.innerHTML = `
  <a class="back-link" href="#/games">${icon('chevronLeft')}All games</a>
  <div class="player" data-fs>
    <div class="stage-bar">
      <div class="stage-title">${gameLogo(g, 'mini-logo')}<span>${esc(g.title)}</span><span class="badge">${SOURCE_LABEL[g.source] || 'Game'}</span></div>
      <div class="stage-actions">
        <button class="icon-btn" data-act="reload" title="Restart">${icon('refresh')}</button>
        <button class="icon-btn fav-toggle ${favs.has(g.id) ? 'on' : ''}" data-act="fav" title="Favorite">${icon('star')}</button>
        <button class="icon-btn" data-act="download" title="Download">${icon('download')}</button>
        <a class="icon-btn" href="play.html?id=${encodeURIComponent(g.id)}" target="_blank" rel="noopener" title="Open in new tab">${icon('external')}</a>
        <button class="icon-btn" data-act="report" title="Report a problem">${icon('flag')}</button>
        <button class="icon-btn" data-act="fs" title="Fullscreen">${icon('maximize')}</button>
      </div>
    </div>
    <div class="stage game-stage"></div>
  </div>
  <div class="play-info">
    <div class="card play-about">
      ${gameLogo(g, 'about-logo')}
      <div>
        <h1>${esc(g.title)}</h1>
        <div class="gc-meta"><span>${esc(g.category || 'Game')}</span>${g.plays ? `<span class="dot"></span><span>${g.plays.toLocaleString()} plays</span>` : ''}</div>
        ${g.description ? `<p class="muted">${esc(g.description)}</p>` : ''}
        ${g.controls ? `<p class="small"><strong>Controls:</strong> ${esc(g.controls)}</p>` : ''}
      </div>
    </div>
  </div>
  ${more.length ? `<section>${sectionHead('More games', '#/games')}<div class="game-grid">${more.map(gameCard).join('')}</div></section>` : ''}`;
  bindFavs(root);
  window.scrollTo({ top: 0 });

  const stage = $('.game-stage', root);
  let res = await playGame(stage, g, site.settings);
  $$('[data-act]', root).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act;
    if (a === 'reload') { if (res) res.runner.reload(); else res = await playGame(stage, g, site.settings); }
    if (a === 'fs') (document.fullscreenElement ? document.exitFullscreen() : $('.player', root).requestFullscreen?.().catch(() => {}));
    if (a === 'download') downloadGame(g, res?.html);
    if (a === 'report') openReport('Broken game', `Game: ${g.title}\n\n`);
    if (a === 'fav') { const on = favs.toggle(g.id); b.classList.toggle('on', on); toast(on ? 'Added to favorites' : 'Removed from favorites', 'success', 1600); }
  }));
  return () => res?.runner.destroy();
}

async function emulator(root, _a, params) {
  const { mountEmulator } = await import('./emulator.js');
  return mountEmulator(root, site, params);
}

async function chat(root) {
  root.innerHTML = `<div class="page-head compact"><div><span class="eyebrow">${icon('chat')} Community</span><h1>Chat</h1></div></div><div data-chat></div>`;
  const { mountChat } = await import('./chat.js');
  return mountChat($('[data-chat]', root), site);
}

function method(root) {
  root.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">${icon('book')} Guide</span><h1>The Method</h1><p class="muted">How Green Grass works, and why.</p></div></div>
  <div class="split wide-left">
    <article class="card prose">${md(site.settings.methodMarkdown || '_No content yet._')}</article>
    <aside class="stack">
      <a class="card cta-card" href="#/emulator">${icon('cpu', 'lg')}<strong>Try the emulator</strong><span class="muted small">Open any HTML file in a sandbox right here.</span></a>
      <a class="card cta-card" href="#/checker">${icon('shieldCheck', 'lg')}<strong>Check a link</strong><span class="muted small">See if a site is reachable on your network.</span></a>
      <a class="card cta-card" href="#/games">${icon('gamepad', 'lg')}<strong>Play games</strong><span class="muted small">${site.games.length} games ready to go.</span></a>
    </aside>
  </div>`;
}

function links(root) {
  root.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">${icon('link')} Resources</span><h1>Links</h1><p class="muted">Unblocked mirrors, useful sites, and our tools.</p></div>
    <button class="btn" data-checkall>${icon('shieldCheck')}<span>Check all from my network</span></button></div>
  ${LINK_GROUPS.map((grp) => {
    const items = site.links.filter((l) => (l.category || 'useful') === grp.id);
    if (!items.length) return '';
    return `<section>${sectionHead(grp.title)}<p class="muted section-sub">${grp.desc}</p><div class="link-grid">${items.map((l) => `
      <div class="link-card" data-url="${esc(l.url)}">
        <img class="favicon" src="${esc(favicon(l.url))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'favicon fallback'}))"/>
        <div class="lc-body"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="lc-title">${esc(l.title)}</a><span class="muted small">${esc(l.description || hostOf(l.url))}</span></div>
        <span class="status-dot" data-status title="Not checked"></span>
        <button class="icon-btn sm" data-copy title="Copy link">${icon('copy')}</button>
        <a class="icon-btn sm" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="Open">${icon('external')}</a>
      </div>`).join('')}</div></section>`;
  }).join('')}`;
  $$('[data-copy]', root).forEach((b) => (b.onclick = () => {
    navigator.clipboard?.writeText(b.closest('[data-url]').dataset.url).then(() => toast('Link copied', 'success', 1400));
  }));
  $('[data-checkall]', root).onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const cards = $$('[data-url]', root);
    cards.forEach((c) => { const d = $('[data-status]', c); d.className = 'status-dot checking'; d.title = 'Checking…'; });
    await checkMany(cards.map((c) => ({ url: c.dataset.url, el: c })), (item, r) => {
      const d = $('[data-status]', item.el); d.className = `status-dot s-${r.status}`; d.title = `${r.label}${r.ms ? ` · ${r.ms}ms` : ''}`;
    });
    btn.disabled = false;
    toast('Check complete — hover a dot for details.', 'success');
  };
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };

function notes(root) {
  const tags = [...new Set(site.patchnotes.flatMap((n) => n.tags || []))];
  let filter = 'all';
  root.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">${icon('notes')} Changelog</span><h1>Patch Notes</h1><p class="muted">Everything new, fixed and changed.</p></div></div>
  <div class="chips" data-chips></div>
  <div class="timeline" data-list></div>`;
  const render = () => {
    $('[data-chips]', root).innerHTML = ['all', ...tags].map((t) => `<button class="chip ${filter === t ? 'active' : ''}" data-t="${esc(t)}">${t === 'all' ? 'All' : esc(t[0].toUpperCase() + t.slice(1))}</button>`).join('');
    $$('[data-t]', root).forEach((b) => (b.onclick = () => { filter = b.dataset.t; render(); }));
    const list = site.patchnotes.filter((n) => filter === 'all' || (n.tags || []).includes(filter));
    $('[data-list]', root).innerHTML = list.map((n) => `
      <article class="tl-item ${n.pinned ? 'pinned' : ''}">
        <div class="tl-dot"></div>
        <div class="card tl-card">
          <header><div class="row gap-sm wrap">${n.version ? `<span class="ver">v${esc(n.version)}</span>` : ''}${(n.tags || []).map(tagBadge).join('')}${n.pinned ? `<span class="badge badge-muted">${icon('pin')}Pinned</span>` : ''}</div>${n.date ? `<time class="muted small">${fmtDate(n.date)}</time>` : ''}</header>
          <h3>${esc(n.title)}</h3>
          <div class="prose">${md(n.body)}</div>
        </div>
      </article>`).join('') || `<div class="empty-state">${icon('notes', 'xl')}<p>No patch notes yet.</p></div>`;
  };
  render();
}

function checker(root) {
  const history = store.get('gg.checks', []);
  root.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">${icon('shieldCheck')} Tool</span><h1>Link Checker</h1><p class="muted">Find out if a site is reachable from the network you're on right now.</p></div></div>
  <div class="split wide-left">
    <div class="stack">
      <div class="card">
        <label class="field"><span>URLs to check <em class="muted">(one per line)</em></span>
          <textarea class="input" rows="4" data-urls placeholder="example.com&#10;https://github.com"></textarea></label>
        <div class="row gap wrap">
          <button class="btn primary" data-go>${icon('shieldCheck')}<span>Check</span></button>
          <button class="btn" data-sitelinks>${icon('link')}<span>Check all site links</span></button>
          <button class="btn ghost" data-clear>Clear results</button>
        </div>
      </div>
      <div class="results" data-results></div>
    </div>
    <aside class="card prose small-prose">
      <h3>How it works</h3>
      <p>The check runs <strong>in your browser</strong>, so it tests your network and filter, not ours.</p>
      <ul>
        <li><span class="status-dot s-ok"></span> <strong>Reachable</strong> — the site responded with its own content.</li>
        <li><span class="status-dot s-partial"></span> <strong>Unverified</strong> — the request went through but we couldn't confirm it wasn't a block page.</li>
        <li><span class="status-dot s-blocked"></span> <strong>Blocked or down</strong> — other sites work, this one doesn't.</li>
      </ul>
      <p class="muted small">Browsers limit what a web page can see about other sites, so treat results as a strong hint, not a guarantee.</p>
    </aside>
  </div>`;
  const results = $('[data-results]', root);
  const row = (r) => `<div class="result r-${r.status}">
    <span class="status-dot s-${r.status}"></span>
    <div class="result-body"><strong>${esc(r.host)}</strong><span class="muted small">${esc(r.label)}${r.ms ? ` · ${r.ms} ms` : ''}</span><p class="small muted">${esc(r.detail)}</p></div>
    ${r.status === 'blocked' ? `<button class="btn sm ghost" data-rep="${esc(r.url)}">${icon('flag')}<span>Report</span></button>` : ''}
    ${r.url && r.status !== 'invalid' ? `<a class="icon-btn sm" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="Open">${icon('external')}</a>` : ''}
  </div>`;
  const bindRep = () => $$('[data-rep]', results).forEach((b) => (b.onclick = () => openReport('Blocked link', `Blocked on my network: ${b.dataset.rep}\n`)));
  const renderHistory = () => { results.innerHTML = history.map(row).join(''); bindRep(); };
  renderHistory();

  async function run(urls) {
    urls = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 40);
    if (!urls.length) return toast('Enter at least one URL.', 'warning');
    const pending = document.createElement('div');
    results.prepend(pending);
    pending.innerHTML = urls.map((u) => `<div class="result r-checking"><span class="status-dot checking"></span><div class="result-body"><strong>${esc(u)}</strong><span class="muted small">Checking…</span></div></div>`).join('');
    const out = [];
    await checkMany(urls, (u, r) => {
      out.push(r);
      const idx = urls.indexOf(u);
      pending.children[idx].outerHTML = row(r);
    });
    pending.replaceWith(...pending.childNodes);
    history.unshift(...out); history.splice(30);
    store.set('gg.checks', history);
    bindRep();
  }
  $('[data-go]', root).onclick = () => run($('[data-urls]', root).value.split(/\n|,/));
  $('[data-sitelinks]', root).onclick = () => run(site.links.map((l) => l.url));
  $('[data-clear]', root).onclick = () => { history.length = 0; store.set('gg.checks', []); results.innerHTML = ''; };
}

function notFound(root) {
  root.innerHTML = `<div class="empty-state card">${icon('compass', 'xl')}<h2>Page not found</h2><p class="muted">That page doesn't exist, or the game was removed.</p><a class="btn primary" href="#/home">Go home</a></div>`;
}

/* ================================================================
   COMMAND PALETTE
   ================================================================ */
function openPalette() {
  if ($('.palette')) return;
  const pages = NAV.flatMap((g) => g.items).map((n) => ({ type: 'Page', title: n.label, icon: n.icon, go: () => (location.hash = '#/' + n.r) }));
  const gameItems = site.games.map((g) => ({ type: 'Game', title: g.title, sub: g.category, icon: 'gamepad', go: () => (location.hash = '#/play/' + encodeURIComponent(g.id)) }));
  const linkItems = site.links.map((l) => ({ type: 'Link', title: l.title, sub: hostOf(l.url), icon: 'link', go: () => window.open(l.url, '_blank', 'noopener') }));
  const all = [...pages, ...gameItems, ...linkItems];
  const el = document.createElement('div');
  el.className = 'modal-backdrop palette-backdrop';
  el.innerHTML = `<div class="palette" role="dialog" aria-label="Search">
    <label class="palette-input">${icon('search')}<input placeholder="Search games, pages, links…" autocomplete="off"/><kbd>esc</kbd></label>
    <div class="palette-list"></div></div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const input = $('input', el), list = $('.palette-list', el);
  let sel = 0, shown = [];
  const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 150); };
  const render = () => {
    const q = input.value.toLowerCase().trim();
    shown = (q ? all.filter((i) => `${i.title} ${i.sub || ''} ${i.type}`.toLowerCase().includes(q)) : [...pages, ...gameItems.slice(0, 5)]).slice(0, 12);
    sel = Math.min(sel, Math.max(shown.length - 1, 0));
    list.innerHTML = shown.length ? shown.map((i, k) => `<button class="pal-item ${k === sel ? 'sel' : ''}" data-k="${k}">${icon(i.icon)}<span>${esc(i.title)}${i.sub ? `<small class="muted">${esc(i.sub)}</small>` : ''}</span><em>${i.type}</em></button>`).join('') : `<p class="muted pal-empty">No results</p>`;
    $$('.pal-item', list).forEach((b) => { b.onclick = () => { shown[+b.dataset.k].go(); close(); }; b.onmousemove = () => { if (sel !== +b.dataset.k) { sel = +b.dataset.k; render(); } }; });
  };
  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    if (e.key === 'Enter' && shown[sel]) { shown[sel].go(); close(); }
    if (e.key === 'Escape') close();
  };
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  render(); input.focus();
}

/* ================================================================
   REPORT
   ================================================================ */
function openReport(type = 'Bug', message = '') {
  const types = ['Broken game', 'Blocked link', 'Bug', 'Game request', 'Suggestion', 'Other'];
  modal({
    title: 'Report a problem',
    body: `<div class="stack">
      <label class="field"><span>Type</span><select class="input select" data-type>${types.map((t) => `<option ${t === type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field"><span>What happened?</span><textarea class="input" rows="5" maxlength="2000" data-msg>${esc(message)}</textarea></label>
      <label class="field"><span>Contact <em class="muted">(optional)</em></span><input class="input" maxlength="200" data-contact placeholder="Name or chat username"/></label>
    </div>`,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Send report', kind: 'primary', icon: 'send', onClick: async (m) => {
        const msg = $('[data-msg]', m).value.trim();
        if (msg.length < 5) { toast('Add a few more details.', 'warning'); return false; }
        try {
          await submitReport({ type: $('[data-type]', m).value, message: msg, contact: $('[data-contact]', m).value.trim() });
          toast('Thanks — the admins will take a look.', 'success');
        } catch (e) { toast(e.message, 'error'); return false; }
      } },
    ],
  });
}

/* ================================================================
   BOOT
   ================================================================ */
async function boot() {
  const cached = getCached();
  if (cached) Object.assign(site, cached);
  renderShell();
  if (cached) { renderAnnouncement(); route(); }
  else $('#view').innerHTML = `<div class="boot">${icon('refresh', 'xl spin')}</div>`;

  try {
    const fresh = await loadSite();
    const changed = JSON.stringify([fresh.games.map((g) => [g.id, g.title, g.logo?.length]), fresh.links, fresh.patchnotes, fresh.settings]) !==
      JSON.stringify([site.games.map((g) => [g.id, g.title, g.logo?.length]), site.links, site.patchnotes, site.settings]);
    Object.assign(site, fresh);
    $('[data-source]').textContent = fresh.source === 'seed' ? 'Static mode' : '';
    renderAnnouncement();
    // Re-render with fresh data, but never interrupt a running game/emulator/chat.
    const r = parseHash().route;
    if (!cached || (changed && !['play', 'emulator', 'chat'].includes(r))) route();
  } catch (e) {
    console.error(e);
    if (!cached) $('#view').innerHTML = `<div class="empty-state card">${icon('wifiOff', 'xl')}<h3>Couldn't load the site</h3><p class="muted">${esc(e.message)}</p></div>`;
  }

  window.addEventListener('hashchange', route);
  if (shouldOnboard(site.settings)) setTimeout(() => openOnboarding(site), 400);
}

boot();
