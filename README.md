# Hamilton County Election Commission — Ballot Box Chain of Custody Mobile Web App

A web application designed for Hamilton County Election Commission (HCEC) to log ballot box delivery chains of custody, verify voting machine seal barcodes against an expected manifest CSV, photograph deliveries, and log GPS location timestamps. The driver side is mobile-first (drivers use phones in the field); the admin side (audit log, import, edit history, export) is used from desktop PCs.

Hosted entirely as a static single-page application on **GitHub Pages**, backed by **Firebase (Blaze pay-as-you-go plan)** for authentication, Firestore database, photo storage, and Cloud Functions. Blaze is required because the app uses Cloud Functions.

---

## 📋 Features

- **Mobile Camera Barcode Scanner:** Reads Code 128 seals via live camera using the native `BarcodeDetector` (Android Chrome) or a vendored zxing-cpp WASM polyfill (iPhone, `vendor/barcode-detector/`, works offline). Torch, zoom, tap-to-refocus and a camera picker where the phone supports them. Add `?scandebug` to the URL for an engine/fps/timing overlay; `?wasm` forces the polyfill.
- **Manifest Barcode Verification:** Scans every seal at a location and verifies it server-side against the imported election. Shows `MATCH`, `INCOMPLETE`, or `MISMATCH`.
- **Delivery Photograph Capture:** Integrates with native camera to capture and upload proof-of-delivery photos.
- **GPS Timestamp Logging:** Automatically captures precise geolocation coordinates upon delivery submit.
- **Offline Mode & Persistence:** Operates seamlessly offline via Service Worker caching and Firestore offline persistence.
- **Truck Loadout List:** per-day (or hand-picked) list of every stop's ballot boxes, machines and supplies, with trip totals, so drivers load without opening each stop.
- **Admin Delivery Monitoring Dashboard (desktop):** Live progress by day, stops not yet delivered, seal and supply problems, duplicate submissions, driver activity, the seal-check trail and driver lockouts, with search, filters, a detail panel (photo, GPS, notes, change history) and filter-aware CSV export.
- **HTML Design Playbook Compliant:** Built to strict HCEC rules (WCAG 2.1 AA, fluid flexbox, no `<form>` tags, ASCII entities, high contrast).

---

## 🛠️ Setup Instructions

### 1. Firebase Project Setup

The application is linked to Firebase project **`ballotboxdelivery`**:

