/* First-visit onboarding tour. */
import { $, $$, icon, esc, store, ACCENTS, setAccent, setTheme, LOGO_SVG } from './ui.js';

export function shouldOnboard(settings) {
  return settings.onboardingEnabled !== false && !store.get('gg.onboarded', false);
}

export function openOnboarding(site) {
  const s = site.settings;
  const steps = [
    {
      art: `<div class="ob-hero">${LOGO_SVG}</div>`,
      title: `Welcome to ${esc(site.siteName)}`,
      body: `<p>Games, tools and a community — all in one place. This quick tour takes about 20 seconds.</p>`,
    },
    {
      art: `<div class="ob-grid">
        ${[['gamepad', 'Games', `${site.games.length} titles, one click to play`], ['cpu', 'Emulator', 'Run any HTML file safely'], ['chat', 'Chat', 'Live channels with the community'], ['shieldCheck', 'Link Checker', 'See what loads on your network']]
          .map(([i, t, d]) => `<div class="ob-tile">${icon(i)}<strong>${t}</strong><span>${d}</span></div>`).join('')}
      </div>`,
      title: 'Everything in one place',
      body: `<p>Browse the game library, open your own files in the emulator, read the Method guide, and find unblocked links — all from the sidebar.</p>`,
    },
    {
      art: `<div class="ob-accents">${ACCENTS.map((a) => `<button class="swatch" data-accent="${a.id}" style="--c:${a.c}" aria-label="${a.name}"><span></span><em>${a.name}</em></button>`).join('')}</div>
        <div class="seg ob-theme"><button data-theme="dark">${icon('moon')}Dark</button><button data-theme="light">${icon('sun')}Light</button></div>`,
      title: 'Make it yours',
      body: `<p>Pick an accent and theme. You can change these any time from the sidebar.</p>`,
    },
    {
      art: `<div class="ob-rules">
        ${[['users', 'Be decent in chat. Admins can remove messages and ban accounts.'], ['flag', 'Something broken? Use Report on any game or page.'], ['keyboard', 'Press / or Ctrl K anywhere to search.']]
          .map(([i, t]) => `<div class="ob-rule">${icon(i)}<span>${t}</span></div>`).join('')}
      </div>`,
      title: 'A few ground rules',
      body: `<p>That's it — you're ready.</p>`,
    },
  ];

  let i = 0;
  const el = document.createElement('div');
  el.className = 'modal-backdrop ob';
  el.innerHTML = `<div class="modal ob-modal" role="dialog" aria-modal="true" aria-label="Welcome tour">
    <button class="icon-btn ob-skip" aria-label="Skip">${icon('x')}</button>
    <div class="ob-stage"></div>
    <footer class="ob-foot">
      <div class="ob-dots">${steps.map(() => '<span></span>').join('')}</div>
      <div class="row gap"><button class="btn ghost" data-back>Back</button><button class="btn primary" data-next>Next</button></div>
    </footer>
  </div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  const finish = () => {
    store.set('gg.onboarded', true);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 220);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') finish();
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') back();
  };
  document.addEventListener('keydown', onKey);

  function render() {
    const st = steps[i];
    $('.ob-stage', el).innerHTML = `<div class="ob-step">${st.art}<h2>${st.title}</h2>${st.body}</div>`;
    $$('.ob-dots span', el).forEach((d, k) => d.classList.toggle('on', k === i));
    $('[data-back]', el).style.visibility = i === 0 ? 'hidden' : 'visible';
    $('[data-next]', el).textContent = i === steps.length - 1 ? 'Get started' : 'Next';
    const acc = store.get('gg.accent', 'meadow'), th = store.get('gg.theme', 'dark');
    $$('[data-accent]', el).forEach((b) => { b.classList.toggle('active', b.dataset.accent === acc); b.onclick = () => { setAccent(b.dataset.accent); render(); }; });
    $$('[data-theme]', el).forEach((b) => { b.classList.toggle('active', b.dataset.theme === th); b.onclick = () => { setTheme(b.dataset.theme); render(); }; });
  }
  const next = () => { if (i < steps.length - 1) { i++; render(); } else finish(); };
  const back = () => { if (i > 0) { i--; render(); } };
  $('[data-next]', el).onclick = next;
  $('[data-back]', el).onclick = back;
  $('.ob-skip', el).onclick = finish;
  render();
}
