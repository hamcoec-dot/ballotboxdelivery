# Hamilton County Election Commission — Ballot Box Chain of Custody Mobile Web App

A mobile-first web application designed for Hamilton County Election Commission (HCEC) to log ballot box delivery chains of custody, verify voting machine seal barcodes against an expected manifest CSV, photograph deliveries, and log GPS location timestamps.

Hosted entirely as a static single-page application on **GitHub Pages**, backed by **Firebase (Spark free tier)** for authentication, Firestore database, and photo storage.

---

## 📋 Features

- **Mobile Camera Barcode Scanner:** Reads Code 128, Code 39, QR Code, Data Matrix seals via live camera (`html5-qrcode`).
- **Manifest Barcode Verification:** Auto-verifies scanned barcode against known-good manifest in `polling_places.csv`. Shows green `MATCH` or red warning `MISMATCH`.
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
     - Create driver account (e.g. `driver@hcec.local`)
     - Create admin account (e.g. `admin@hcec.local`)
3. **Firestore Database:**
   - Go to **Build -> Firestore Database -> Rules**.
   - Paste the following security rules and click **Publish**:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /deliveries/{deliveryId} {
      allow create: if request.auth != null;
      allow read: if request.auth != null;
      allow update, delete: if request.auth.token.email == 'admin@hcec.local';
    }
  }
}
```

4. **Storage:**
   - Go to **Build -> Storage -> Rules**.
   - Paste the following security rules and click **Publish**:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /photos/{userId}/{fileName} {
      allow write: if request.auth != null
                   && request.auth.uid == userId
                   && request.resource.size < 10 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
      allow read: if request.auth != null;
    }
  }
}
```

5. **Web App Credentials:**
   - Go to **Project Settings -> General -> Your apps**.
   - Copy the web app configuration into `firebase-config.js` if updating API keys.

---

## 🚀 GitHub Pages Deployment

1. Commit and push repository to GitHub.
2. In GitHub repository settings, navigate to **Pages**.
3. Set source branch to `main` (or `master`) and folder to `/ (root)`.
4. Save. GitHub Pages will build and deploy over HTTPS.

---

## 📄 Managing Polling Place Barcode Manifests

Before each election, update [`polling_places.csv`](polling_places.csv) with the expected seal barcodes:

```csv
election_id,election_name,election_date,precinct,location_name,address,expected_barcode
2026-08,August 2026 General,2026-08-06,01,Brainerd Recreation Center,1010 N Moore Rd Chattanooga TN 37411,SEAL-A001-2026
```

Commit the updated CSV file to update the live app manifest.
