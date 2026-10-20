'use strict';
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { csvToObjects, parsePrecinctsCSV, parseScheduleCSV, buildManifest, normSeal } = require('./manifest');
const { splitLocation, matchSlot, computeDelivery, computeSupplies, reconstructScans, mergeScans, applyAdminEdit, UUID_RE } = require('./delivery');

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

// For codes that are not in `locationKey`, find which other location they belong to (admin-visible only).
// Returns { NORMALIZED_CODE: locationKey | null }.
async function resolveBelongsTo(eref, locationKey, unexpected) {
  const belongs = {};
  if (!unexpected.length) return belongs;
  const others = [];
  (await eref.collection('expected').get()).forEach(x => { if (x.id !== locationKey) others.push([x.id, x.data().slots]); });
  unexpected.forEach(u => {
    const hit = others.find(([, slots]) => matchSlot(slots, u.code) >= 0);
    belongs[normSeal(u.code)] = hit ? hit[0] : null;
  });
  return belongs;
}

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
  const { machineCsv, precinctCsv, scheduleCsv, commit } = req.data || {};
  str(machineCsv, 5000000, 'machineCsv');
  str(precinctCsv, 5000000, 'precinctCsv');
  if (typeof scheduleCsv !== 'string' || !scheduleCsv.trim()) {
    throw new HttpsError('invalid-argument', 'The delivery schedule export is required (it sets the delivery order).');
  }
  str(scheduleCsv, 5000000, 'scheduleCsv');

  const warnings = [];
  let manifest;
  try {
    const warn = w => warnings.push(w);
    manifest = buildManifest(csvToObjects(machineCsv), parsePrecinctsCSV(precinctCsv, warn), parseScheduleCSV(scheduleCsv, warn), warn);
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

  const days = {};
  const supplyTotals = {};
  manifest.forEach(b => {
    if (b.route.day != null) days[b.route.day] = (days[b.route.day] || 0) + 1;
    b.supplies.forEach(s => { supplyTotals[s.label] = (supplyTotals[s.label] || 0) + s.qty; });
  });
  const preview = {
    election, buildings: manifest.length, seals: sealCount, days, supplyTotals,
    unassigned, noMachineBuildings: noMachine, warnings,
    locations: manifest.map(b => ({ name: b.location_name, route: b.route.label, seals: b.machines.length, precincts: b.precincts.length }))
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
  if (d.supplies !== undefined && (!Array.isArray(d.supplies) || d.supplies.length > 50)) {
    throw new HttpsError('invalid-argument', 'Invalid supplies.');
  }
  const submittedSupplies = (d.supplies || []).map(x => ({
    key: str(String(x && x.key), 100, 'supply key'),
    delivered: !!(x && x.delivered === true),
    qty: x && Number.isFinite(x.qty) ? x.qty : undefined
  }));

  let photoPath = '';
  if (d.photoPath) {
    photoPath = str(d.photoPath, 300, 'photoPath');
    if (!photoPath.startsWith(`photos/${auth.uid}/`) || photoPath.includes('..')) throw new HttpsError('invalid-argument', 'Invalid photoPath.');
  }
  let gps = { lat: null, lon: null };
  if (d.gps && Number.isFinite(d.gps.lat) && Number.isFinite(d.gps.lon)) gps = { lat: d.gps.lat, lon: d.gps.lon };

  const dref = db.doc(`deliveries/${clientId}`);
  const summary = (e) => ({ match_status: e.match_status, scanned_count: e.scanned_count, expected_count: e.expected_count, supplies_status: e.supplies_status || null, duplicate: true });
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

  const probe = computeDelivery(pub.slots, expSnap.data().slots, scans);
  const belongs = await resolveBelongsTo(eref, locationKey, probe.unexpected_seals);
  const result = computeDelivery(pub.slots, expSnap.data().slots, scans, c => belongs[normSeal(c)] || null);

  const record = {
    client_id: clientId,
    election_id: electionId, election_name: elec.data().name,
    location_key: locationKey, location_name: pub.location_name, address: pub.address, precincts: pub.precincts,
    ...result,
    computed_status: result.match_status, status_overridden: false, edit_count: 0,
    ...computeSupplies(pub.supplies, submittedSupplies), route: pub.route || null,
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
  return { match_status: result.match_status, scanned_count: result.scanned_count, expected_count: result.expected_count, supplies_status: record.supplies_status };
});

// ---------------------------------------------------------------- admin edit / soft delete
const DELIVERY_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function adminArgs(d) {
  const deliveryId = str(d.deliveryId, 100, 'deliveryId');
  if (!DELIVERY_ID_RE.test(deliveryId)) throw new HttpsError('invalid-argument', 'Invalid deliveryId.');
  if (!Number.isInteger(d.baseEditCount) || d.baseEditCount < 0) throw new HttpsError('invalid-argument', 'Invalid baseEditCount.');
  const reason = str(d.reason, 300, 'reason').trim();
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'A reason (3+ characters) is required.');
  return { deliveryId, baseEditCount: d.baseEditCount, reason };
}

// Load a delivery and enforce the guards shared by edit/delete/restore.
async function loadEditable(deliveryId, baseEditCount) {
  const dref = db.doc(`deliveries/${deliveryId}`);
  const snap = await dref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');
  const existing = snap.data();
  const elec = await db.doc(`elections/${existing.election_id}`).get();
  if (!elec.exists || !elec.data().active) {
    throw new HttpsError('failed-precondition', 'Only records for the active election can be changed.');
  }
  if ((existing.edit_count || 0) !== baseEditCount) {
    throw new HttpsError('aborted', 'This record was changed by someone else. Reload and try again.');
  }
  return { dref, existing };
}

