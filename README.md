# Door Scanner

One scanner for every ticket platform. Tickets sold on Shotgun, DICE, RA, Bucket Listers, Eventbrite, Posh (or anything that exports a CSV) go into one list per event, and door staff scan them all from any phone.

- **Door app** (`/`): phone web app, no app store. Camera scanning on iPhone and Android, handheld/Bluetooth scanners, search by name, keeps working with no signal and syncs when it comes back.
- **Admin** (`/admin`): create events, connect platforms, upload exports, see who's in, export CSVs for co-pro settlements.
- **Server**: Node 22, zero npm dependencies, one SQLite file.

## How each platform gets in

| Platform | How | What you need |
|---|---|---|
| Shotgun | API, pulled every minute | Organizer ID + API token (Smartboard → Settings → Integrations → Shotgun APIs) + the Shotgun event ID |
| DICE | API, pulled every 2 minutes | Ticket holder API token from MIO (company name → Account Settings → Access Tokens). **DICE has to enable the restricted `code` field** on that token. Until then: ask DICE for the barcode export and upload it as a CSV |
| RA | CSV upload | RA Pro → event → Audience Data → Export Audience (keep the default fields). Upload again right before doors |
| Bucket Listers | CSV upload | Ask your partner contact for a CSV of the QR values. If they only send names, upload those as a name-only list (below) |
| Eventbrite | API, pulled every 2 minutes | Private token + event ID |
| Posh | Webhook, plus a CSV before doors | Posh → Settings → API Webhooks → Order Created. Posh has no refund webhook, so upload the attendee CSV before doors |
| Anything else | CSV upload or webhook | One column with the QR value |

API sources also pull again the moment a door scans a code nobody has seen. A DICE ticket activated in line, or a Shotgun ticket transferred a minute ago, gets in on the second scan instead of waiting for the next pull.

**No QR codes from a platform?** Upload whatever list you get (names, emails, quantity) with the QR column set to "not in this file". Each row becomes as many tickets as its quantity. They can't be scanned: door staff search the name and tap Admit, and each ticket still only gets in once. Once you get real codes for those guests, remove the name list, or they count twice.

## Run it on your computer

Needs Node 22.13 or newer.

```bash
cp .env.example .env        # then set ADMIN_PASSWORD in .env
npm start
```

Open http://localhost:3000/admin. The door app is http://localhost:3000/.

Phones only allow the camera on **https**. To try it on a phone before deploying, run `cloudflared tunnel --url http://localhost:3000` and open the https link it prints.

## Put it online (Railway, about $5/month)

1. Push this folder to a private GitHub repo.
2. Railway → New Project → Deploy from GitHub repo. It builds the Dockerfile.
3. Add a **Volume** mounted at `/data` (the guest lists and scans live there).
4. Variables: `ADMIN_PASSWORD` (long), `APP_SECRET` (random, 40+ characters), `DATA_DIR=/data`.
5. Settings → Networking → Generate Domain. Open `https://<your-domain>/admin`.

Any host that runs Docker and keeps a disk works the same way (Render with a disk, Fly.io with a volume, a small VPS behind Caddy).

## Night-of checklist

1. **Day before:** create the event and door PIN, connect every source, check each source's count matches that platform's dashboard.
2. **Test:** buy one ticket per platform (activate the DICE one in the app). In the admin, *Test a code* (or in the door app, More → Test mode) shows what the QR contains and whether it matches.
3. **An hour before doors:** re-upload RA and Bucket Listers exports as "full current list", and the Posh CSV. API sources keep syncing on their own.
4. **At the door:** each phone signs in with the PIN and a name (Door 1, VIP door). Open it once with signal so the list downloads. After that it works offline.
5. **After:** Export → Tickets CSV gives platform, ticket type and checked-in time for every ticket.

## What the door sees

