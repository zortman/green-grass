/* Firebase loader. Loaded lazily so the site still works (static mode)
   if Firebase isn't configured or gstatic.com is unreachable. */
import { CONFIG, isFirebaseConfigured } from './config.js';

const V = '10.12.2';
const BASE = `https://www.gstatic.com/firebasejs/${V}`;
let promise = null;

export function getFB() {
  if (!isFirebaseConfigured()) return Promise.resolve(null);
  if (promise) return promise;
  promise = (async () => {
    try {
      const [appMod, fs, au] = await Promise.all([
        import(`${BASE}/firebase-app.js`),
        import(`${BASE}/firebase-firestore.js`),
        import(`${BASE}/firebase-auth.js`),
      ]);
      const app = appMod.initializeApp(CONFIG.firebase);
      const db = fs.getFirestore(app);
      const auth = au.getAuth(app);
      return { app, db, auth, fs, au };
    } catch (err) {
      console.warn('[GG] Firebase failed to load — static mode.', err);
      return null;
    }
  })();
  return promise;
}

/* Auth helpers ------------------------------------------------------ */
export async function signInGoogle() {
  const fb = await getFB();
  if (!fb) throw new Error('Firebase is not configured.');
  const provider = new fb.au.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await fb.au.signInWithPopup(fb.auth, provider);
  } catch (err) {
    // Popups blocked (common on managed devices) -> fall back to redirect.
    if (err && /popup/i.test(err.code || '')) return fb.au.signInWithRedirect(fb.auth, provider);
    throw err;
  }
}

export async function signInGuest() {
  const fb = await getFB();
  if (!fb) throw new Error('Firebase is not configured.');
  return fb.au.signInAnonymously(fb.auth);
}

export async function signOut() {
  const fb = await getFB();
  if (fb) await fb.au.signOut(fb.auth);
}

export async function onUser(cb) {
  const fb = await getFB();
  if (!fb) { cb(null); return () => {}; }
  return fb.au.onAuthStateChanged(fb.auth, cb);
}
