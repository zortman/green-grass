# Green Grass

The official Green Grass site: a game library, a built-in HTML emulator, live chat, patch notes, the Method guide, unblocked and useful links, a link block checker, and an admin dashboard.

It's a static site with no build step. It runs on **GitHub Pages**, and **Firebase** (free tier) provides sign-in, the database and chat.

---

## Features

| | |
|---|---|
| **Game library** | Search, categories, favorites, recently played, play counts, featured games, a logo for each game |
| **Game player** | Plays uploaded HTML, Google Drive or web-URL games through the emulator. Fullscreen, pop-out (`play.html?id=`), download and report buttons |
| **Green Grass Emulator** | Runs any HTML file from your device, pasted code, a URL or a Drive link in a secure sandbox, with a console, working saves (localStorage shim) and a local library |
| **Live chat** | Channels, Google sign-in (guests optional), admin badges, pinned messages, locked channels, bans, a server-enforced 2-second rate limit |
| **Patch notes** | Markdown timeline with tags, versions and pinned notes |
| **The Method** | Guide page you can edit from the dashboard |
| **Links** | Unblocked static sites, useful sites and tools, with a one-click "check all from my network" |
| **Link Checker** | Tests from the visitor's network whether a site is reachable or looks blocked |
| **Onboarding** | First-visit tour with accent and theme picker |
| **Extras** | Command palette (`/` or `Ctrl K`), dark/light themes, 5 accent colors, announcement banner, report-a-problem form, mobile layout |
| **Admin dashboard** | `/admin.html`. Admin codes (owner), overview and health checks, games (upload HTML plus a logo, reorder, feature/hide, test play), links, patch notes, chat moderation, reports inbox, site settings, backup and restore |

Admin access: **one owner account** (set by email) plus anyone the owner gives an **admin code**. The owner generates codes in the dashboard, each code works for one person, and deleting a code removes that person's access instantly. The Firestore security rules enforce all of this on the server, so it can't be bypassed from the browser.

---

## Quick start

1. **Create the repo.** On GitHub, create a new repository (e.g. `green-grass`). Upload the contents of this folder, or push it:
   ```bash
   git init
   git add .
   git commit -m "Green Grass site"
   git branch -M main
   git remote add origin https://github.com/<you>/green-grass.git
   git push -u origin main
   ```
2. **Turn on Pages.** Repo → *Settings → Pages → Source: **GitHub Actions***. The included workflow deploys on every push to `main`. Your site will be at `https://<you>.github.io/green-grass/`.
3. **Set up Firebase and your owner email.** Follow **[SETUP.md](SETUP.md)** (about 10 minutes).

The site works right away in **static mode**: it reads `data/seed.json`, and games, links, patch notes and the emulator all work. Chat and the admin dashboard turn on once Firebase is configured.

---

## Where to edit things

| What | Where |
|---|---|
| Owner email | `assets/js/config.js` → `OWNER_EMAIL` **and** `firestore.rules` → `isOwner()` |
| Other admins | Admin dashboard → **Admin codes** (owner only) |
| Firebase keys | `assets/js/config.js` → `firebase` |
| Games, logos, links, patch notes, Method text, banner, chat channels | `/admin.html` |
| Starter data (static mode / first import) | `data/seed.json` |
| Logo files (optional) | `assets/logos/<game-id>.png` |
| Colors and design | `assets/css/app.css` (tokens at the top) |
| Emulator backend | `apps-script/GGEmulator.gs` |

## Project structure

```
index.html            Main site (hash-routed SPA)
play.html             Standalone full-window player (play.html?id=<game>)
admin.html            Admin dashboard
assets/css/           app.css (design system), admin.css
assets/js/
  config.js           ← your settings
  app.js              router + pages
  emulator.js         emulator page
  runner.js           sandbox engine (storage shim, console bridge)
  player.js           game loading (HTML / Drive / URL)
  chat.js             realtime chat
  linkcheck.js        link block checker
  onboarding.js       welcome tour
  admin.js            dashboard
  access.js           owner + admin-code checks
  data.js, fb.js, ui.js
data/seed.json        starter content from the Green Grass doc
apps-script/          Green Grass Emulator backend for Google Drive
firestore.rules       database security rules (owner email + admin codes)
.github/workflows/    GitHub Pages deploy
```

## Local preview

Any static server works (ES modules don't load from `file://`):

```bash
python -m http.server 8080
```

Then open http://localhost:8080.
