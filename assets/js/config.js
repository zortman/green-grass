/* =====================================================================
   GREEN GRASS — SITE CONFIG
   This is the ONLY file you need to edit to get the site running.
   Everything else (games, links, patch notes, method text, chat
   channels, announcement banner) is managed from /admin.html.
   ===================================================================== */

export const CONFIG = {
  siteName: 'Green Grass',
  tagline: 'Games, tools and a community — all in one place.',

  /* ---------------------------------------------------------------
     OWNER
     The only account that can create and delete admin codes.
     Other admins get access by redeeming a code (Admin -> Admin codes).
     IMPORTANT: must match isOwner() in firestore.rules. Lowercase.
     --------------------------------------------------------------- */
  OWNER_EMAIL: 'zortmanaidan@gmail.com',

  /* ---------------------------------------------------------------
     FIREBASE
     Firebase console -> Project settings -> Your apps -> Web app.
     Paste the config object here. Leave apiKey empty to run the site
     in "static mode" (reads data/seed.json, chat + admin disabled).
     --------------------------------------------------------------- */
  firebase: {
    apiKey: 'AIzaSyC6PRDrPFWAkUzv3qO2GrSCzerzvn8bFb8',
    authDomain: 'green-grass-43043.firebaseapp.com',
    projectId: 'green-grass-43043',
    storageBucket: 'green-grass-43043.firebasestorage.app',
    messagingSenderId: '206641525930',
    appId: '1:206641525930:web:221c6024fdb209e3cb8cd3',
    measurementId: 'G-LMQ3M9MRB3',
  },

  /* ---------------------------------------------------------------
     DEFAULTS (can be overridden in Admin -> Settings)
     --------------------------------------------------------------- */
  defaults: {
    // Your own Green Grass Emulator backend (apps-script/GGEmulator.gs).
    // Deploy it, then paste the /exec URL here or in Admin -> Settings.
    emulatorApi: '',
    // Optional: a Google API key with the Drive API enabled.
    // Lets the emulator load public Drive HTML files without Apps Script.
    driveApiKey: '',
    // The old emulator ("definitely not an emulator") — used only as a
    // fallback "open in new tab" button when a Drive game can't load.
    legacyEmulatorUrl:
      'https://script.google.com/a/aguafria.org/macros/s/AKfycbyecH5nhbFchaR0XQ6Ahbr2YZI6nK0fsH1FoGegADY2Lw8VtRCzj8EYLdU7Wsq6GUeU/exec',
    // The old chatroom (C-App) — shown as a link on the chat page.
    legacyChatUrl:
      'https://script.google.com/macros/s/AKfycbzc9b7dPi7n3q_vJuR-3JbcnBA9LCoRH7EOIPZlEkLWcNlPYkgpP6I2aAEJ9tYHk-Smtg/exec',
    // Allow chatting without a Google account (Firebase Anonymous auth).
    chatGuests: false,
    onboardingEnabled: true,
  },
};

export const isFirebaseConfigured = () =>
  !!(CONFIG.firebase.apiKey && CONFIG.firebase.projectId);

export const isOwnerEmail = (email) =>
  !!email && String(email).toLowerCase().trim() === CONFIG.OWNER_EMAIL.toLowerCase().trim();