exports.adminUpdateDelivery = onCall(async (req) => {
  const auth = await requireAdmin(req);
  const d = req.data || {};
  const { deliveryId, baseEditCount, reason } = adminArgs(d);
  const p = d.patch;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpsError('invalid-argument', 'Invalid patch.');

  const patch = {};
  if (p.notes !== undefined) patch.notes = str(p.notes, 2000, 'notes');
  if (p.locationKey !== undefined) patch.locationKey = str(p.locationKey, 200, 'locationKey');
  if (p.statusOverride !== undefined) {
    if (p.statusOverride !== null && typeof p.statusOverride !== 'string') throw new HttpsError('invalid-argument', 'Invalid status override.');
    patch.statusOverride = p.statusOverride;
  }
  if (p.supplies !== undefined) {
    if (!Array.isArray(p.supplies) || p.supplies.length > 50) throw new HttpsError('invalid-argument', 'Invalid supplies.');
    patch.supplies = p.supplies.map(x => ({
      key: str(String(x && x.key), 100, 'supply key'),
      delivered: !!(x && x.delivered === true),
      qty: x && Number.isFinite(x.qty) ? x.qty : undefined
    }));
  }
  if (p.scans !== undefined) {
    if (!Array.isArray(p.scans) || p.scans.length > 50) throw new HttpsError('invalid-argument', 'Invalid scans.');
    patch.scans = p.scans.map(c => str(c, 100, 'code'));
  }

  const { dref, existing } = await loadEditable(deliveryId, baseEditCount);
  const email = auth.token.email || auth.uid;
  const now = new Date().toISOString();

  // Everything that needs expected seals is read here, outside the transaction.
  const ctx = { admin: { email }, now, belongsTo: () => null };
  const legacy = !Array.isArray(existing.seals);
  if (!legacy && (patch.scans !== undefined || patch.locationKey !== undefined || patch.supplies !== undefined)) {
    const targetKey = patch.locationKey !== undefined ? patch.locationKey : existing.location_key;
    const eref = db.doc(`elections/${existing.election_id}`);
    const [pubSnap, expSnap] = await Promise.all([
      eref.collection('locations').doc(targetKey).get(), eref.collection('expected').doc(targetKey).get()
    ]);
    if (!pubSnap.exists || !expSnap.exists) throw new HttpsError('not-found', 'That location no longer exists in this election.');
    ctx.pub = pubSnap.data();
    ctx.expectedSlots = expSnap.data().slots;
    const scans = patch.scans !== undefined ? mergeScans(existing, patch.scans, ctx.admin, now) : reconstructScans(existing);
    const probe = computeDelivery(ctx.pub.slots, ctx.expectedSlots, scans);
    const belongs = await resolveBelongsTo(eref, targetKey, probe.unexpected_seals);
    ctx.belongsTo = c => belongs[normSeal(c)] || null;
  }

  let result;
  try {
    result = applyAdminEdit(existing, patch, ctx);
  } catch (e) {
    if (e.code) throw new HttpsError(e.code, e.message);
    throw e;
  }

  await db.runTransaction(async (tx) => {
    const cur = await tx.get(dref);
    if (!cur.exists) throw new HttpsError('not-found', 'Record not found.');
    if ((cur.data().edit_count || 0) !== baseEditCount) {
      throw new HttpsError('aborted', 'This record was changed by someone else. Reload and try again.');
    }
    tx.update(dref, {
      ...result.update,
      edit_count: baseEditCount + 1,
      last_edited_by: email,
      last_edited_at: FieldValue.serverTimestamp()
    });
    tx.set(dref.collection('revisions').doc(), {
      type: 'edit', by: email, at: FieldValue.serverTimestamp(), reason,
      before: result.before, after: result.after
    });
  });

  const merged = { ...existing, ...result.update };
  return {
    match_status: merged.match_status, computed_status: merged.computed_status || merged.match_status,
    status_overridden: !!merged.status_overridden, edit_count: baseEditCount + 1
  };
});

exports.adminSetDeliveryDeleted = onCall(async (req) => {
  const auth = await requireAdmin(req);
  const d = req.data || {};
  const { deliveryId, baseEditCount, reason } = adminArgs(d);
  if (typeof d.deleted !== 'boolean') throw new HttpsError('invalid-argument', 'Invalid deleted flag.');

  const { dref, existing } = await loadEditable(deliveryId, baseEditCount);
  if (!!existing.deleted === d.deleted) {
    throw new HttpsError('failed-precondition', d.deleted ? 'Record is already deleted.' : 'Record is not deleted.');
  }
  const email = auth.token.email || auth.uid;

  await db.runTransaction(async (tx) => {
    const cur = await tx.get(dref);
    if (!cur.exists) throw new HttpsError('not-found', 'Record not found.');
    if ((cur.data().edit_count || 0) !== baseEditCount) {
      throw new HttpsError('aborted', 'This record was changed by someone else. Reload and try again.');
    }
    tx.update(dref, d.deleted
      ? { deleted: true, deleted_by: email, deleted_at: FieldValue.serverTimestamp(), delete_reason: reason, edit_count: baseEditCount + 1 }
      : { deleted: false, deleted_by: FieldValue.delete(), deleted_at: FieldValue.delete(), delete_reason: FieldValue.delete(), edit_count: baseEditCount + 1 });
    tx.set(dref.collection('revisions').doc(), {
      type: d.deleted ? 'delete' : 'restore', by: email, at: FieldValue.serverTimestamp(), reason,
      before: { deleted: !!existing.deleted }, after: { deleted: d.deleted }
    });
  });
  return { deleted: d.deleted, edit_count: baseEditCount + 1 };
});