1. Open [Firebase Console](https://console.firebase.google.com/project/ballotboxdelivery).
2. **Authentication:**
   - Go to **Build -> Authentication -> Sign-in method**.
   - Enable **Email/Password**.
    - Go to **Users -> Add User**:
     - Create delivery driver accounts (e.g. `driver@yourdomain.gov`)
     - Create admin account `elections@govotehamiltontn.gov`
     - Delete the retired `admin@hcec.local` user if present
   - Under **Settings -> User actions**, disable **Enable create (sign-up)** (recommended).
3. **Firestore Database:**
   - Go to **Build -> Firestore Database -> Rules**.
   - Paste the contents of [`firestore.rules`](firestore.rules) and click **Publish**.
4. **Storage:**
   - Go to **Build -> Storage -> Rules**.
   - Paste the contents of [`storage.rules`](storage.rules) and click **Publish**.
5. **First admin:** follow **Managing Admins** below for `elections@govotehamiltontn.gov`.

6. **Web App Credentials:**
   - Go to **Project Settings -> General -> Your apps**.
   - Copy the web app configuration into `firebase-config.js` if updating API keys.

---

### Scanning tips for drivers
- Hold the phone 15-25 cm away, barcode level inside the box. Tap the video to refocus.
- Dark: turn on the Light button (Android). Glare: tilt the seal so the light does not bounce into the lens.
- Still not locking on: **Scan from Photo** uses the phone's own camera (flash and autofocus), or type the number. The photo can be at any angle; get close enough that the seal fills a good part of the picture. Reading takes up to a few seconds while it tries turned and zoomed-in views.
- Test sheet with fake seals: `tools/test-seals.html`.

## 🔑 Managing Admins

Admins are an allowlist of Firebase Auth UIDs in the Firestore `admins` collection. Client writes are blocked; manage only via Firebase Console.

**Add:** Auth -> Users -> copy the user's UID -> Firestore -> `admins` collection -> Add document, Document ID = UID, fields `email` (string, for readability) and `added` (timestamp).

**Remove:** delete the `admins/{uid}` document.

---

## 🚀 GitHub Pages Deployment

1. Commit and push repository to GitHub.
2. In GitHub repository settings, navigate to **Pages**.
3. Set source branch to `main` (or `master`) and folder to `/ (root)`.
4. Save. GitHub Pages will build and deploy over HTTPS.

---

## 📄 Importing an Election (Admin)

Seal numbers are **never** stored in the repo or sent to drivers' browsers. Each election an admin imports **three** election-office exports in the app:

| Export | Gives the app |
|---|---|
| Machine data (e.g. `November26MachineData.csv`) | Election name and date, one seal per machine (`Ballot box lid SN`, kept server-side only) |
| Precincts and polling places (e.g. `2611 Nov 26 Precincts and polling places.csv`) | Building name and address per precinct |
| Delivery schedule (e.g. `Ballot Box Delivery Schedule 2611 Nov 26.csv`) | Delivery order (day and stop), the supplies each stop gets, and the facility contacts |

1. Sign in as an admin, open **Import Election Data**.
2. Choose all three files (saved CSVs, unchanged). The schedule is required because it sets the delivery order.
3. **Preview** (check location and seal counts, stops per day, supply totals and any warnings), then **Publish**. The imported election becomes the active one.

How it works:
- Machines join to precincts on `CPN` = `CountyPrecinctNum` (fallback: precinct name). Rows with an empty `Ballot box lid SN` are skipped.
- A delivery stop is one physical building; all seals of every precinct in it are scanned in one delivery.
- The schedule joins on its `Precinct` column = the machine export's `Polling Place` (uppercased). `Day` is `day.stop` (e.g. `1.01`, `3.30`) and the file's row order is the route. A building with several schedule rows (for example two precincts sharing a church) appears once, at its first stop, with the supplies summed and the contacts combined.
- Supply columns are every column between `Ballot Boxes` and `Adjust Row Hight in Points`, so new supply columns work without code changes. A blank cell means 0. The preview warns when the totals row, ballot-box counts or matches look wrong.
- Drivers see stops grouped by day in route order, a supplies checklist (Delivered, or the quantity actually delivered), and the facility contacts. Delivery status for supplies is stored separately (`COMPLETE` or `SHORT`) from the seal status.
- **Contacts are readable by any signed-in user**, including notes such as door codes. That is the same audience as the printed schedule.
- The `precincts` export has unquoted commas in its address fields; it is parsed positionally, so do not hand-edit it.
- Only the columns needed are stored. The expected seal numbers live in `elections/{id}/expected/*`, which no client can read.
- Drivers' scans are checked by the `verifySeal` Cloud Function (match or no match only; 15 wrong attempts per location locks that driver out until an admin resets it from the dashboard's lockout banner or the Seal checks tab).
- `submitDelivery` computes the status: `MATCH` (all seals verified), `INCOMPLETE` (some missing), `MISMATCH` (unexpected seal scanned).
- Offline: scans show as pending and submissions queue on the device, then verify and sync when back online.

Do not commit export files (`*.csv` is git-ignored).

### Truck Loadout List (Drivers)

From the stop list, **Truck Loadout List** shows every stop with what goes on the truck for it: ballot boxes and the machines (precinct, machine number, serial) plus each supply quantity from the delivery schedule. Filter by **All days** or a day, tick **On truck** for the stops in this trip (from any day, or **Add next 5 stops** in route order), and the trip totals add up what to load. **On truck** shows only the picked stops. **Start Delivery** opens the normal delivery screen and comes back to the list after recording.

