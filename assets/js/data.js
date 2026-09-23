/* Data layer: Firestore when configured, otherwise data/seed.json.
   Results are cached in localStorage so the site paints instantly and
   still works if Firestore is unreachable. */
import { CONFIG } from './config.js';
import { getFB } from './fb.js';
import { store } from './ui.js';

const CACHE_KEY = 'gg.cache.v1';
let seedPromise = null;

export function loadSeed() {
  seedPromise ||= fetch('data/seed.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ settings: {}, games: [], links: [], patchnotes: [] }));
  return seedPromise;
}

export function mergeSettings(s = {}) {
  return { ...CONFIG.defaults, chatChannels: [], methodMarkdown: '', announcement: { enabled: false }, ...s };
}

const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.title).localeCompare(String(b.title));

export function getCached() {
  const c = store.get(CACHE_KEY);
  return c ? { ...c, settings: mergeSettings(c.settings) } : null;
}

/* Public site data. */
export async function loadSite() {
  const seed = await loadSeed();
  const fb = await getFB();
  let data;
  if (!fb) {
    data = { settings: seed.settings, games: seed.games, links: seed.links, patchnotes: seed.patchnotes, source: 'seed' };
  } else {
    const { db, fs } = fb;
    try {
      const [settingsSnap, gamesSnap, linksSnap, notesSnap] = await Promise.all([
        fs.getDoc(fs.doc(db, 'settings', 'site')),
        fs.getDocs(fs.query(fs.collection(db, 'games'), fs.where('hidden', '==', false))),
        fs.getDocs(fs.collection(db, 'links')),
        fs.getDocs(fs.collection(db, 'patchnotes')),
      ]);
      const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const games = list(gamesSnap), links = list(linksSnap), notes = list(notesSnap);
      data = {
        settings: settingsSnap.exists() ? settingsSnap.data() : seed.settings,
        // Empty collections fall back to seed so a fresh project isn't blank.
        games: games.length || settingsSnap.exists() ? games : seed.games,
        links: links.length || settingsSnap.exists() ? links : seed.links,
        patchnotes: notes.length || settingsSnap.exists() ? notes : seed.patchnotes,
        source: 'firestore',
      };
    } catch (err) {
      console.warn('[GG] Firestore read failed, using cache/seed.', err);
      const c = getCached();
      data = c || { settings: seed.settings, games: seed.games, links: seed.links, patchnotes: seed.patchnotes, source: 'seed' };
    }
  }
  data.games = (data.games || []).filter((g) => !g.hidden).sort(byOrder);
  data.links = (data.links || []).sort(byOrder);
  data.patchnotes = (data.patchnotes || []).sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  store.set(CACHE_KEY, { settings: data.settings, games: data.games.map(stripHeavy), links: data.links, patchnotes: data.patchnotes, at: Date.now() });
  data.settings = mergeSettings(data.settings);
  return data;
}

// Don't cache big data-URL logos into localStorage.
function stripHeavy(g) {
  if (g.logo && g.logo.startsWith('data:') && g.logo.length > 60000) return { ...g, logo: '' };
  return g;
}

/* Single game (used by play.html) */
export async function loadGame(id) {
  const fb = await getFB();
  if (fb) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'games', id));
      if (snap.exists()) return { id: snap.id, ...snap.data() };
    } catch {}
  }
  const seed = await loadSeed();
  return seed.games.find((g) => g.id === id) || getCached()?.games.find((g) => g.id === id) || null;
}

/* Uploaded HTML files are stored in chunks: gameFiles/{id}/chunks/{n} */
export async function loadGameHtml(id) {
  const fb = await getFB();
  if (!fb) throw new Error('This game is stored in the database, but Firebase is not configured.');
  const { db, fs } = fb;
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'gameFiles', id, 'chunks'), fs.orderBy('i')));
  if (snap.empty) throw new Error('Game file not found.');
  return snap.docs.map((d) => d.data().d).join('');
}

export async function bumpPlays(id) {
  const fb = await getFB();
  if (!fb) return;
  try { await fb.fs.updateDoc(fb.fs.doc(fb.db, 'games', id), { plays: fb.fs.increment(1) }); } catch {}
}

export async function submitReport({ type, message, contact = '', page = location.hash }) {
  const fb = await getFB();
  if (!fb) throw new Error('Reports need Firebase to be configured.');
  const { db, fs } = fb;
  await fs.addDoc(fs.collection(db, 'reports'), {
    type: String(type).slice(0, 40),
    message: String(message).slice(0, 2000),
    contact: String(contact).slice(0, 200),
    page: String(page).slice(0, 200),
    ua: navigator.userAgent.slice(0, 300),
    status: 'open',
    createdAt: fs.serverTimestamp(),
  });
}

/* Favorites + recents (local) */
export const favs = {
  all: () => store.get('gg.favs', []),
  has: (id) => favs.all().includes(id),
  toggle(id) { const f = favs.all(); const i = f.indexOf(id); i >= 0 ? f.splice(i, 1) : f.unshift(id); store.set('gg.favs', f); return i < 0; },
};
export const recents = {
  all: () => store.get('gg.recents', []),
  push(id) { const r = recents.all().filter((x) => x !== id); r.unshift(id); store.set('gg.recents', r.slice(0, 12)); },
};
