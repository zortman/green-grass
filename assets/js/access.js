/* Admin access: one owner (by email) + anyone holding a live admin code.
   Mirrors isOwner()/isAdmin() in firestore.rules — keep them in sync. */
import { isOwnerEmail } from './config.js';

export const isOwner = (u) => !!(u && !u.isAnonymous && u.emailVerified && isOwnerEmail(u.email));

/**
 * Returns { admin, owner, code, stale }
 *  stale = the user redeemed a code that has since been deleted.
 */
export async function adminStatus(fb, u) {
  if (!u) return { admin: false, owner: false };
  if (isOwner(u)) return { admin: true, owner: true };
  const { db, fs } = fb;
  try {
    const me = await fs.getDoc(fs.doc(db, 'admins', u.uid));
    if (!me.exists()) return { admin: false, owner: false };
    const code = me.data().code;
    try {
      const c = await fs.getDoc(fs.doc(db, 'adminCodes', code));
      if (c.exists() && c.data().redeemedBy === u.uid) return { admin: true, owner: false, code };
    } catch {}
    return { admin: false, owner: false, stale: true };
  } catch {
    return { admin: false, owner: false };
  }
}

/* Redeem a code for the signed-in user (single use, bound to their account). */
export async function redeemCode(fb, u, raw) {
  const { db, fs } = fb;
  const code = normalizeCode(raw);
  if (!code) throw new Error('That doesn’t look like an admin code.');
  // Clear a leftover record from a revoked code first.
  try {
    const old = await fs.getDoc(fs.doc(db, 'admins', u.uid));
    if (old.exists()) await fs.deleteDoc(fs.doc(db, 'admins', u.uid));
  } catch {}
  const name = (u.displayName || (u.isAnonymous ? 'Guest admin' : '') || '').slice(0, 64);
  const email = (u.email || '').slice(0, 200);
  const batch = fs.writeBatch(db);
  batch.set(fs.doc(db, 'admins', u.uid), { code, name, email, at: fs.serverTimestamp() });
  batch.update(fs.doc(db, 'adminCodes', code), { redeemedBy: u.uid, redeemedName: name, redeemedEmail: email, redeemedAt: fs.serverTimestamp() });
  try {
    await batch.commit();
  } catch {
    throw new Error('Invalid, revoked, or already-used code.');
  }
  return code;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b % 32]).join('');
  return `GG-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function normalizeCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith('GG') ? s.slice(2) : s;
  if (!/^[A-Z0-9]{12}$/.test(body)) return null;
  return `GG-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}
