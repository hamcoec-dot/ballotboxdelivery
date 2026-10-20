# Hamilton County Election Commission — Ballot Box Chain of Custody Mobile Web App

A mobile-first web application designed for Hamilton County Election Commission (HCEC) to log ballot box delivery chains of custody, verify voting machine seal barcodes against an expected manifest CSV, photograph deliveries, and log GPS location timestamps.

Hosted entirely as a static single-page application on **GitHub Pages**, backed by **Firebase (Spark free tier)** for authentication, Firestore database, and photo storage.

---

## 📋 Features

- **Mobile Camera Barcode Scanner:** Reads Code 128, Code 39, QR Code, Data Matrix seals via live camera (`html5-qrcode`).
- **Manifest Barcode Verification:** Scans every seal at a location and verifies it server-side against the imported election. Shows `MATCH`, `INCOMPLETE`, or `MISMATCH`.
- **Delivery Photograph Capture:** Integrates with native camera to capture and upload proof-of-delivery photos.
- **GPS Timestamp Logging:** Automatically captures precise geolocation coordinates upon delivery submit.
- **Offline Mode & Persistence:** Operates seamlessly offline via Service Worker caching and Firestore offline persistence.
- **Audit Log & CSV Export:** Admin view to inspect historical deliveries, filter mismatch alerts, and download CSV reports.
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

Seal numbers are **never** stored in the repo or sent to drivers' browsers. Each election an admin imports the two election-office exports in the app:

1. Sign in as an admin, open **Import Election Data**.
2. Choose the machine data export and the precincts/polling places export (saved CSVs, unchanged).
3. **Preview** (check location and seal counts and any warnings), then **Publish**. The imported election becomes the active one.

How it works:
- Machines join to precincts on `CPN` = `CountyPrecinctNum` (fallback: precinct name). Rows with an empty `Ballot box lid SN` are skipped.
- A delivery stop is one physical building; all seals of every precinct in it are scanned in one delivery.
- The `precincts` export has unquoted commas in its address fields; it is parsed positionally, so do not hand-edit it.
- Only the columns needed are stored. The expected seal numbers live in `elections/{id}/expected/*`, which no client can read.
- Drivers' scans are checked by the `verifySeal` Cloud Function (match or no match only; 15 wrong attempts per location locks that driver out until an admin deletes their `rate_limits` doc).
- `submitDelivery` computes the status: `MATCH` (all seals verified), `INCOMPLETE` (some missing), `MISMATCH` (unexpected seal scanned).
- Offline: scans show as pending and submissions queue on the device, then verify and sync when back online.

Do not commit export files (`*.csv` is git-ignored).

### Editing or deleting an audit record (Admin)

In the audit log, each record for the **active election** has **Edit** and **Delete**:
- **Edit** lets an admin change the location, the scanned seal codes, notes and the status (or override it). Seal results are recomputed on the server. A status override stays until you pick **Auto**. Codes an admin adds are tagged as admin-added. A reason is required.
- **Delete** is a soft delete (reason required): the record leaves the list and the CSV export and appears under **Deleted records**, where it can be restored.
- Every edit, delete and restore is kept in `deliveries/{id}/revisions` (who, when, why, before and after). Driver name, submission time, election, photo and GPS cannot be changed.
- Records from past elections and older single-seal records are read-only except notes and delete/restore (legacy records) or not at all (past elections).
- Two admins editing the same record: the second save is rejected ("changed by someone else"), reload and retry.

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