- Picks and delivered marks are kept on the phone only (works offline). A stop is marked delivered when a delivery is recorded or queued on that phone, or by **Mark delivered** (which records nothing).
- Drivers cannot read delivery records, so stops another driver delivered do not show as delivered.

### Delivery Monitoring dashboard (Admin)

Admins land on the dashboard after signing in. It is built for a desktop browser (full width, sticky table headers); drivers never download it (`admin.js` loads only after the admin check).

- **Tiles and Progress by day:** stops delivered out of the schedule, stops not delivered yet, seal problems (`MISMATCH`/`INCOMPLETE`), supplies `SHORT`, stops submitted more than once, and admin-edited records. A stop's status is its newest non-deleted record. Click a tile or a day to filter the table.
- **Tabs:** *Stops* (one row per scheduled stop, including ones with no record), *Submissions* (every record), *Drivers*, *Seal checks* (every `verifySeal` attempt; misses only by default), *Deleted*, *Past elections* (loaded on demand, read only).
- **Search and filters** apply to the current tab. **Export CSV** exports exactly what the current tab shows. The custody export includes the record ID, Eastern local time, GPS and a map link, and the photo path. Cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so Excel does not run them as formulas.
- **Detail panel:** click any row for the stop's address, contacts, each record's seals (expected vs scanned, unexpected seals and where they belong), supplies, notes, GPS map link, photo, change history and seal checks at that location.
- **Driver lockouts:** a red banner lists drivers locked out at a location (15 wrong seal attempts). **Reset** deletes the counter so they can try again; the misses stay in the seal-check trail.
- Live data covers the active election only. If no election is active the dashboard shows every record.

### Editing or deleting an audit record (Admin)

In the detail panel, each record for the **active election** has **Edit** and **Delete**:
- **Edit** lets an admin change the location, the scanned seal codes, notes and the status (or override it). Seal results are recomputed on the server. A status override stays until you pick **Auto**. Codes an admin adds are tagged as admin-added. A reason is required.
- **Delete** is a soft delete (reason required): the record leaves the list and the CSV export and appears under the **Deleted** tab, where it can be restored.
- Every edit, delete and restore is kept in `deliveries/{id}/revisions` (who, when, why, before and after). Driver name, submission time, election, photo and GPS cannot be changed.
- Records from past elections and older single-seal records are read-only except notes and delete/restore (legacy records) or not at all (past elections).
- Two admins editing the same record: the second save is rejected ("changed by someone else"), reload and retry.

### Clearing test data before an election (Admin)

Practise with the real election files, then clear the practice run before real deliveries start. In the admin page open **Clear Test Data**, pick the election, click **Check what will be removed**, enter a reason and type the election ID shown (for example `2026-11`), then click **Clear test data**.

- **Removed for that election only:** delivery records (with their change history), seal checks, driver lockout counters and delivery photos.
- **Kept:** the imported stop list and expected seals (drivers can start real deliveries straight away, no re-import needed), other elections, admins, logins, functions and rules.
- **Backup first:** everything removed is copied to Firebase Storage under `backups/test-data/{election}/{time}/` (`records.json` plus the photos). No app user can read that folder; restoring needs a developer.
- **Not allowed on or after election day** (Eastern time), so real records cannot be cleared.
- **Phones:** a practice delivery still waiting in a phone's offline queue is turned away when it syncs (its scans are older than the clear) and kept in `test_data_clears/{election}/late` instead of the records. The phone drops it from its queue.
- Every clear is logged in `test_data_clears/{election}/runs` (who, when, why, counts) and listed under **Earlier clears**.

---

## ☁️ Cloud Functions

Source in `functions/` (Node 22, 2nd gen, `us-east1`). Requires the Blaze plan.

```bash
cd functions && npm install && npm test        # unit tests (synthetic data only)
firebase deploy --only functions,firestore:rules
```

Local emulators (check that ports 8181, 9099, 9199, 5001 are free first):

```bash
firebase emulators:start --only auth,firestore,functions,storage --project ballotboxdelivery
```

Then open `http://127.0.0.1:8123/?emulator` (any static server).
