# RankRound

PG medical counselling cut-off predictor. It covers state counselling (CMR) and the All India Quota (NEET AIR), with:

- a sign-up page that opens the site: name, mobile or email (one-time code), NEET-PG CMR and state
- cut-off data shown per state: each candidate sees only the state they chose
- a shortlist builder
- plain-language NEET-PG 2026 counselling guides for the All India Quota and each state, with live dates
- an admin console with traffic analytics, leads, and data uploads

The 2025 Odisha data from the original `odisha_1.html` is loaded automatically on first start.

## Run it

Requires Node.js 22.13 or newer. No database server is needed: data lives in a single SQLite file.

```bash
npm install
cp .env.example .env      # then edit ADMIN_PASSWORD
npm start                 # http://localhost:3000
npm test                  # unit and API tests on a throw-away database
```

- Public site: `http://localhost:3000`
- Admin console: `http://localhost:3000/admin`. Use the password set in `ADMIN_PASSWORD`.
- While `AUTH_PROVIDER=mock` (the default), every mobile number and email signs in with code **1234** and nothing is sent.

## What's where

| Path | Purpose |
|---|---|
| `server/index.js` | HTTP routes: public API, admin API, pages |
| `server/auth.js` | Sign-up profile, OTP sign-in (mock, Firebase SMS, email codes), sessions, admin login, rate limits |
| `server/states.js` | The states and UTs offered at sign-up; every dataset is tagged with one |
| `server/analytics.js` | First-party event tracking and the dashboard queries |
| `server/schema.js` | Upload columns, header aliases, validation, allotment → cut-off aggregation |
| `server/db.js` | SQLite schema, settings, first-run seed |
| `server/seed/` | The 2025 data extracted from the client's original page |
| `server/guides.js` | Serves each counselling guide at `/counselling/<guide>` inside the RankRound frame |
| `guides/` | The counselling guides as the client sent them, `guides.json` (the list, with key dates), and `assets/` (notice scans and PDFs) |
| `public/` | Public app (`index.html`, `js/app.js`), admin console (`admin.html`, `js/admin.js`), and the guide frame (`css/guide.css`, `js/guide.js`) |
| `test/` | `npm test`: unit tests for the guide frame, API tests against a real server |

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

The sign-in screen switches to 6-digit codes automatically. Only `apiKey`, `authDomain`, `projectId` and `appId` from the Firebase config are used; nothing needs to be installed (`npm install firebase` and `firebase-admin` are not needed), because the browser loads the Firebase SDK from Google's CDN and the server verifies tokens itself. Moving to another Firebase project later means changing only these four values: accounts are keyed by mobile number, so nobody loses their account.

Testing on your own machine:
- Firebase often rejects the reCAPTCHA check on `localhost` with `invalid-app-credential`. Open the site at `http://127.0.0.1:3000` instead, and add `127.0.0.1` to Authorized domains.
- To test without paying for SMS, add a number under Authentication → Sign-in method → Phone → Phone numbers for testing. It must be an Indian number (for example `+91 9999999999` with code `123456`), because the site accepts Indian mobiles only.

To use another SMS provider later (MSG91, Twilio Verify and so on), replace the body of `requestOtp` in `server/auth.js` so it sends the code. Nothing else changes.

## Email codes

