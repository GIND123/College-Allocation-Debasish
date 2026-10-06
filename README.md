# RankRound

PG medical counselling cut-off predictor for Odisha. It covers state counselling (CMR) and the All India Quota (NEET AIR), with:

- mobile-number OTP sign-in
- a shortlist builder
- an admin console with traffic analytics, leads, and data uploads

The 2025 Odisha data from the original `odisha_1.html` is loaded automatically on first start.

## Run it

Requires Node.js 22.13 or newer. No database server is needed: data lives in a single SQLite file.

```bash
npm install
cp .env.example .env      # then edit ADMIN_PASSWORD
npm start                 # http://localhost:3000
```

- Public site: `http://localhost:3000`
- Admin console: `http://localhost:3000/admin`. Use the password set in `ADMIN_PASSWORD`.
- While `AUTH_PROVIDER=mock` (the default), every mobile number signs in with code **1234** and no SMS is sent.

## What's where

| Path | Purpose |
|---|---|
| `server/index.js` | HTTP routes: public API, admin API, pages |
| `server/auth.js` | OTP sign-in (mock + Firebase), sessions, admin login, rate limits |
| `server/analytics.js` | First-party event tracking and the dashboard queries |
| `server/schema.js` | Upload columns, header aliases, validation, allotment → cut-off aggregation |
| `server/db.js` | SQLite schema, settings, first-run seed |
| `server/seed/` | The 2025 data extracted from the client's original page |
| `public/` | Public app (`index.html`, `js/app.js`) and admin console (`admin.html`, `js/admin.js`) |

## Switching on real OTP (Firebase, by Google)

Firebase Authentication phone sign-in sends the SMS and handles reCAPTCHA. Because Google sends from its own sender IDs, there is no Indian DLT registration to do. The server checks each Firebase ID token against Google's public keys, so no service-account file is required.

1. Create a project at console.firebase.google.com. Phone sign-in needs the **Blaze** (pay-as-you-go) plan. Check the Firebase pricing page for current per-SMS rates in India.
2. Go to Authentication → Sign-in method and enable **Phone**. Under Settings → SMS region policy, allow India.
3. Go to Authentication → Settings → Authorized domains and add the production domain.
4. Go to Project settings → Your apps, add a **Web app**, and copy its config.
5. Set these on the server and restart:
   ```
   AUTH_PROVIDER=firebase
   FIREBASE_API_KEY=...
   FIREBASE_AUTH_DOMAIN=...
   FIREBASE_PROJECT_ID=...
   FIREBASE_APP_ID=...
   ```

The sign-in screen switches to 6-digit codes automatically. To use another SMS provider later (MSG91, Twilio Verify and so on), replace the body of `requestOtp` in `server/auth.js` so it sends the code. Nothing else changes.

## Adding data without a developer

Go to Admin → Datasets → **Upload data**. CSV and Excel files are accepted, and a template can be downloaded from the upload dialog. There are two file layouts:

- **Cut-off summary:** one row per college × speciality × category, with opening and closing ranks.
- **Allotment list:** one row per admitted candidate, straight from the counselling result. The server groups these into seats and works out the opening rank, closing rank, seat count and rounds.

Each upload is validated, and you see a preview before anything is saved. Messy headers ("Institute", "State Merit Rank", "Quota", …) and stream spellings ("in service", "IS") are recognised automatically.

Every published dataset appears on the site, newest year first. Individual rows can be corrected in the row editor.

## Analytics

All analytics are first-party; there are no third-party scripts. The browser posts small events to `/api/events`. Bots are filtered out, and days are bucketed in IST.

The dashboard shows:
- visitors and page views
- sign-ups and the sign-in funnel
- predictions run, and which ranks were searched
- speciality and college interest
- traffic sources, devices and pages

**Leads** lists every verified mobile with their last search, shortlist and activity timeline, and exports to CSV.

## Deploying

- Set `NODE_ENV=production`. This enables `Secure` cookies, which need HTTPS.
- Set a long random `ADMIN_PASSWORD`.
- Set `AUTH_PROVIDER=firebase` before going live. The server logs a warning while mock mode is on in production.
- Point `DB_PATH` at a **persistent disk**. On Render, Railway or Fly, attach a volume, otherwise data is lost on redeploy. Back up that one file.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limits see real client IPs.