- **ADMIT** (green): valid and first scan.
- **ALREADY SCANNED** (red): shows when and at which door it was first scanned.
- **NOT VALID** (dark red): refunded, resold, transferred or returned, with the reason.
- **NOT FOUND** (orange): not on any list. If the event has API sources, it checks them again on the spot: scan again after 10 seconds, or search by name.

A code imported from two sources still only gets in once. Offline phones decide from their own copy and upload later. If two offline phones let the same ticket in, the admin flags it as a double entry.

## Things to know

- **DICE** creates each QR when the fan activates the ticket in the DICE app, about 2 hours before the event, so DICE codes arrive late. DICE calls it an "animated" QR: before the night, activate one test ticket and check it in Test mode. If what it scans doesn't match, DICE tickets have to go through DICE's own scanner app (DICE Access) or name search. DICE expects promoters to use its own scanner, so get your rep's OK when you ask for the restricted fields. DICE's token terms say not to download personal information, so the app never pulls DICE emails and leaves DICE ticket holders' names out of the CSV exports. Names stay in the app for search at the door.
- **Shotgun** transfers cancel the old QR and issue a new one. The minute-by-minute sync and the re-check on NOT FOUND handle it.
- **RA** has no API, so a ticket bought or resold after your last upload shows NOT FOUND until you upload again. Set RA sales to end at doors, or re-export during the night. Resales cancel the old barcode and issue a new one, which is why the re-export before doors matters. If a screen won't scan, staff can type the 8-digit number printed under an RA QR; check with a test ticket that the export's barcode column holds that same number.
- **Posh** doesn't publish its webhook format. Every webhook is stored; in the admin you point at the QR field once and it re-imports everything received so far.
- **Safety check:** if an automatic sync would void more than 30% of a source's tickets at once, it holds back and asks you to force it. An empty API response an hour before doors is more likely a glitch than a wave of refunds.
- Scans made here don't show up in the platforms' own dashboards. This app is the attendance record.
- **Look:** the Moji design from Claude Design. Archivo and JetBrains Mono load from Google Fonts and are cached on each phone; with no signal it falls back to the bundled Archivo Black for the big type and the phone's own fonts for the rest. The admin shows each event's door PIN, and you can admit a guest from the admin's ticket list.
- Door phones keep names and emails offline. Signing out of the door app deletes them from the phone.

## Settings

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | (required) | Admin sign-in, 8+ characters |
| `APP_SECRET` | generated into `DATA_DIR/app-secret.key` | Encrypts stored platform tokens and signs sessions. Set it on hosts with ephemeral disks |
| `DATA_DIR` | `./data` | Where `door.db` lives |
| `PORT` | `3000` | |
| `SYNC_INTERVAL_SECONDS` | `60` | API pull interval from 36h before an event until 12h after |
| `IDLE_SYNC_INTERVAL_SECONDS` | `1800` | API pull interval outside that window |
| `TRUST_PROXY` | `1` | Read client IP / https from proxy headers (Railway, Render, Fly, Cloudflare) |

## Development

```bash
npm test           # core logic, API, Shotgun/DICE/Eventbrite/Posh connectors (against fake APIs), QR decoder
npm run test:e2e   # real Chrome with a fake camera showing a real QR (needs Chrome, Playwright, python3 + opencv-python)
```

| Path | What |
|---|---|
| `server.js` | Entry point |
| `src/app.js` | HTTP routes: admin, door, webhooks |
| `src/tickets.js` | The unified list: imports, voids, scan decisions, changes for door devices |
| `src/connectors/` | `shotgun.js`, `dice.js`, `eventbrite.js`, `webhook.js` (Posh and others) |
| `src/csv.js` | CSV parsing and column detection |
| `public/index.html`, `public/js/door.js`, `public/js/scanner.js` | Door app |
| `public/admin.html`, `public/js/admin.js` | Admin |
| `public/js/qr-decoder.js` | QR decoder (no library, works offline and on iPhone) |
| `public/js/codes.js` | Code matching, shared by server and phones |
| `scripts/` | Dev tools: QR test image generator, decoder benchmark, fake camera video |