Candidates can get their one-time code by email instead of SMS. In mock mode this works with code 1234. For real emails the server uses [Brevo](https://www.brevo.com) (free tier: 300 emails a day):

1. Create a Brevo account and verify a sender address (Senders & IPs → Senders).
2. Create an API key (SMTP & API → API keys).
3. Set these on the server and restart:
   ```
   BREVO_API_KEY=...
   EMAIL_FROM=no-reply@your-domain.in
   ```

Without these, and with `AUTH_PROVIDER=firebase`, the sign-up form offers mobile only.

## Sign-up and states

The home page opens with the sign-up form. Every candidate gives their name, a mobile number or email, their NEET-PG CMR and their state. The CMR is pre-filled into the predictor. The state decides which datasets they see: a candidate who chose Karnataka sees only datasets tagged Karnataka, and gets a "coming soon" page until one is published. Candidates can change their state, CMR or name from the account menu (Edit profile).

Accounts created before sign-up asked for CMR and state are asked to complete their profile the next time they open the predictor.

## Counselling guides

`/counselling` lists every guide with its key dates (open, closing soon, closed), a "closing in the next 3 days" strip and a state search. A signed-in student sees their own state first, and the predictor and cut-off pages link to their state's guide (and to the MCC guide for the All India Quota).

Each guide is a stand-alone HTML file in `guides/`, kept exactly as the client sent it, and served at `/counselling/<slug>`. As it is served, the page gets:

- RankRound's top bar, a guide bar (back to all guides, the other guides for the same state, the notice date, the official site) and footer;
- RankRound's fonts and background, card, text and border colours, and the site's light/dark switch. Each guide keeps its own accent and status colours, which often carry meaning;
- page tracking, so guide visits show under Pages in the admin overview.

No iframes are involved, so each guide scrolls, searches and jumps between sections the way its author built it.

**To update a guide**, replace its file in `guides/` with the new version. **To add one**, put the file in `guides/` and add an entry to `guides/guides.json`:

```jsonc
{
  "slug": "punjab",                       // the address: /counselling/punjab
  "file": "punjab.html",
  "region": "Punjab",                     // a state name from server/states.js, or "All India"
  "title": "Punjab PG medical counselling 2026",
  "label": "State counselling guide",     // link text; tells guides for the same state apart
  "authority": "BFUHS · State quota",
  "summary": "One line about what the guide covers.",
  "asOf": "2026-10-20",                   // date of the notice it is based on
  "official": "https://bfuhs.ac.in",
  "dates": [
    { "what": "Online application", "when": "21 Oct, 10 am – 28 Oct, 5 pm", "from": "2026-10-21T10:00:00+05:30", "to": "2026-10-28T17:00:00+05:30" },
    { "what": "Merit list", "when": "30 Oct", "on": "2026-10-30T00:00:00+05:30" },
    { "what": "Round 1", "when": "To be announced", "label": "Awaited" }
  ]
}
```

(The comments above are for explanation only; JSON files can't contain them.) A date step is a window (`from`/`to`; `from` is optional), a single day (`on`), or a fixed status (`label`: `Awaited`, `Published` or `Reference`). Times are Indian Standard Time. The server checks `guides.json` when it starts and refuses to run with a clear message if an entry is wrong, for example a misspelt state or a missing file.

Big files a guide links to (scanned notices, PDFs) belong in `guides/assets/` and are linked as `/counselling/assets/<file>`, rather than embedded in the page.

## Adding data without a developer

Go to Admin → Datasets → **Upload data**. CSV and Excel files are accepted, and a template can be downloaded from the upload dialog. There are two file layouts:

- **Cut-off summary:** one row per college × speciality × category, with opening and closing ranks.
- **Allotment list:** one row per admitted candidate, straight from the counselling result. The server groups these into seats and works out the opening rank, closing rank, seat count and rounds.

Each upload is validated, and you see a preview before anything is saved. Messy headers ("Institute", "State Merit Rank", "Quota", …) and stream spellings ("in service", "IS") are recognised automatically.

Every dataset is tagged with a state when it is uploaded. A published dataset is shown to candidates who chose that state, newest year first. The state can be changed later under the dataset's details. Individual rows can be corrected in the row editor.

## Analytics

All analytics are first-party; there are no third-party scripts. The browser posts small events to `/api/events`. Bots are filtered out, and days are bucketed in IST.

The dashboard shows:
- visitors and page views
- sign-ups and the sign-in funnel
- predictions run, and which ranks were searched
- speciality and college interest
- traffic sources, devices and pages

**Leads** lists everyone who verified a mobile or email, with their state, NEET-PG CMR, last search, shortlist and activity timeline, and exports to CSV. The overview also shows sign-ups by state and by contact type (mobile or email).

## Deploying

- Set `NODE_ENV=production`. This enables `Secure` cookies, which need HTTPS.
- Set a long random `ADMIN_PASSWORD`.
- Set `AUTH_PROVIDER=firebase` before going live. The server logs a warning while mock mode is on in production.
- Point `DB_PATH` at a **persistent disk**. On Render, Railway or Fly, attach a volume, otherwise data is lost on redeploy. Back up that one file.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limits see real client IPs.
- JavaScript and CSS are served with `Cache-Control: no-cache`, so every visitor gets the newly deployed version on their next page load. Unchanged files cost a quick 304.
