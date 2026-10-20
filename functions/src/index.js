'use strict';
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { csvToObjects, parsePrecinctsCSV, buildManifest, normSeal } = require('./manifest');
const { splitLocation, matchSlot, computeDelivery, UUID_RE } = require('./delivery');

admin.initializeApp();
setGlobalOptions({ region: 'us-east1', maxInstances: 10 });

const db = admin.firestore();
const MAX_FAILED_CHECKS = 15;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth;
}

async function requireAdmin(req) {
  const auth = requireAuth(req);
  const snap = await db.doc(`admins/${auth.uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Admin only.');
  return auth;
}

const str = (v, max, name) => {
  if (typeof v !== 'string' || v.length > max) throw new HttpsError('invalid-argument', `Invalid ${name}.`);
  return v;
};

// ---------------------------------------------------------------- importElection
async function deleteCollection(ref) {
  const docs = await ref.listDocuments();
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch();
    docs.slice(i, i + 400).forEach(d => b.delete(d));
    await b.commit();
  }
}

exports.importElection = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const auth = await requireAdmin(req);
  const { machineCsv, precinctCsv, commit } = req.data || {};
  str(machineCsv, 5000000, 'machineCsv');
  str(precinctCsv, 5000000, 'precinctCsv');

  const warnings = [];
  let manifest;
  try {
    manifest = buildManifest(csvToObjects(machineCsv), parsePrecinctsCSV(precinctCsv, w => warnings.push(w)), w => warnings.push(w));
  } catch (e) {
    throw new HttpsError('invalid-argument', e.message);
  }
  if (!manifest.length) throw new HttpsError('invalid-argument', 'No locations found in the precinct export.');

  const election = {
    election_id: manifest[0].election_id,
    name: manifest[0].election_name,
    date: manifest[0].election_date
  };
  const sealCount = manifest.reduce((n, b) => n + b.machines.length, 0);
  const unassigned = manifest.filter(b => b.location_key === 'unassigned-machines')
    .flatMap(b => b.machines.map(m => `${m.precinct} ${m.machine}`.trim()));
  const noMachine = manifest.filter(b => !b.machines.length).map(b => b.location_name);

  const preview = {
    election, buildings: manifest.length, seals: sealCount,
    unassigned, noMachineBuildings: noMachine, warnings,
    locations: manifest.map(b => ({ name: b.location_name, seals: b.machines.length, precincts: b.precincts.length }))
  };
  if (!commit) return { committed: false, ...preview };

  const eref = db.doc(`elections/${election.election_id}`);
  // Replace any previous import of this election
  await deleteCollection(eref.collection('locations'));
  await deleteCollection(eref.collection('expected'));

  const ops = [];
  manifest.forEach(b => {
    const { key, pub, expected } = splitLocation(b);
    ops.push([eref.collection('locations').doc(key), pub]);
    ops.push([eref.collection('expected').doc(key), expected]);
  });
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, data));
    await batch.commit();
  }

  // Activate this election, deactivate the rest
  const others = await db.collection('elections').where('active', '==', true).get();
  const b = db.batch();
  others.forEach(d => { if (d.id !== election.election_id) b.update(d.ref, { active: false }); });
  b.set(eref, {
    name: election.name, date: election.date, active: true,
    imported_at: FieldValue.serverTimestamp(),
    imported_by: auth.token.email || auth.uid,
    location_count: manifest.length, seal_count: sealCount
  });
  await b.commit();
  return { committed: true, ...preview };
});

// ---------------------------------------------------------------- verifySeal
exports.verifySeal = onCall(async (req) => {
  const auth = requireAuth(req);
  const { electionId, locationKey, code } = req.data || {};
  str(electionId, 40, 'electionId');
  str(locationKey, 200, 'locationKey');
  str(code, 100, 'code');

  const rlRef = db.doc(`rate_limits/${auth.uid}_${electionId}_${locationKey}`);
  const rl = await rlRef.get();
  if (rl.exists && (rl.data().failed || 0) >= MAX_FAILED_CHECKS) {
    throw new HttpsError('resource-exhausted', 'Too many incorrect seal attempts at this location. Contact the office.');
  }

  const expSnap = await db.doc(`elections/${electionId}/expected/${locationKey}`).get();
  if (!expSnap.exists) throw new HttpsError('not-found', 'Unknown location.');
  const slot = matchSlot(expSnap.data().slots, code);
  const match = slot >= 0;

  await db.collection('seal_checks').add({
    uid: auth.uid, email: auth.token.email || null, election_id: electionId, location_key: locationKey,
    code: normSeal(code), result: match ? 'match' : 'nomatch',
    at: FieldValue.serverTimestamp()
  });
  if (!match) {
    await rlRef.set({ failed: FieldValue.increment(1), uid: auth.uid, election_id: electionId, location_key: locationKey }, { merge: true });
  }
  return match ? { match: true, slot } : { match: false };
});

// ---------------------------------------------------------------- submitDelivery
exports.submitDelivery = onCall(async (req) => {
  const auth = requireAuth(req);
  const d = req.data || {};
  const clientId = str(d.clientId, 40, 'clientId');
  if (!UUID_RE.test(clientId)) throw new HttpsError('invalid-argument', 'Invalid clientId.');
  const electionId = str(d.electionId, 40, 'electionId');
  const locationKey = str(d.locationKey, 200, 'locationKey');
  const notes = d.notes == null ? '' : str(d.notes, 2000, 'notes');
  if (!Array.isArray(d.scans) || d.scans.length > 50) throw new HttpsError('invalid-argument', 'Invalid scans.');
  const scans = d.scans.map(s => ({
    code: str(String(s && s.code), 100, 'code'),
    source: s && s.source,
    at: typeof (s && s.at) === 'string' ? s.at.slice(0, 40) : null
  }));
  if (!scans.length) throw new HttpsError('invalid-argument', 'At least one scan is required.');

  let photoPath = '';
  if (d.photoPath) {
    photoPath = str(d.photoPath, 300, 'photoPath');
    if (!photoPath.startsWith(`photos/${auth.uid}/`) || photoPath.includes('..')) throw new HttpsError('invalid-argument', 'Invalid photoPath.');
  }
  let gps = { lat: null, lon: null };
  if (d.gps && Number.isFinite(d.gps.lat) && Number.isFinite(d.gps.lon)) gps = { lat: d.gps.lat, lon: d.gps.lon };

  const dref = db.doc(`deliveries/${clientId}`);
  const summary = (e) => ({ match_status: e.match_status, scanned_count: e.scanned_count, expected_count: e.expected_count, duplicate: true });
  const existing = await dref.get();
  if (existing.exists) {
    if (existing.data().driver_uid !== auth.uid) throw new HttpsError('already-exists', 'Duplicate delivery id.');
    return summary(existing.data());
  }

  const eref = db.doc(`elections/${electionId}`);
  const [elec, pubSnap, expSnap] = await Promise.all([
    eref.get(), eref.collection('locations').doc(locationKey).get(), eref.collection('expected').doc(locationKey).get()
  ]);
  if (!elec.exists || !pubSnap.exists || !expSnap.exists) throw new HttpsError('not-found', 'Unknown election or location.');
  const pub = pubSnap.data();

  // Find which other location a stray code belongs to (admin-visible only)
  const probe = computeDelivery(pub.slots, expSnap.data().slots, scans);
  const belongs = {};
  if (probe.unexpected_seals.length) {
    const others = [];
    (await eref.collection('expected').get()).forEach(x => { if (x.id !== locationKey) others.push([x.id, x.data().slots]); });
    probe.unexpected_seals.forEach(u => {
      const hit = others.find(([, slots]) => matchSlot(slots, u.code) >= 0);
      belongs[normSeal(u.code)] = hit ? hit[0] : null;
    });
  }
  const result = computeDelivery(pub.slots, expSnap.data().slots, scans, c => belongs[normSeal(c)] || null);

  const record = {
    client_id: clientId,
    election_id: electionId, election_name: elec.data().name,
    location_key: locationKey, location_name: pub.location_name, address: pub.address, precincts: pub.precincts,
    ...result,
    notes, photo_path: photoPath, photo_url: '',
    driver_uid: auth.uid, driver_email: auth.token.email || 'unknown',
    gps,
    timestamp: FieldValue.serverTimestamp()
  };
  try {
    await dref.create(record);
  } catch (e) {
    if (e.code === 6) return summary((await dref.get()).data()); // concurrent retry
    throw e;
  }
  return { match_status: result.match_status, scanned_count: result.scanned_count, expected_count: result.expected_count };
});
