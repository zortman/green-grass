# Green Grass: full setup

About 10–15 minutes. You need a GitHub account and a Google account. **Use a personal Gmail for Firebase and Apps Script.** School Workspace accounts usually block creating Firebase projects and publishing scripts to "Anyone".

---

## 1. Put the site on GitHub Pages

1. Create a new GitHub repository and upload everything in this folder (keep the folder structure, including `.github/` and `.nojekyll`).
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open the **Actions** tab and wait for "Deploy to GitHub Pages" to go green. Your URL is shown there, e.g. `https://yourname.github.io/green-grass/`.

The site is now live in static mode.

---

## 2. Create the Firebase project

1. Go to https://console.firebase.google.com → **Create a project** (Analytics is optional; you can turn it off).
2. **Build → Authentication → Get started → Sign-in method**
   - Enable **Google**.
   - *(Optional)* Enable **Anonymous** if you want guests to chat without a Google account (then turn on "Allow guests" in Admin → Settings).
   - **Settings → Authorized domains → Add domain:** `yourname.github.io`
3. **Build → Firestore Database → Create database**. Pick a location close to you, then choose **production mode**.
4. **Project settings** (gear icon) → **Your apps → Web (`</>`)** → register an app (no hosting needed) → copy the `firebaseConfig` values.

---

## 3. Set your 2 admin emails (two places)

**a) `assets/js/config.js`**

```js
ADMIN_EMAILS: [
  'you@gmail.com',
  'your-co-admin@gmail.com',
],
firebase: {
  apiKey: 'AIza…',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '…',
  appId: '…',
},
```

**b) `firestore.rules`**, inside `isAdmin()`:

```
&& request.auth.token.get('email', '').lower() in [
  'you@gmail.com',
  'your-co-admin@gmail.com'
];
```

Then in the Firebase console → **Firestore Database → Rules**, paste the whole contents of `firestore.rules` and click **Publish**.

> The rules are what actually protect your data. `config.js` only decides what the page shows. Someone could edit `config.js` in their own browser, but they still couldn't write anything without matching the rules.

> The Firebase `apiKey` is safe to commit. It only identifies your project; the rules control access.

Commit and push. After the deploy finishes, open `https://yourname.github.io/green-grass/admin.html` and sign in with one of your admin accounts.

---

## 4. First run in the dashboard

1. **Overview → Import starter data.** This loads your 7 games, links, patch notes and Method text from `data/seed.json`.
2. **Overview → System health** should show all green except possibly the emulator backend (step 5).
3. **Games → Edit** each game and drop in its logo.

### Adding a new game
**Games → Add game**:
- **Upload HTML**: drop the `.html` file. It's stored in the database (chunked) and runs through the emulator. Best for single-file games up to 8 MB.
- **Google Drive**: paste the share link. The file must be shared as *Anyone with the link*. Needs step 5.
- **Web URL**: any page that allows embedding.

Add a logo (drag an image; it's auto-cropped to 256×256), a category and a description, then click **Test play** and **Add game**.

---

## 5. Deploy your own emulator backend (for Google Drive games)

Your old emulator links only work for accounts on your school's domain and can't be embedded in a page. `apps-script/GGEmulator.gs` replaces them with an endpoint the site can call from anywhere:

1. Go to https://script.google.com → **New project** (with your **personal** Gmail).
2. Replace `Code.gs` with the contents of `apps-script/GGEmulator.gs`. Name the project "GG Emulator".
3. *(Optional but recommended)* Put all your game `.html` files in one Drive folder and paste its ID into `ALLOWED_FOLDER_ID`.
4. **Deploy → New deployment → ⚙ → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Authorize (choose *Advanced → Go to GG Emulator* if Google warns you), then copy the **Web app URL** (ends in `/exec`).
6. **Admin → Settings → Emulator → Emulator backend URL** → paste it → **Save settings**.
7. Click **Test backend with a Drive link** and paste one of your game links.

The backend only serves files that are shared "Anyone with the link" (or that sit in your allowed folder), so your private Drive files can't be read through it.

**Alternative:** create a Google Cloud API key with the **Google Drive API** enabled and paste it into *Drive API key*. It does the same job without Apps Script.

> Drive games you already have: the files must be owned by or shared with an account the backend can read. If they live in your school Drive, re-upload them to your personal Drive (or into the allowed folder) and update each game's Drive link.

---

## 6. Chat

It works as soon as Firebase is set up. Channels (`general`, `games`, `help`) are managed in **Admin → Chat**.

- Admins get a badge. Hover any message to **delete**, **pin** or **ban**.
- **Lock** a channel so only admins can post.
- Rate limit: 1 message every 2 seconds per user, enforced by the rules.
- Bans are by account, and you can undo them in Admin → Chat.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `auth/unauthorized-domain` when signing in | Add your `*.github.io` domain in Firebase → Authentication → Settings → Authorized domains |
| "Access denied" on admin | The signed-in email isn't in `ADMIN_EMAILS` (check for typos and use lowercase) |
| Health check: "Write denied" | Your emails aren't in `firestore.rules`, or you didn't click **Publish** |
| Drive game: "No Drive backend configured" | Do step 5 |
| Drive game: "not shared as Anyone with the link" | Drive → Share → General access → *Anyone with the link* |
| Chat: "Message not sent" | Sending too fast, banned, or the channel is locked |
| Site still shows old content | Hard refresh (Ctrl+Shift+R). The site caches data locally for instant loads |
| Sign-in popup blocked | The site falls back to a redirect automatically. Allow popups for a smoother flow |

## Costs

Everything here fits in the free tiers: GitHub Pages, the Firebase Spark plan (50k reads/day, 20k writes/day) and Apps Script. Firebase Storage is **not** used (it now requires a paid plan). Logos and uploaded games are stored in Firestore.
