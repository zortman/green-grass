/* Game player — shared by the in-site player (#/play/<id>) and play.html */
import { mountRunner, fetchDriveHtml, normalizeUrl } from './runner.js';
import { loadGameHtml, bumpPlays, recents } from './data.js';
import { $, esc, icon, downloadText, slugify } from './ui.js';

export const SOURCE_LABEL = { file: 'HTML', html: 'HTML', drive: 'Drive', url: 'Web' };

/* Fetch an HTML file hosted with the site (e.g. games/ghorde1.html). */
async function fetchSiteFile(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Game file not found (${path}).`);
  return r.text();
}

/* Resolve a game's HTML from whichever source it uses. */
async function loadHtml(g, settings) {
  if (g.source === 'file') return fetchSiteFile(g.file || `games/${g.id}.html`);
  if (g.source === 'html') return loadGameHtml(g.id);
  // Drive games: prefer a copy hosted on the site, so no backend is needed.
  try { return await fetchSiteFile(`games/${g.id}.html`); } catch {}
  return (await fetchDriveHtml(g.driveId, settings)).html;
}

export function driveViewUrl(id) { return `https://drive.google.com/file/d/${id}/view`; }
export function legacyUrl(settings, g) {
  return settings.legacyEmulatorUrl && g.driveId ? `${settings.legacyEmulatorUrl}?id=${encodeURIComponent(g.driveId)}` : '';
}

/**
 * Loads a game into `stage`. Returns { runner, html } or null on failure
 * (in which case a helpful fallback card is rendered in the stage).
 */
export async function playGame(stage, g, settings, { onConsole } = {}) {
  stage.innerHTML = `<div class="stage-empty"><div class="stage-empty-icon">${icon('refresh', 'xl spin')}</div><h3>Loading ${esc(g.title)}…</h3></div>`;
  recents.push(g.id);
  bumpPlays(g.id);
  try {
    if (g.source === 'url') {
      const runner = mountRunner(stage, { src: normalizeUrl(g.url), title: g.title, onConsole });
      return { runner, html: null };
    }
    const html = await loadHtml(g, settings);
    const runner = mountRunner(stage, { html, isolation: 'strict', storageKey: 'game-' + g.id, title: g.title, onConsole });
    return { runner, html };
  } catch (err) {
    const legacy = legacyUrl(settings, g);
    stage.innerHTML = `<div class="stage-empty">
      <div class="stage-empty-icon danger">${icon('alert', 'xl')}</div>
      <h3>This game couldn't load here</h3>
      <p class="muted">${esc(err.message)}</p>
      <div class="row gap wrap center">
        ${legacy ? `<a class="btn primary" href="${esc(legacy)}" target="_blank" rel="noopener">${icon('external')}<span>Open with legacy emulator</span></a>` : ''}
        ${g.driveId ? `<a class="btn" href="${esc(driveViewUrl(g.driveId))}" target="_blank" rel="noopener">${icon('download')}<span>Get the file</span></a>` : ''}
      </div>
    </div>`;
    return null;
  }
}

export function downloadGame(g, html) {
  if (html) downloadText(`${slugify(g.title)}.html`, html);
  else if (g.driveId) window.open(driveViewUrl(g.driveId), '_blank', 'noopener');
}
