/* Green Grass Chat — realtime chat on Firestore.
   channels/{cid}                 { pinned, locked }        (admin writes)
   channels/{cid}/messages/{id}   { uid, name, text, admin, createdAt }
   chatUsers/{uid}                { name, lastPost }        (rate limit)
   bans/{uid}                     { name, reason, at }      (admin writes) */
import { getFB, signInGoogle, signInGuest, signOut, onUser } from './fb.js';
import { isAdminEmail } from './config.js';
import { $, $$, esc, icon, monogram, timeAgo, toast, modal, confirmDialog, store } from './ui.js';

const MAX_LEN = 500;
const COOLDOWN = 2500;

function linkify(text, myName) {
  let s = esc(text);
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/(^|\s)@([\w-]{2,32})/g, (m, pre, n) =>
    `${pre}<span class="mention ${myName && n.toLowerCase() === myName.toLowerCase().replace(/\s+/g, '') ? 'me' : ''}">@${n}</span>`);
  return s;
}

export async function mountChat(root, site) {
  const s = site.settings;
  const channels = (s.chatChannels?.length ? s.chatChannels : [{ id: 'general', name: 'general', topic: '' }]);
  const fb = await getFB();

  const legacy = s.legacyChatUrl
    ? `<a class="side-link" href="${esc(s.legacyChatUrl)}" target="_blank" rel="noopener">${icon('external')}<span>Legacy C-App (beta)</span></a>`
    : '';

  if (!fb) {
    root.innerHTML = `<div class="empty-state card">
      ${icon('chat', 'xl')}
      <h3>Chat isn't set up yet</h3>
      <p class="muted">Live chat runs on Firebase. Once an admin adds the Firebase config (see SETUP.md), chat turns on automatically.</p>
      ${s.legacyChatUrl ? `<a class="btn" href="${esc(s.legacyChatUrl)}" target="_blank" rel="noopener">${icon('external')}<span>Open the legacy C-App</span></a>` : ''}
    </div>`;
    return () => {};
  }

  const { db, fs } = fb;
  let current = store.get('gg.chat.channel', channels[0].id);
  if (!channels.find((c) => c.id === current)) current = channels[0].id;
  let user = null, admin = false, banned = false, myName = '';
  let unsubMsgs = null, unsubChan = null, unsubAuth = null;
  let lastSend = 0;

  root.innerHTML = `
  <div class="chat">
    <aside class="chat-side">
      <div class="chat-side-head"><span class="eyebrow">Channels</span></div>
      <nav class="chat-channels"></nav>
      <div class="chat-side-foot">${legacy}<div class="chat-me"></div></div>
    </aside>
    <section class="chat-main">
      <header class="chat-head">
        <button class="icon-btn chat-toggle" aria-label="Channels">${icon('hash')}</button>
        <div class="chat-title"><h3></h3><p class="muted small"></p></div>
        <span class="chat-status"></span>
      </header>
      <div class="chat-pinned" hidden></div>
      <div class="chat-log" aria-live="polite"><div class="chat-loading">${icon('refresh', 'spin')} Loading messages</div></div>
      <button class="chat-jump" hidden>${icon('chevronDown')} New messages</button>
      <div class="chat-compose"></div>
    </section>
  </div>`;

  const nav = $('.chat-channels', root);
  const log = $('.chat-log', root);
  const compose = $('.chat-compose', root);
  const pinnedEl = $('.chat-pinned', root);
  const jump = $('.chat-jump', root);
  const chatEl = $('.chat', root);

  $('.chat-toggle', root).onclick = () => chatEl.classList.toggle('side-open');

  function renderNav() {
    nav.innerHTML = channels.map((c) => `<button class="chan ${c.id === current ? 'active' : ''}" data-c="${esc(c.id)}">${icon('hash')}<span>${esc(c.name)}</span></button>`).join('');
    $$('.chan', nav).forEach((b) => (b.onclick = () => { switchChannel(b.dataset.c); chatEl.classList.remove('side-open'); }));
  }

  function renderMe() {
    const el = $('.chat-me', root);
    if (!user) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="me-card">
      ${user.photoURL ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer"/>` : monogram(myName || 'Guest', 'sm')}
      <div class="me-meta"><strong>${esc(myName || 'Guest')}</strong><span class="muted small">${admin ? 'Admin' : user.isAnonymous ? 'Guest' : 'Member'}</span></div>
      <button class="icon-btn" data-rename title="Change display name">${icon('edit')}</button>
      <button class="icon-btn" data-out title="Sign out">${icon('logout')}</button>
    </div>`;
    $('[data-out]', el).onclick = () => signOut();
    $('[data-rename]', el).onclick = rename;
  }

  function renderCompose(locked) {
    if (!user) {
      compose.innerHTML = `<div class="compose-gate">
        <p class="muted">Sign in to join the conversation.</p>
        <div class="row gap">
          <button class="btn primary" data-google>${icon('user')}<span>Sign in with Google</span></button>
          ${s.chatGuests ? `<button class="btn ghost" data-guest>Continue as guest</button>` : ''}
        </div></div>`;
      $('[data-google]', compose).onclick = () => signInGoogle().catch((e) => toast(e.message, 'error'));
      $('[data-guest]', compose)?.addEventListener('click', () => signInGuest().catch((e) => toast(e.message, 'error')));
      return;
    }
    if (banned) { compose.innerHTML = `<div class="compose-gate"><p class="danger-text">${icon('ban')} You've been banned from chat.</p></div>`; return; }
    if (locked && !admin) { compose.innerHTML = `<div class="compose-gate"><p class="muted">${icon('lock')} This channel is locked by an admin.</p></div>`; return; }
    compose.innerHTML = `<form class="compose">
      <textarea rows="1" maxlength="${MAX_LEN}" placeholder="Message #${esc(channels.find((c) => c.id === current)?.name || current)}"></textarea>
      <span class="compose-count muted small"></span>
      <button class="btn primary icon-only" type="submit" aria-label="Send">${icon('send')}</button>
    </form>`;
    const form = $('form', compose);
    const ta = $('textarea', compose);
    const count = $('.compose-count', compose);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; count.textContent = ta.value.length > MAX_LEN - 80 ? `${MAX_LEN - ta.value.length}` : ''; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      if (Date.now() - lastSend < COOLDOWN) { toast('Slow down a little.', 'warning'); return; }
      if (!myName) { const ok = await rename(); if (!ok) return; }
      lastSend = Date.now();
      ta.value = ''; grow();
      try {
        const batch = fs.writeBatch(db);
        batch.set(fs.doc(db, 'chatUsers', user.uid), { name: myName, lastPost: fs.serverTimestamp() }, { merge: true });
        batch.set(fs.doc(fs.collection(db, 'channels', current, 'messages')), {
          uid: user.uid, name: myName, text: text.slice(0, MAX_LEN), admin, createdAt: fs.serverTimestamp(),
        });
        await batch.commit();
      } catch (err) {
        ta.value = text; grow();
        toast(/permission/i.test(err.message) ? 'Message not sent — you may be sending too fast, banned, or the channel is locked.' : err.message, 'error', 5000);
      }
    };
    ta.focus();
  }

  async function rename() {
    return new Promise((resolve) => {
      const m = modal({
        title: 'Display name',
        body: `<label class="field"><span>Shown next to your messages</span><input class="input" maxlength="32" value="${esc(myName)}" placeholder="e.g. grasshopper"/></label>`,
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: () => resolve(false) },
          { label: 'Save', kind: 'primary', onClick: async (el) => {
            const v = $('input', el).value.replace(/\s+/g, ' ').trim().slice(0, 32);
            if (v.length < 2) { toast('Pick a name with at least 2 characters.', 'warning'); return false; }
            try {
              await fs.setDoc(fs.doc(db, 'chatUsers', user.uid), { name: v }, { merge: true });
              myName = v; store.set('gg.chat.name', v); renderMe(); resolve(true);
            } catch (err) { toast(err.message, 'error'); return false; }
          } },
        ],
      });
      setTimeout(() => $('input', m.el)?.focus(), 50);
    });
  }

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 120; }
  log.addEventListener('scroll', () => { if (nearBottom()) jump.hidden = true; });
  jump.onclick = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; };

  function renderMessages(docs) {
    const stick = nearBottom() || !log.dataset.ready;
    const msgs = docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
    if (!msgs.length) {
      log.innerHTML = `<div class="chat-empty">${icon('chat', 'xl')}<p>No messages yet. Say hi.</p></div>`;
      log.dataset.ready = '1';
      return;
    }
    let html = '', prev = null;
    for (const m of msgs) {
      const t = m.createdAt?.toDate ? m.createdAt.toDate() : null;
      const grouped = prev && prev.uid === m.uid && t && prev.t && t - prev.t < 5 * 60 * 1000;
      const canDelete = admin || (user && m.uid === user.uid);
      const tools = `<div class="msg-tools">
        ${admin ? `<button class="icon-btn sm" data-pin="${m.id}" title="Pin">${icon('pin')}</button>` : ''}
        ${admin && m.uid !== user?.uid ? `<button class="icon-btn sm" data-ban="${m.uid}" data-name="${esc(m.name)}" title="Ban user">${icon('ban')}</button>` : ''}
        ${canDelete ? `<button class="icon-btn sm" data-del="${m.id}" title="Delete">${icon('trash')}</button>` : ''}
      </div>`;
      html += `<div class="msg ${grouped ? 'grouped' : ''} ${user && m.uid === user.uid ? 'mine' : ''}" data-id="${m.id}">
        ${grouped ? `<span class="msg-time-gutter">${t ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>` : monogram(m.name, 'sm')}
        <div class="msg-body">
          ${grouped ? '' : `<div class="msg-meta"><strong>${esc(m.name)}</strong>${m.admin ? `<span class="badge badge-accent">${icon('shield')}Admin</span>` : ''}<span class="muted small">${t ? timeAgo(t) : 'sending…'}</span></div>`}
          <div class="msg-text">${linkify(m.text, myName)}</div>
        </div>
        ${canDelete || admin ? tools : ''}
      </div>`;
      prev = { uid: m.uid, t };
    }
    log.innerHTML = html;
    log.dataset.ready = '1';
    if (stick) log.scrollTop = log.scrollHeight; else jump.hidden = false;

    $$('[data-del]', log).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('Delete this message?', { okLabel: 'Delete', danger: true }))) return;
      try { await fs.deleteDoc(fs.doc(db, 'channels', current, 'messages', b.dataset.del)); } catch (e) { toast(e.message, 'error'); }
    }));
    $$('[data-ban]', log).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(`Ban ${b.dataset.name} from chat? You can unban them in the admin dashboard.`, { okLabel: 'Ban', danger: true }))) return;
      try {
        await fs.setDoc(fs.doc(db, 'bans', b.dataset.ban), { name: b.dataset.name, by: user.email || '', at: fs.serverTimestamp() });
        toast(`${b.dataset.name} was banned.`, 'success');
      } catch (e) { toast(e.message, 'error'); }
    }));
    $$('[data-pin]', log).forEach((b) => (b.onclick = async () => {
      const m = msgs.find((x) => x.id === b.dataset.pin);
      try { await fs.setDoc(fs.doc(db, 'channels', current), { pinned: { text: m.text, name: m.name, at: fs.serverTimestamp() } }, { merge: true }); toast('Pinned.', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }));
  }

  function switchChannel(cid) {
    current = cid;
    store.set('gg.chat.channel', cid);
    renderNav();
    const ch = channels.find((c) => c.id === cid) || { name: cid };
    $('.chat-title h3', root).innerHTML = `${icon('hash')}${esc(ch.name)}`;
    $('.chat-title p', root).textContent = ch.topic || '';
    log.dataset.ready = '';
    log.innerHTML = `<div class="chat-loading">${icon('refresh', 'spin')} Loading messages</div>`;
    unsubMsgs?.(); unsubChan?.();
    const q = fs.query(fs.collection(db, 'channels', cid, 'messages'), fs.orderBy('createdAt', 'desc'), fs.limit(100));
    unsubMsgs = fs.onSnapshot(q, (snap) => renderMessages(snap.docs), (err) => {
      log.innerHTML = `<div class="chat-empty">${icon('alert', 'xl')}<p>Couldn't load messages.</p><p class="muted small">${esc(err.message)}</p></div>`;
    });
    unsubChan = fs.onSnapshot(fs.doc(db, 'channels', cid), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      if (d.pinned?.text) {
        pinnedEl.hidden = false;
        pinnedEl.innerHTML = `${icon('pin')}<div><strong>${esc(d.pinned.name)}</strong> <span>${linkify(d.pinned.text)}</span></div>${admin ? `<button class="icon-btn sm" title="Unpin">${icon('x')}</button>` : ''}`;
        $('button', pinnedEl)?.addEventListener('click', () => fs.setDoc(fs.doc(db, 'channels', cid), { pinned: null }, { merge: true }).catch((e) => toast(e.message, 'error')));
      } else pinnedEl.hidden = true;
      $('.chat-status', root).innerHTML = d.locked ? `<span class="badge">${icon('lock')}Locked</span>` : '';
      renderCompose(!!d.locked);
    }, () => renderCompose(false));
  }

  unsubAuth = await onUser(async (u) => {
    user = u;
    admin = !!(u && !u.isAnonymous && u.emailVerified && isAdminEmail(u.email));
    banned = false;
    myName = '';
    if (u) {
      try { banned = (await fs.getDoc(fs.doc(db, 'bans', u.uid))).exists(); } catch {}
      try {
        const me = await fs.getDoc(fs.doc(db, 'chatUsers', u.uid));
        myName = me.exists() ? me.data().name : '';
      } catch {}
      myName ||= store.get('gg.chat.name', '') || (u.displayName || '').slice(0, 32);
    }
    renderMe();
    switchChannel(current);
  });

  renderNav();

  return () => { unsubMsgs?.(); unsubChan?.(); unsubAuth?.(); };
}
