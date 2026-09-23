/**
 * =====================================================================
 *  GREEN GRASS EMULATOR — backend (Google Apps Script)
 * =====================================================================
 *  Serves HTML files from Google Drive to the Green Grass site.
 *
 *  GET ?id=<driveFileId>            -> JSON { ok, name, size, html }
 *  GET ?id=<driveFileId>&mode=page  -> the HTML itself, embeddable in iframes
 *
 *  DEPLOY (use a PERSONAL Gmail account — school Workspace accounts
 *  usually can't publish to "Anyone"):
 *   1. script.google.com -> New project -> paste this file.
 *   2. Deploy -> New deployment -> type "Web app"
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   3. Authorize, copy the /exec URL.
 *   4. Paste it in Admin -> Settings -> Emulator backend URL.
 *
 *  SAFETY: only files shared "Anyone with the link" (or inside
 *  ALLOWED_FOLDER_ID, if set) are served, so your private Drive files
 *  can never be read through this endpoint.
 * =====================================================================
 */

// Optional: only serve files from this Drive folder (paste its ID). Leave '' to allow any link-shared file.
const ALLOWED_FOLDER_ID = '';
// Max file size to serve (bytes).
const MAX_BYTES = 15 * 1024 * 1024;
// Cache small files for 10 minutes to speed up popular games.
const CACHE_SECONDS = 600;

function doGet(e) {
  const p = (e && e.parameter) || {};
  const id = String(p.id || '').trim();
  const mode = String(p.mode || 'json');

  if (id === 'health') return json_({ ok: false, error: 'health-check', version: 2 });
  if (!/^[\w-]{20,}$/.test(id)) return json_({ ok: false, error: 'Missing or invalid file id.' });

  try {
    const file = loadFile_(id);
    const html = getHtml_(id, file);
    if (mode === 'page') {
      return HtmlService.createHtmlOutput(html)
        .setTitle(file.getName())
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    }
    return json_({ ok: true, name: file.getName(), size: file.getSize(), updated: file.getLastUpdated(), html: html });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function loadFile_(id) {
  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { throw new Error('File not found (check the link and sharing).'); }

  if (ALLOWED_FOLDER_ID) {
    let inFolder = false;
    const parents = file.getParents();
    while (parents.hasNext()) if (parents.next().getId() === ALLOWED_FOLDER_ID) { inFolder = true; break; }
    if (!inFolder) throw new Error('This file is not in the allowed games folder.');
  } else {
    const access = file.getSharingAccess();
    if (access !== DriveApp.Access.ANYONE_WITH_LINK && access !== DriveApp.Access.ANYONE) {
      throw new Error('File is not shared as "Anyone with the link".');
    }
  }

  const name = file.getName().toLowerCase();
  const mime = file.getMimeType();
  const looksHtml = /\.html?$/.test(name) || mime === 'text/html' || mime === 'text/plain';
  if (!looksHtml) throw new Error('Only .html files can be served (got ' + mime + ').');
  if (file.getSize() > MAX_BYTES) throw new Error('File is too large.');
  return file;
}

function getHtml_(id, file) {
  const cache = CacheService.getScriptCache();
  const key = 'f:' + id + ':' + file.getLastUpdated().getTime();
  const hit = cache.get(key);
  if (hit) return hit;
  const html = file.getBlob().getDataAsString('UTF-8');
  if (html.length < 90000) { try { cache.put(key, html, CACHE_SECONDS); } catch (e) {} }
  return html;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
