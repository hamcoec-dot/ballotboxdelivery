// HCEC Ballot Box Chain of Custody: admin delivery monitoring dashboard (desktop first).
// Loaded by index.html only after the signed-in user passes the admin check. Firestore rules and the
// Cloud Functions enforce access; this file is UX only. Shares globals with index.html:
// manifestData, manifestReady, loadElections, showView, callFn, normSeal, escapeHtml.
// Keep this file pure ASCII (HTML_Design_Playbook.md section 1): use HTML entities or \u escapes.

const ADMIN_TZ = 'America/New_York';   // Hamilton County, TN
const MAX_SEAL_FAILS = 15;              // must match MAX_FAILED_CHECKS in functions/src/index.js

let auditDocs = [];        // deliveries for the active election(s), live
let pastDocs = null;       // deliveries for other elections, loaded on demand
let rateLimits = [];       // seal-attempt counters for the active election(s), live
let sealChecks = null;     // seal_checks for the active election(s), loaded on demand
let adminUnsubs = [];
let adminSubscribedIds = null;
let adminLive = { at: null, cached: false, error: '' };
let adminTab = 'stops';
let adminFilter = { q: '', day: 'all', status: 'all', missesOnly: true };
let adminSort = {};        // tab -> { col, dir }
let drawerTarget = null;   // { source: 'active'|'past', electionId, locationKey, deliveryId }
const photoUrlCache = new Map();
const historyCache = new Map();   // deliveryId -> { editCount, html }
const uidEmail = new Map();

// ---------------------------------------------------------------- helpers
const tsMs = (t) => (t && t.seconds != null ? t.seconds * 1000 : null);
const fmtTime = (t) => {
  const ms = tsMs(t);
  return ms == null ? 'Pending sync'
    : new Date(ms).toLocaleString('en-US', { timeZone: ADMIN_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const fmtTimeFull = (t) => {
  const ms = tsMs(t);
  return ms == null ? '' : new Date(ms).toLocaleString('en-US', { timeZone: ADMIN_TZ });
};
const activeElectionIds = () => [...new Set(manifestData.map(m => m.election_id))];
const stopKey = (electionId, locationKey) => `${electionId}|${locationKey}`;
const locByKey = (k) => manifestData.find(m => m.location_key === k);
const locName = (k) => { const m = locByKey(k); return m ? m.location_name : (k || ''); };
const precinctText = (d) => Array.isArray(d.precincts) && d.precincts.length
  ? d.precincts.map(p => `${p.name} (${p.num})`).join(', ')
  : (d.precinct ? 'Precinct ' + d.precinct : '');
const mapsUrl = (q) => 'https://maps.google.com/?q=' + encodeURIComponent(q);
const hasGps = (d) => d.gps && Number.isFinite(d.gps.lat) && Number.isFinite(d.gps.lon);
const isEdited = (d) => (d.edit_count || 0) > 0 || !!d.status_overridden;
const newestFirst = (a, b) => (tsMs(b.timestamp) ?? Infinity) - (tsMs(a.timestamp) ?? Infinity);

const BADGES = {
  MATCH: ['b-ok', '&#x2705; MATCH'],
  INCOMPLETE: ['b-warn', '&#x26A0;&#xFE0F; INCOMPLETE'],
  MISMATCH: ['b-bad', '&#x26A0;&#xFE0F; MISMATCH'],
  OUTSTANDING: ['b-muted', 'Not delivered'],
  SHORT: ['b-warn', '&#x26A0;&#xFE0F; SHORT'],
  COMPLETE: ['b-ok', '&#x2705; COMPLETE'],
  DELETED: ['b-muted', 'Deleted']
};
const badge = (s) => {
  const [cls, text] = BADGES[s] || ['b-bad', escapeHtml(s || '?')];
  return `<span class="adm-badge ${cls}">${text}</span>`;
};
// Kept for the edit dialog summary
const statusBadge = (s) => badge(s || 'MISMATCH');

// ---------------------------------------------------------------- loading
function loadAdminShell() {
  const root = document.getElementById('viewAdmin');
  if (root.dataset.ready) return;
  root.dataset.ready = '1';
  root.innerHTML = `
    <div class="adm-head">
      <div>
        <h1 class="adm-title">Delivery Monitoring</h1>
        <div class="adm-sub"><span id="admElection">Loading election...</span> &middot; <span id="admLive" class="adm-live" aria-live="polite">Connecting...</span></div>
      </div>
      <div class="adm-actions no-print">
        <button type="button" class="btn btn-small btn-secondary" onclick="adminExportCSV()" aria-label="Export the records in the current tab and filter to a CSV file"><span aria-hidden="true">&#x1F4E5;</span>&nbsp;Export CSV</button>
        <button type="button" class="btn btn-small btn-outline" onclick="window.print()" aria-label="Print the dashboard">Print</button>
        <button type="button" class="btn btn-small btn-outline" onclick="showView('viewElections')" aria-label="Go to the driver delivery workflow">Delivery Workflow</button>
      </div>
    </div>

    <div id="admError" class="alert alert-danger" role="alert" style="display: none;"></div>
    <div id="admLocks"></div>
    <div id="admKpis" class="adm-kpis"></div>

    <div class="card adm-card">
      <h2 class="card-title">Progress by day</h2>
      <div id="admDays" class="adm-days"></div>
    </div>

    <div class="card adm-card">
      <div class="adm-tabs no-print" role="tablist" aria-label="Dashboard views">
        <button type="button" role="tab" class="adm-tab" data-tab="stops" aria-controls="admTable" onclick="setAdminTab('stops')">Stops <span data-count="stops"></span></button>
        <button type="button" role="tab" class="adm-tab" data-tab="subs" aria-controls="admTable" onclick="setAdminTab('subs')">Submissions <span data-count="subs"></span></button>
        <button type="button" role="tab" class="adm-tab" data-tab="drivers" aria-controls="admTable" onclick="setAdminTab('drivers')">Drivers <span data-count="drivers"></span></button>
        <button type="button" role="tab" class="adm-tab" data-tab="seals" aria-controls="admTable" onclick="setAdminTab('seals')">Seal checks <span data-count="seals"></span></button>
        <button type="button" role="tab" class="adm-tab" data-tab="deleted" aria-controls="admTable" onclick="setAdminTab('deleted')">Deleted <span data-count="deleted"></span></button>
        <button type="button" role="tab" class="adm-tab" data-tab="past" aria-controls="admTable" onclick="setAdminTab('past')">Past elections <span data-count="past"></span></button>
      </div>

      <div class="adm-toolbar no-print">
        <label for="admSearch" class="adm-sr">Search</label>
        <input type="search" id="admSearch" placeholder="Search location, precinct, driver, seal, notes..." oninput="adminFilter.q = this.value; renderAdminTab();" onkeydown="if(event.key==='Escape'){this.value='';adminFilter.q='';renderAdminTab();}">
        <label for="admDay" class="adm-sr">Delivery day</label>
        <select id="admDay" onchange="adminFilter.day = this.value; renderAdminAll();"></select>
        <div id="admChips" class="adm-chips" role="group" aria-label="Status filter"></div>
        <label id="admMissesBox" class="adm-check" hidden><input type="checkbox" id="admMisses" checked onchange="adminFilter.missesOnly = this.checked; renderAdminTab();"> Misses only</label>
        <button type="button" class="btn btn-small btn-outline" onclick="clearAdminFilters()">Clear filters</button>
      </div>
      <p id="admTabNote" class="adm-note"></p>
      <div id="admTable" role="tabpanel"></div>
    </div>

    <div class="card no-print">
      <details id="importCard">
        <summary onclick="loadElectionList()">Import Election Data</summary>
        <p class="adm-note" style="margin: 8px 0 12px;">Upload the three election-office exports (machine data, precincts and polling places, delivery schedule). Seal numbers are stored server-side only and are never sent to drivers. Importing makes that election the active one.</p>
        <div class="adm-import-grid">
          <div class="form-group">
            <label for="importMachine">Machine data export (CSV)</label>
            <input type="file" id="importMachine" accept=".csv,text/csv" onchange="invalidateImportPreview()">
          </div>
          <div class="form-group">
            <label for="importPrecinct">Precincts and polling places export (CSV)</label>
            <input type="file" id="importPrecinct" accept=".csv,text/csv" onchange="invalidateImportPreview()">
          </div>
          <div class="form-group">
            <label for="importSchedule">Delivery schedule export (CSV)</label>
            <input type="file" id="importSchedule" accept=".csv,text/csv" onchange="invalidateImportPreview()">
          </div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          <button type="button" id="btnImportPreview" class="btn btn-small btn-secondary" onclick="runImport(false)">Preview</button>
          <button type="button" id="btnImportPublish" class="btn btn-small" onclick="runImport(true)" disabled>Publish</button>
        </div>
        <div id="importResult" aria-live="polite"></div>
        <h3 style="margin: 12px 0 4px; font-size: 16px;">Elections</h3>
        <div id="electionList" style="font-size: 14px;">Open this section to load.</div>
      </details>
    </div>

    <div class="card no-print">
      <details id="clearCard">
        <summary onclick="loadClearCard()">Clear Test Data</summary>
        <p class="adm-note" style="margin: 8px 0 12px;">Use this after a practice run, before real deliveries start. It removes every delivery record, seal check, driver lockout and delivery photo for the election you choose. The imported stop list and seal numbers stay, so drivers can start real deliveries straight away. A backup copy is saved first. It cannot be used on or after election day.</p>
        <div class="form-group">
          <label for="clearElection">Election</label>
          <select id="clearElection" onchange="resetClearCard(); loadClearHistory();"><option value="">Loading...</option></select>
        </div>
        <button type="button" id="btnClearCheck" class="btn btn-small btn-secondary" onclick="runClearTestData(false)">Check what will be removed</button>
        <div id="clearResult" aria-live="polite" style="margin-top: 12px;"></div>
        <div id="clearConfirmBox" hidden>
          <div class="form-group">
            <label for="clearReason">Reason (kept in the log)</label>
            <input type="text" id="clearReason" maxlength="300" placeholder="Practice run finished" oninput="updateClearButton()">
          </div>
          <div class="form-group">
            <label for="clearConfirm">To confirm, type the election ID <strong id="clearConfirmId"></strong></label>
            <input type="text" id="clearConfirm" maxlength="40" autocomplete="off" spellcheck="false" oninput="updateClearButton()">
          </div>
          <button type="button" id="btnClearRun" class="btn btn-small btn-danger" onclick="runClearTestData(true)" disabled>Clear test data</button>
        </div>
        <h3 style="margin: 12px 0 4px; font-size: 16px;">Earlier clears</h3>
        <div id="clearHistory" style="font-size: 14px;">Choose an election.</div>
      </details>
    </div>

    <dialog id="admDrawer" class="adm-drawer" aria-labelledby="admDrawerTitle">
      <div class="adm-drawer-head">
        <h2 id="admDrawerTitle">Details</h2>
        <button type="button" class="btn btn-small btn-outline" onclick="closeDrawer()" aria-label="Close details panel">Close</button>
      </div>
      <div id="admDrawerBody" class="adm-drawer-body"></div>
    </dialog>

    <dialog id="editDialog" class="adm-dialog" aria-labelledby="editDialogTitle">
      <h2 id="editDialogTitle" style="margin-bottom: 4px; font-size: 20px;">Edit delivery record</h2>
      <p id="editSummary" style="font-size: 14px; margin-bottom: 12px;"></p>
      <div id="editLegacyNote" class="alert alert-warning" style="display: none;">Older single-seal record: only the notes can be edited.</div>
      <div class="form-group">
        <label for="editLocation">Location</label>
        <select id="editLocation"></select>
      </div>
      <div class="form-group">
        <label for="editScans">Scanned seals (one per line)</label>
        <textarea id="editScans" rows="4"></textarea>
      </div>
      <div class="form-group">
        <label for="editStatus">Status</label>
        <select id="editStatus">
          <option value="auto">Auto (computed from the seals)</option>
          <option value="MATCH">Override: MATCH</option>
          <option value="INCOMPLETE">Override: INCOMPLETE</option>
          <option value="MISMATCH">Override: MISMATCH</option>
        </select>
      </div>
      <div id="editSuppliesBox" class="form-group" style="display: none;">
        <label>Supplies</label>
        <div id="editSupplies" style="font-size: 14px;"></div>
      </div>
      <div class="form-group">
        <label for="editNotes">Notes</label>
        <textarea id="editNotes" rows="3"></textarea>
      </div>
      <div class="form-group">
        <label for="editReason">Reason for this change (required)</label>
        <input type="text" id="editReason" maxlength="300">
      </div>
      <div id="editError" class="alert alert-danger" style="display: none;" role="alert"></div>
      <div style="display: flex; gap: 8px; margin: 12px 0;">
        <button type="button" id="btnEditSave" class="btn btn-small" onclick="saveEdit()">Save changes</button>
        <button type="button" class="btn btn-small btn-outline" onclick="document.getElementById('editDialog').close()">Cancel</button>
      </div>
    </dialog>`;
  document.getElementById('admDrawer').addEventListener('close', () => { drawerTarget = null; });
  document.getElementById('admDrawer').addEventListener('click', (e) => {
    if (e.target.id === 'admDrawer') closeDrawer();   // click on the backdrop
  });
}

// Called by index.html after the admin check passes.
async function initAdmin() {
  loadAdminShell();
  try { await manifestReady; } catch (e) { /* loadElections shows its own error */ }
  subscribeAdminData();
  renderAdminAll();
  // Keep the delivered status drivers see in step with the records (fills in stops delivered before it existed).
  activeElectionIds().forEach(id => callFn('rebuildStopStatus', { electionId: id })
    .catch(e => console.warn('Could not refresh driver stop status:', e)));
}

// Called by index.html whenever loadElections() finishes (e.g. after a new import).
function adminOnManifest() {
  if (!document.getElementById('admTable')) return;
  if (activeElectionIds().join(',') !== adminSubscribedIds) {
    pastDocs = null;
    sealChecks = null;
    subscribeAdminData();
  }
  renderAdminAll();
}

// Called by index.html on sign out.
function adminReset() {
  adminUnsubs.forEach(u => u());
  adminUnsubs = [];
  adminSubscribedIds = null;
  auditDocs = []; pastDocs = null; rateLimits = []; sealChecks = null;
  photoUrlCache.clear(); historyCache.clear(); uidEmail.clear();
  const root = document.getElementById('viewAdmin');
  if (root) { root.innerHTML = ''; delete root.dataset.ready; }
}

function setAdminError(msg) {
  const el = document.getElementById('admError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// Live listeners are scoped to the active election(s). If no election is active (or the manifest
// could not be loaded) fall back to every delivery so nothing is hidden.
function subscribeAdminData() {
  adminUnsubs.forEach(u => u());
  adminUnsubs = [];
  const ids = activeElectionIds().slice(0, 10);
  adminSubscribedIds = activeElectionIds().join(',');
  const db = firebase.firestore();

  let dq = db.collection('deliveries');
  if (ids.length) dq = dq.where('election_id', 'in', ids);
  adminUnsubs.push(dq.onSnapshot({ includeMetadataChanges: true }, snap => {
    auditDocs = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    auditDocs.forEach(d => { if (d.driver_uid && d.driver_email) uidEmail.set(d.driver_uid, d.driver_email); });
    adminLive = { at: new Date(), cached: snap.metadata.fromCache, error: '' };
    setAdminError('');
    renderAdminAll();
    refreshDrawer();
  }, err => {
    adminLive.error = err.message;
    setAdminError('Could not load delivery records: ' + err.message);
    renderAdminLive();
  }));

  let rq = db.collection('rate_limits');
  if (ids.length) rq = rq.where('election_id', 'in', ids);
  adminUnsubs.push(rq.onSnapshot(snap => {
    rateLimits = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    resolveLockEmails();
    renderAdminLocks();
    if (adminTab === 'drivers' || adminTab === 'seals') renderAdminTab();
  }, err => console.warn('rate_limits listener:', err)));
}

async function loadPastDocs() {
  const note = document.getElementById('admTabNote');
  if (note) note.textContent = 'Loading records from other elections...';
  try {
    const ids = new Set(activeElectionIds());
    const snap = await firebase.firestore().collection('deliveries').get();
    pastDocs = snap.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter(d => !ids.has(d.election_id));
  } catch (err) {
    pastDocs = null;
    setAdminError('Could not load past elections: ' + err.message);
  }
  renderAdminAll();
}

async function loadSealChecks() {
  const ids = activeElectionIds().slice(0, 10);
  if (!ids.length) { sealChecks = []; renderAdminAll(); return; }
  const note = document.getElementById('admTabNote');
  if (note) note.textContent = 'Loading seal checks...';
  try {
    const snap = await firebase.firestore().collection('seal_checks').where('election_id', 'in', ids).get();
    sealChecks = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    sealChecks.forEach(c => { if (c.uid && c.email) uidEmail.set(c.uid, c.email); });
  } catch (err) {
    sealChecks = null;
    setAdminError('Could not load seal checks: ' + err.message);
  }
  renderAdminAll();
}

// Rate-limit docs only carry the uid; look up an email from one of that driver's seal checks.
async function resolveLockEmails() {
  const missing = [...new Set(rateLimits.map(r => r.uid))].filter(u => u && !uidEmail.has(u));
  for (const uid of missing) {
    try {
      const s = await firebase.firestore().collection('seal_checks').where('uid', '==', uid).limit(1).get();
      uidEmail.set(uid, s.empty ? uid : (s.docs[0].data().email || uid));
    } catch (e) { uidEmail.set(uid, uid); }
  }
  if (missing.length) renderAdminLocks();
}

// ---------------------------------------------------------------- derived data
function liveSubs() { return auditDocs.filter(d => !d.deleted); }

function stopRows() {
  const bySop = new Map();
  liveSubs().forEach(d => {
    const k = stopKey(d.election_id, d.location_key);
    if (!bySop.has(k)) bySop.set(k, []);
    bySop.get(k).push(d);
  });
  return manifestData.map(m => {
    const subs = (bySop.get(stopKey(m.election_id, m.location_key)) || []).sort(newestFirst);
    const latest = subs[0] || null;
    return {
      m, subs, latest,
      state: latest ? latest.match_status : 'OUTSTANDING',
      short: !!latest && latest.supplies_status === 'SHORT'
    };
  });
}

function dayOf(row) { return row.m ? row.m.route.day : (row.route ? row.route.day : null); }
const dayMatches = (day) => adminFilter.day === 'all'
  || (adminFilter.day === 'none' ? day == null : String(day) === adminFilter.day);

function subText(d) {
  return [d.location_name, d.address, precinctText(d), d.route && d.route.label, d.driver_email,
    d.scanned_barcode, d.expected_barcode, d.notes, d.election_name, d.id].join(' ').toLowerCase();
}
const queryMatches = (text) => {
  const q = adminFilter.q.trim().toLowerCase();
  return !q || q.split(/\s+/).every(w => text.includes(w));
};

function statusMatchesSub(d) {
  switch (adminFilter.status) {
    case 'all': return true;
    case 'issues': return d.match_status === 'MISMATCH' || d.match_status === 'INCOMPLETE';
    case 'short': return d.supplies_status === 'SHORT';
    case 'edited': return isEdited(d);
    case 'outstanding': case 'multiple': return true;   // stop-level filters
    default: return d.match_status === adminFilter.status;
  }
}
function statusMatchesStop(r) {
  switch (adminFilter.status) {
    case 'all': return true;
    case 'outstanding': return !r.latest;
    case 'delivered': return !!r.latest;
    case 'multiple': return r.subs.length > 1;
    default: return !!r.latest && statusMatchesSub(r.latest);
  }
}

function filteredStops() {
  return stopRows().filter(r => dayMatches(r.m.route.day) && statusMatchesStop(r)
    && queryMatches([r.m.location_name, r.m.address, r.m.route.label, r.m.precincts.map(p => `${p.name} ${p.num}`).join(' '),
      ...r.subs.map(subText)].join(' ').toLowerCase()));
}
function filteredSubs(list) {
  return list.filter(d => dayMatches(d.route ? d.route.day : null) && statusMatchesSub(d) && queryMatches(subText(d)));
}

function driverRows() {
  const map = new Map();
  const row = (uid, email) => {
    if (!map.has(uid)) map.set(uid, { uid, email: email || uidEmail.get(uid) || uid, subs: [], fails: 0, locked: 0 });
    return map.get(uid);
  };
  liveSubs().forEach(d => row(d.driver_uid || d.driver_email, d.driver_email).subs.push(d));
  rateLimits.forEach(r => {
    const x = row(r.uid, uidEmail.get(r.uid));
    x.fails += r.failed || 0;
    if ((r.failed || 0) >= MAX_SEAL_FAILS) x.locked++;
  });
  return [...map.values()].map(x => {
    x.subs.sort(newestFirst);
    x.last = x.subs[0] || null;
    x.issues = x.subs.filter(d => d.match_status !== 'MATCH').length;
    x.short = x.subs.filter(d => d.supplies_status === 'SHORT').length;
    return x;
  }).filter(x => (adminFilter.day === 'all' || x.subs.some(d => dayMatches(d.route ? d.route.day : null)))
    && queryMatches([x.email, ...x.subs.map(subText)].join(' ').toLowerCase()));
}

function filteredSealChecks() {
  return (sealChecks || []).filter(c => (!adminFilter.missesOnly || c.result !== 'match')
    && (adminFilter.day === 'all' || dayMatches((locByKey(c.location_key) || { route: {} }).route.day))
    && queryMatches([c.email, c.code, c.location_key, locName(c.location_key)].join(' ').toLowerCase()))
    .sort((a, b) => (tsMs(b.at) || 0) - (tsMs(a.at) || 0));
}

// ---------------------------------------------------------------- rendering: header, KPIs, days
function renderAdminAll() {
  if (!document.getElementById('admTable')) return;
  renderAdminHeader();
  renderAdminLive();
  renderAdminLocks();
  renderAdminKpis();
  renderAdminDays();
  renderAdminTab();
}

function renderAdminHeader() {
  const elecs = {};
  manifestData.forEach(m => { elecs[m.election_id] = `${m.election_name} (${m.election_date})`; });
  const names = Object.values(elecs);
  document.getElementById('admElection').textContent = names.length ? names.join(', ') : 'No active election (showing all records)';

  const sel = document.getElementById('admDay');
  const days = [...new Set(manifestData.map(m => m.route.day))].sort((a, b) => (a == null) - (b == null) || a - b);
  const opts = [['all', 'All days'], ...days.map(d => d == null ? ['none', 'Other stops'] : [String(d), 'Day ' + d])];
  if (!opts.some(o => o[0] === adminFilter.day)) adminFilter.day = 'all';
  sel.innerHTML = opts.map(([v, t]) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`).join('');
  sel.value = adminFilter.day;
}

function renderAdminLive() {
  const el = document.getElementById('admLive');
  if (!el) return;
  el.classList.toggle('offline', !!(adminLive.error || adminLive.cached));
  el.textContent = adminLive.error ? 'Not connected'
    : !adminLive.at ? 'Connecting...'
    : (adminLive.cached ? 'Offline, showing saved data from ' : 'Live, updated ')
      + adminLive.at.toLocaleTimeString('en-US', { timeZone: ADMIN_TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function renderAdminLocks() {
  const box = document.getElementById('admLocks');
  if (!box) return;
  const locked = rateLimits.filter(r => (r.failed || 0) >= MAX_SEAL_FAILS);
  if (!locked.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="alert alert-danger adm-locks" role="alert">
    <div><strong>${locked.length} driver lockout${locked.length === 1 ? '' : 's'}:</strong> ${MAX_SEAL_FAILS} incorrect seal attempts at a location blocks further seal checks there. Check the seal-check trail before resetting.</div>
    ${locked.map(r => `<div class="adm-lock-row"><span>${escapeHtml(uidEmail.get(r.uid) || r.uid)} at <strong>${escapeHtml(locName(r.location_key))}</strong> (${r.failed} misses)</span>
      <button type="button" class="btn btn-small btn-outline" onclick="resetRateLimit('${escapeHtml(r.id)}')" aria-label="Reset seal attempts for ${escapeHtml(uidEmail.get(r.uid) || r.uid)} at ${escapeHtml(locName(r.location_key))}">Reset</button></div>`).join('')}
  </div>`;
}

async function resetRateLimit(id) {
  const r = rateLimits.find(x => x.id === id);
  if (!r) return;
  const who = uidEmail.get(r.uid) || r.uid;
  if (!confirm(`Reset seal attempts for ${who} at ${locName(r.location_key)}? They will be able to check seals there again. Their ${r.failed || 0} earlier misses stay in the seal-check trail.`)) return;
  try {
    await firebase.firestore().collection('rate_limits').doc(id).delete();
  } catch (err) {
    alert('Could not reset: ' + err.message);
  }
}

function renderAdminKpis() {
  const stops = stopRows().filter(r => dayMatches(r.m.route.day));
  const delivered = stops.filter(r => r.latest).length;
  const count = (fn) => stops.filter(fn).length;
  const tiles = [
    ['all', 'Stops delivered', `${delivered} / ${stops.length}`, stops.length && delivered === stops.length ? 'ok' : '',
      stops.length ? Math.round(100 * delivered / stops.length) + '% complete' : 'No scheduled stops'],
    ['outstanding', 'Not delivered yet', stops.length - delivered, stops.length - delivered ? '' : 'ok', 'Scheduled stops with no record'],
    ['MATCH', 'All seals match', count(r => r.state === 'MATCH'), 'ok', 'Latest record is MATCH'],
    ['issues', 'Seal problems', count(r => r.state === 'MISMATCH' || r.state === 'INCOMPLETE'), count(r => r.state === 'MISMATCH' || r.state === 'INCOMPLETE') ? 'bad' : 'ok',
      `${count(r => r.state === 'MISMATCH')} mismatch, ${count(r => r.state === 'INCOMPLETE')} incomplete`],
    ['short', 'Supplies short', count(r => r.short), count(r => r.short) ? 'warn' : 'ok', 'Latest record is SHORT'],
    ['multiple', 'Submitted more than once', count(r => r.subs.length > 1), count(r => r.subs.length > 1) ? 'warn' : '', 'Check which record is right'],
    ['edited', 'Edited by an admin', count(r => r.latest && isEdited(r.latest)), '', 'Latest record changed or overridden']
  ];
  document.getElementById('admKpis').innerHTML = tiles.map(([f, label, n, tone, sub]) => `
    <button type="button" class="adm-kpi ${tone}" aria-pressed="${adminTab === 'stops' && adminFilter.status === f}" onclick="applyKpi('${f}')">
      <span class="l">${escapeHtml(label)}</span><span class="n">${escapeHtml(String(n))}</span><span class="s">${escapeHtml(sub)}</span>
    </button>`).join('');
}

function applyKpi(f) {
  adminFilter.status = f;
  adminTab = 'stops';
  renderAdminAll();
  document.getElementById('admTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAdminDays() {
  const groups = new Map();
  stopRows().forEach(r => {
    const d = r.m.route.day;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(r);
  });
  const days = [...groups.keys()].sort((a, b) => (a == null) - (b == null) || a - b);
  const box = document.getElementById('admDays');
  if (!days.length) { box.innerHTML = '<p class="adm-note">No active election loaded.</p>'; return; }
  box.innerHTML = days.map(d => {
    const rows = groups.get(d);
    const n = rows.length;
    const ok = rows.filter(r => r.state === 'MATCH').length;
    const bad = rows.filter(r => r.state === 'MISMATCH' || r.state === 'INCOMPLETE').length;
    const done = rows.filter(r => r.latest).length;
    const val = d == null ? 'none' : String(d);
    const pct = (x) => n ? (100 * x / n).toFixed(1) : 0;
    return `<button type="button" class="adm-day" aria-pressed="${adminFilter.day === val}" onclick="adminFilter.day = adminFilter.day === '${val}' ? 'all' : '${val}'; renderAdminAll();">
      <span class="adm-day-title">${d == null ? 'Other stops' : 'Day ' + d}</span>
      <span class="adm-day-n">${done} of ${n} delivered</span>
      <span class="adm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${done}" aria-label="${d == null ? 'Other stops' : 'Day ' + d}: ${done} of ${n} delivered">
        <span class="seg-ok" style="width: ${pct(ok)}%"></span><span class="seg-bad" style="width: ${pct(bad)}%"></span><span class="seg-other" style="width: ${pct(done - ok - bad)}%"></span>
      </span>
      <span class="adm-day-s">${ok} match &middot; ${bad} problem${bad === 1 ? '' : 's'} &middot; ${n - done} to go</span>
    </button>`;
  }).join('');
}

// ---------------------------------------------------------------- rendering: tabs
const CHIP_SETS = {
  stops: [['all', 'All'], ['outstanding', 'Not delivered'], ['delivered', 'Delivered'], ['issues', 'Seal problems'], ['MISMATCH', 'Mismatch'], ['INCOMPLETE', 'Incomplete'], ['MATCH', 'Match'], ['short', 'Supplies short'], ['multiple', 'Submitted 2+ times'], ['edited', 'Edited']],
  subs: [['all', 'All'], ['issues', 'Seal problems'], ['MISMATCH', 'Mismatch'], ['INCOMPLETE', 'Incomplete'], ['MATCH', 'Match'], ['short', 'Supplies short'], ['edited', 'Edited']]
};
CHIP_SETS.deleted = CHIP_SETS.subs;
CHIP_SETS.past = CHIP_SETS.subs;

function setAdminTab(tab) {
  adminTab = tab;
  if (tab === 'past' && pastDocs === null) loadPastDocs();
  if (tab === 'seals' && sealChecks === null) loadSealChecks();
  renderAdminAll();
}

function clearAdminFilters() {
  adminFilter = { q: '', day: 'all', status: 'all', missesOnly: true };
  document.getElementById('admSearch').value = '';
  document.getElementById('admMisses').checked = true;
  renderAdminAll();
}

function renderAdminTab() {
  document.querySelectorAll('.adm-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === adminTab)));
  const chips = CHIP_SETS[adminTab];
  if (chips && !chips.some(c => c[0] === adminFilter.status)) adminFilter.status = 'all';
  document.getElementById('admChips').innerHTML = chips ? chips.map(([v, t]) =>
    `<button type="button" class="adm-chip" aria-pressed="${adminFilter.status === v}" onclick="adminFilter.status = '${v}'; renderAdminAll();">${escapeHtml(t)}</button>`).join('') : '';
  document.getElementById('admMissesBox').hidden = adminTab !== 'seals';

  const counts = {
    stops: manifestData.length, subs: liveSubs().length, drivers: new Set(liveSubs().map(d => d.driver_uid || d.driver_email)).size,
    seals: sealChecks ? sealChecks.filter(c => c.result !== 'match').length + ' misses' : '',
    deleted: auditDocs.filter(d => d.deleted).length, past: pastDocs ? pastDocs.length : ''
  };
  document.querySelectorAll('[data-count]').forEach(s => {
    const c = counts[s.dataset.count];
    s.textContent = c === '' || c == null ? '' : `(${c})`;
  });

  const view = TABS[adminTab]();
  document.getElementById('admTabNote').innerHTML = escapeHtml(view.note || '')
    + (adminTab === 'seals' ? ' <button type="button" class="btn btn-small btn-outline" onclick="loadSealChecks()">Refresh seal checks</button>' : '')
    + (adminTab === 'past' && pastDocs !== null ? ' <button type="button" class="btn btn-small btn-outline" onclick="loadPastDocs()">Refresh</button>' : '');
  renderTable(view);
}

// view: { cols: [{ label, cell(r), sort?(r), cls? }], rows, rowAttrs(r), empty, defaultSort?, csv }
function renderTable(view) {
  const box = document.getElementById('admTable');
  const st = adminSort[adminTab] || view.defaultSort || null;
  let rows = view.rows.slice();
  if (st && view.cols[st.col] && view.cols[st.col].sort) {
    const f = view.cols[st.col].sort;
    rows.sort((a, b) => {
      const x = f(a), y = f(b);
      const c = x == null ? 1 : y == null ? -1 : (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
      return st.dir === 'desc' ? -c : c;
    });
  }
  const limit = view.limit || Infinity;
  const shown = rows.slice(0, limit);
  const head = view.cols.map((c, i) => {
    if (!c.sort) return `<th scope="col">${c.label}</th>`;
    const on = st && st.col === i;
    const aria = on ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${aria}"><button type="button" class="adm-sort" onclick="sortAdmin(${i})">${c.label}<span aria-hidden="true">${on ? (st.dir === 'asc' ? ' &#x25B2;' : ' &#x25BC;') : ''}</span></button></th>`;
  }).join('');
  const body = shown.length ? shown.map(r => `<tr ${view.rowAttrs ? view.rowAttrs(r) : ''}>${view.cols.map(c => `<td${c.cls ? ` class="${c.cls}"` : ''}>${c.cell(r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${view.cols.length}" class="adm-empty">${view.empty}</td></tr>`;
  box.innerHTML = `<div class="adm-scroll"><table class="adm-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    + `<p class="adm-note">${shown.length < rows.length ? `Showing the first ${shown.length} of ${rows.length}. Narrow the search to see more; Export CSV includes all ${rows.length}.` : `${rows.length} row${rows.length === 1 ? '' : 's'}.`}</p>`;
  box._view = view;
  box._rows = rows;
}

function sortAdmin(i) {
  const view = document.getElementById('admTable')._view;
  const cur = adminSort[adminTab] || view.defaultSort;
  adminSort[adminTab] = cur && cur.col === i ? { col: i, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { col: i, dir: 'asc' };
  renderAdminTab();
}

const sealCell = (d) => d ? `${d.scanned_count != null ? d.scanned_count : '?'} / ${d.expected_count != null ? d.expected_count : '?'}${(d.unexpected_seals || []).length ? ` <span class="adm-flag">+${d.unexpected_seals.length} unexpected</span>` : ''}` : '&mdash;';
const suppliesCell = (d) => !d || !Array.isArray(d.supplies) ? '&mdash;'
  : d.supplies_status === 'SHORT'
    ? badge('SHORT') + d.supplies.filter(x => !x.delivered).map(x => `<div class="adm-small">${escapeHtml(x.label)} ${x.delivered_qty}/${x.expected}</div>`).join('')
    : badge('COMPLETE');
const statusCell = (d) => badge(d.match_status)
  + (d.status_overridden ? `<div class="adm-small">override; computed ${escapeHtml(d.computed_status || '?')}</div>` : '')
  + (d.edit_count > 0 ? `<div class="adm-small">Edited (${d.edit_count})</div>` : '');
const evidenceCell = (d) => d ? [
  hasGps(d) ? '<span title="GPS recorded">&#x1F4CD;</span>' : '<span class="adm-missing" title="No GPS">no GPS</span>',
  d.photo_path || d.photo_url ? '<span title="Photo attached">&#x1F4F7;</span>' : '<span class="adm-missing" title="No photo">no photo</span>',
  d.notes ? '<span title="Has notes">&#x1F4DD;</span>' : ''
].join(' ') : '';
const locationCell = (d) => `<strong>${escapeHtml(d.location_name)}</strong><div class="adm-small">${escapeHtml(precinctText(d))}</div>`;
const rowOpen = (source, electionId, locationKey, deliveryId) =>
  `tabindex="0" data-open="${escapeHtml(JSON.stringify({ source, electionId, locationKey, deliveryId: deliveryId || null }))}"`;

function subsView(list, source, empty) {
  return {
    rows: filteredSubs(list), empty,
    defaultSort: { col: 0, dir: 'desc' },
    rowAttrs: (d) => rowOpen(source, d.election_id, d.location_key, d.id) + (d.match_status !== 'MATCH' ? ' class="flag-row"' : ''),
    cols: [
      { label: 'Time', cell: d => `<span class="adm-nowrap">${escapeHtml(fmtTime(d.timestamp))}</span>`, sort: d => tsMs(d.timestamp) ?? Infinity },
      { label: 'Stop', cell: d => escapeHtml((d.route && d.route.label) || ''), sort: d => d.route && Number.isFinite(d.route.index) ? d.route.index : 9999 },
      { label: 'Location', cell: d => locationCell(d) + (source === 'past' ? `<div class="adm-small">${escapeHtml(d.election_name || d.election_id)}</div>` : ''), sort: d => d.location_name },
      { label: 'Status', cell: statusCell, sort: d => d.match_status },
      { label: 'Seals', cell: sealCell, sort: d => d.scanned_count },
      { label: 'Supplies', cell: suppliesCell, sort: d => d.supplies_status || '' },
      { label: 'Driver', cell: d => escapeHtml(d.driver_email), sort: d => d.driver_email },
      { label: 'Evidence', cell: evidenceCell }
    ].concat(source === 'deleted' ? [{ label: 'Deleted', cell: d => `<div class="adm-small">${escapeHtml(d.deleted_by)} ${escapeHtml(fmtTime(d.deleted_at))}<br>Reason: ${escapeHtml(d.delete_reason)}</div>`, sort: d => tsMs(d.deleted_at) }] : []),
    csv: () => custodyCsv(filteredSubs(list))
  };
}

const TABS = {
  stops() {
    return {
      rows: filteredStops(),
      empty: manifestData.length ? 'No stops match these filters.' : 'No active election. Import one below.',
      defaultSort: { col: 0, dir: 'asc' },
      rowAttrs: (r) => rowOpen('active', r.m.election_id, r.m.location_key) + (r.latest && r.state !== 'MATCH' ? ' class="flag-row"' : !r.latest ? ' class="todo-row"' : ''),
      cols: [
        { label: 'Stop', cell: r => escapeHtml(r.m.route.label || ''), sort: r => r.m.route.index },
        { label: 'Location', cell: r => locationCell(r.m), sort: r => r.m.location_name },
        { label: 'Status', cell: r => r.latest ? statusCell(r.latest) : badge('OUTSTANDING'), sort: r => ({ OUTSTANDING: 0, MISMATCH: 1, INCOMPLETE: 2, MATCH: 3 })[r.state] ?? 1 },
        { label: 'Seals', cell: r => r.latest ? sealCell(r.latest) : `0 / ${r.m.slots.length}`, sort: r => r.latest ? r.latest.scanned_count : -1 },
        { label: 'Supplies', cell: r => suppliesCell(r.latest), sort: r => r.latest ? (r.latest.supplies_status || '') : null },
        { label: 'Delivered', cell: r => r.latest ? `<span class="adm-nowrap">${escapeHtml(fmtTime(r.latest.timestamp))}</span>` : '&mdash;', sort: r => r.latest ? (tsMs(r.latest.timestamp) ?? Infinity) : null },
        { label: 'Driver', cell: r => r.latest ? escapeHtml(r.latest.driver_email) : '', sort: r => r.latest ? r.latest.driver_email : null },
        { label: 'Records', cell: r => r.subs.length > 1 ? `<span class="adm-flag">${r.subs.length}</span>` : String(r.subs.length), sort: r => r.subs.length },
        { label: 'Evidence', cell: r => evidenceCell(r.latest) }
      ],
      csv: () => stopsCsv(filteredStops())
    };
  },
  subs: () => subsView(liveSubs(), 'active', 'No delivery records match these filters.'),
  deleted: () => Object.assign(subsView(auditDocs.filter(d => d.deleted), 'deleted', 'No deleted records for the active election.'),
    { note: 'Deleted records are hidden from the other tabs and the custody export. Open one to restore it.' }),
  past() {
    if (pastDocs === null) return { rows: [], cols: [{ label: 'Past elections', cell: () => '' }], empty: 'Loading...', csv: () => null };
    return Object.assign(subsView(pastDocs, 'past', 'No records from other elections.'),
      { note: 'Records that do not belong to the active election (test data, past elections). Read only.' });
  },
  drivers() {
    const rows = driverRows();
    return {
      rows, empty: 'No drivers have submitted for the active election yet.',
      defaultSort: { col: 2, dir: 'desc' },
      rowAttrs: (x) => x.last ? rowOpen('active', x.last.election_id, x.last.location_key, x.last.id) : '',
      cols: [
        { label: 'Driver', cell: x => escapeHtml(x.email) + (x.locked ? ` <span class="adm-badge b-bad">Locked at ${x.locked}</span>` : ''), sort: x => x.email },
        { label: 'Deliveries', cell: x => String(x.subs.length), sort: x => x.subs.length },
        { label: 'Last delivery', cell: x => x.last ? `<span class="adm-nowrap">${escapeHtml(fmtTime(x.last.timestamp))}</span><div class="adm-small">${escapeHtml(x.last.location_name)}</div>` : '&mdash;', sort: x => x.last ? (tsMs(x.last.timestamp) ?? Infinity) : null },
        { label: 'Seal problems', cell: x => x.issues ? `<span class="adm-flag">${x.issues}</span>` : '0', sort: x => x.issues },
        { label: 'Supplies short', cell: x => String(x.short), sort: x => x.short },
        { label: 'Seal misses', cell: x => x.fails ? `<span class="adm-flag">${x.fails}</span>` : '0', sort: x => x.fails }
      ],
      csv: () => toCsv(['Driver', 'Deliveries', 'Last Delivery (Eastern)', 'Last Location', 'Seal Problems', 'Supplies Short', 'Seal Misses', 'Locked Locations'],
        rows.map(x => [x.email, x.subs.length, x.last ? fmtTimeFull(x.last.timestamp) : '', x.last ? x.last.location_name : '', x.issues, x.short, x.fails, x.locked]))
    };
  },
  seals() {
    const rows = filteredSealChecks();
    const misses = new Map();
    rateLimits.forEach(r => misses.set(`${r.uid}|${r.location_key}`, r));
    return {
      rows, limit: 500,
      empty: sealChecks === null ? 'Loading...' : 'No seal checks match these filters.',
      note: 'Every seal a driver checked, from the server. Misses count toward the lockout at that location. '
        + (sealChecks ? `${sealChecks.length} checks loaded. This list does not update by itself.` : ''),
      defaultSort: { col: 0, dir: 'desc' },
      rowAttrs: (c) => rowOpen('active', c.election_id, c.location_key) + (c.result !== 'match' ? ' class="flag-row"' : ''),
      cols: [
        { label: 'Time', cell: c => `<span class="adm-nowrap">${escapeHtml(fmtTime(c.at))}</span>`, sort: c => tsMs(c.at) },
        { label: 'Driver', cell: c => escapeHtml(c.email || c.uid), sort: c => c.email || c.uid },
        { label: 'Location', cell: c => escapeHtml(locName(c.location_key)), sort: c => locName(c.location_key) },
        { label: 'Code', cell: c => `<code>${escapeHtml(c.code)}</code>`, sort: c => c.code },
        { label: 'Result', cell: c => c.result === 'match' ? badge('MATCH') : '<span class="adm-badge b-bad">No match</span>', sort: c => c.result },
        { label: 'Attempts left', cell: c => { const r = misses.get(`${c.uid}|${c.location_key}`); const left = MAX_SEAL_FAILS - ((r && r.failed) || 0); return left <= 0 ? `<button type="button" class="btn btn-small btn-outline" onclick="event.stopPropagation(); resetRateLimit('${escapeHtml(r.id)}')">Locked: reset</button>` : String(left); } }
      ],
      csv: () => toCsv(['Time (UTC)', 'Local Time (Eastern)', 'Driver', 'Location', 'Location Key', 'Code', 'Result'],
        rows.map(c => [tsMs(c.at) ? new Date(tsMs(c.at)).toISOString() : '', fmtTimeFull(c.at), c.email || c.uid, locName(c.location_key), c.location_key, c.code, c.result]))
    };
  }
};

// Row click / Enter opens the detail panel
document.addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, select, label')) return;
  const tr = e.target.closest('tr[data-open]');
  if (tr) openDrawer(JSON.parse(tr.dataset.open));
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const tr = e.target.closest && e.target.closest('tr[data-open]');
  if (tr && e.target === tr) openDrawer(JSON.parse(tr.dataset.open));
});

// ---------------------------------------------------------------- detail panel
function openDrawer(target) {
  drawerTarget = target;
  renderDrawer(true);
  const dlg = document.getElementById('admDrawer');
  if (!dlg.open) dlg.showModal();
}
function closeDrawer() { document.getElementById('admDrawer').close(); }
function refreshDrawer() { if (drawerTarget && document.getElementById('admDrawer').open) renderDrawer(false); }

function drawerSubs(t) {
  const list = t.source === 'past' ? (pastDocs || []) : auditDocs;
  if (!t.locationKey) return list.filter(d => d.id === t.deliveryId);
  return list.filter(d => d.election_id === t.electionId && d.location_key === t.locationKey).sort(newestFirst);
}

function renderDrawer(scroll) {
  const t = drawerTarget;
  const body = document.getElementById('admDrawerBody');
  const subs = drawerSubs(t);
  const m = manifestData.find(x => x.election_id === t.electionId && x.location_key === t.locationKey);
  const first = subs[0] || {};
  const name = (m && m.location_name) || first.location_name || 'Record';
  const address = (m && m.address) || first.address || '';
  document.getElementById('admDrawerTitle').textContent = name;

  const live = subs.filter(d => !d.deleted);
  const head = `
    <div class="adm-d-meta">
      ${m && m.route.label ? `<div><strong>Stop ${escapeHtml(m.route.label)}</strong></div>` : ''}
      ${address ? `<div><a class="map-link" href="${mapsUrl(address)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(address)} in maps (new tab)">&#x1F4CD; ${escapeHtml(address)}</a></div>` : ''}
      <div>${escapeHtml(precinctText(m || first))}</div>
      ${m ? `<div class="adm-small">${m.slots.length} seal${m.slots.length === 1 ? '' : 's'} expected &middot; ${m.ballot_boxes || 0} ballot box${m.ballot_boxes === 1 ? '' : 'es'}${m.supplies.length ? ' &middot; supplies: ' + m.supplies.map(s => `${escapeHtml(s.label)} ${s.qty}`).join(', ') : ''}</div>` : ''}
      ${m && m.contacts.length ? `<details class="adm-d-contacts"><summary>Contacts (${m.contacts.length})</summary>${m.contacts.map(c => `<div class="adm-small">${escapeHtml(c)}</div>`).join('')}</details>` : ''}
    </div>
    <div class="adm-d-summary">${live.length ? `${live.length} record${live.length === 1 ? '' : 's'} for this stop${live.length > 1 ? ' &middot; <strong>submitted more than once: the newest is listed first</strong>' : ''}` : badge('OUTSTANDING') + ' No delivery recorded for this stop yet.'}</div>`;

  body.innerHTML = head + subs.map(d => subCard(d, t)).join('')
    + (t.locationKey && t.source !== 'past' ? `<h3 class="adm-d-h">Seal checks at this location</h3><div id="admDrawerChecks" class="adm-small">Loading...</div>` : '');

  body.querySelectorAll('img[data-photo-path]').forEach(loadPhoto);
  body.querySelectorAll('[data-history-for]').forEach(loadHistory);
  if (t.locationKey && t.source !== 'past') loadDrawerChecks(t);
  if (scroll) {
    const focus = t.deliveryId && body.querySelector(`[data-sub="${CSS.escape(t.deliveryId)}"]`);
    if (focus) focus.scrollIntoView({ block: 'start' }); else document.getElementById('admDrawer').scrollTop = 0;
  }
}

function subCard(d, t) {
  const activeIds = new Set(activeElectionIds());
  const editable = t.source !== 'past' && activeIds.has(d.election_id);
  const focused = t.deliveryId === d.id;
  const seals = Array.isArray(d.seals) ? `
    <table class="adm-mini"><thead><tr><th scope="col">Precinct</th><th scope="col">Machine</th><th scope="col">Serial</th><th scope="col">Expected seal</th><th scope="col">Scanned</th></tr></thead><tbody>
    ${d.seals.map(s => `<tr><td>${escapeHtml(s.precinct)}</td><td>${escapeHtml(s.machine)}</td><td>${escapeHtml(s.serial)}</td><td><code>${escapeHtml(s.expected)}</code></td><td>${s.scanned ? '<span class="adm-ok">&#x2705; Yes</span>' : '<span class="adm-bad">&#x274C; Missing</span>'}</td></tr>`).join('')}
    </tbody></table>
    ${(d.unexpected_seals || []).length ? `<div class="adm-unexpected"><strong>Unexpected seals scanned:</strong>${d.unexpected_seals.map(u => `<div><code>${escapeHtml(u.code)}</code>${u.belongs_to ? ` &mdash; belongs to <strong>${escapeHtml(locName(u.belongs_to))}</strong>` : ' &mdash; not in this election'}${u.added_by ? ` <span class="adm-small">(added by ${escapeHtml(u.added_by)})</span>` : ''}</div>`).join('')}</div>` : ''}
    ${Array.isArray(d.scans) && d.scans.length ? `<div class="adm-small">How seals were entered: ${d.scans.map(s => `${escapeHtml(s.code)} (${escapeHtml(s.source)}${s.engine ? ', ' + escapeHtml(s.engine) : ''}${s.added_by ? ', by ' + escapeHtml(s.added_by) : ''})`).join('; ')}</div>` : ''}`
    : `<div>Scanned <code>${escapeHtml(d.scanned_barcode)}</code>, expected <code>${escapeHtml(d.expected_barcode)}</code> (older single-seal record)</div>`;
  const supplies = Array.isArray(d.supplies) && d.supplies.length ? `<div class="adm-d-row"><span class="adm-d-k">Supplies</span><span>${badge(d.supplies_status)} ${d.supplies.map(x => `<span class="adm-small adm-nowrap">${escapeHtml(x.label)} ${x.delivered_qty}/${x.expected}${x.delivered ? '' : ' &#x26A0;&#xFE0F;'}</span>`).join(' &middot; ')}</span></div>` : '';
  const gps = hasGps(d)
    ? `<a class="map-link" href="${mapsUrl(d.gps.lat + ',' + d.gps.lon)}" target="_blank" rel="noopener noreferrer" aria-label="Open delivery GPS location in maps (new tab)">${d.gps.lat.toFixed(5)}, ${d.gps.lon.toFixed(5)}</a>`
    : '<span class="adm-missing">Not recorded</span>';
  const photo = d.photo_path ? `<img class="adm-photo" alt="Delivery photo for ${escapeHtml(d.location_name)}" data-photo-path="${escapeHtml(d.photo_path)}">`
    : d.photo_url ? `<a href="${escapeHtml(d.photo_url)}" target="_blank" rel="noopener noreferrer"><img class="adm-photo" alt="Delivery photo for ${escapeHtml(d.location_name)}" src="${escapeHtml(d.photo_url)}"></a>`
    : '<span class="adm-missing">No photo</span>';
  const legacy = !Array.isArray(d.seals);
  const actions = !editable ? '<div class="adm-small">Read only (not the active election).</div>'
    : d.deleted
      ? `<button type="button" class="btn btn-small btn-outline" onclick="setDeleted('${escapeHtml(d.id)}', false)">Restore</button>`
      : `<button type="button" class="btn btn-small" onclick="openEditDialog('${escapeHtml(d.id)}')">${legacy ? 'Edit notes' : 'Edit'}</button>
         <button type="button" class="btn btn-small btn-outline" onclick="setDeleted('${escapeHtml(d.id)}', true)">Delete</button>`;

  return `<section class="adm-sub-card${focused ? ' focused' : ''}${d.deleted ? ' deleted' : ''}" data-sub="${escapeHtml(d.id)}" aria-label="Delivery record ${escapeHtml(fmtTime(d.timestamp))}">
    <div class="adm-sub-head">
      <div>${d.deleted ? badge('DELETED') + ' ' : ''}${badge(d.match_status)}${d.status_overridden ? ` <span class="adm-small">override; computed ${escapeHtml(d.computed_status || '?')}</span>` : ''}</div>
      <div class="adm-small">${escapeHtml(fmtTime(d.timestamp))} &middot; ${escapeHtml(d.driver_email)}</div>
    </div>
    ${d.deleted ? `<div class="alert alert-warning" style="display:block;">Deleted by ${escapeHtml(d.deleted_by)} ${escapeHtml(fmtTime(d.deleted_at))}. Reason: ${escapeHtml(d.delete_reason)}</div>` : ''}
    ${seals}
    ${supplies}
    <div class="adm-d-row"><span class="adm-d-k">Notes</span><span>${d.notes ? escapeHtml(d.notes) : '<span class="adm-missing">None</span>'}</span></div>
    <div class="adm-d-row"><span class="adm-d-k">GPS</span><span>${gps}</span></div>
    <div class="adm-d-row"><span class="adm-d-k">Photo</span><span>${photo}</span></div>
    <div class="adm-d-row"><span class="adm-d-k">Record ID</span><span class="adm-small"><code>${escapeHtml(d.id)}</code>${d.election_name ? ' &middot; ' + escapeHtml(d.election_name) : ''}</span></div>
    <div class="adm-sub-actions no-print">${actions}</div>
    <details class="adm-history"${d.edit_count > 0 ? ' open' : ''}><summary>Change history${d.edit_count > 0 ? ` (${d.edit_count})` : ''}</summary><div data-history-for="${escapeHtml(d.id)}" data-edit-count="${d.edit_count || 0}">Loading...</div></details>
  </section>`;
}

function loadPhoto(img) {
  const path = img.dataset.photoPath;
  const show = (url) => {
    img.src = url;
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Open full-size photo (new tab)');
    img.replaceWith(a);
    a.appendChild(img);
  };
  if (photoUrlCache.has(path)) return show(photoUrlCache.get(path));
  firebase.storage().ref().child(path).getDownloadURL()
    .then(url => { photoUrlCache.set(path, url); show(url); })
    .catch(err => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'adm-missing', textContent: 'Photo could not be loaded (' + err.message + ')' })); });
}

// ---------------------------------------------------------------- revision history
const FIELD_LABELS = {
  notes: 'Notes', location_name: 'Location', route: 'Stop', scans: 'Seals', match_status: 'Status',
  computed_status: 'Computed status', status_overridden: 'Status override', supplies: 'Supplies',
  supplies_status: 'Supplies status', scanned_count: 'Seals verified', deleted: 'Deleted'
};
const HIDDEN_FIELDS = new Set(['location_key', 'address', 'precincts', 'seals', 'unexpected_seals', 'expected_count', 'scanned_barcode', 'expected_barcode']);
const shortVal = (v) => v == null || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function describeRevision(x) {
  const before = x.before || {}, after = x.after || {};
  return Object.keys(after).filter(k => !HIDDEN_FIELDS.has(k)).map(k => {
    const label = FIELD_LABELS[k] || k;
    const b = before[k], a = after[k];
    if (k === 'scans') {
      const codes = (v) => new Set((v || []).map(s => normSeal(s.code)));
      const was = codes(b), now = codes(a);
      const added = [...now].filter(c => !was.has(c)), removed = [...was].filter(c => !now.has(c));
      return `${label}: ${added.length ? 'added ' + added.map(escapeHtml).join(', ') : ''}${added.length && removed.length ? '; ' : ''}${removed.length ? 'removed ' + removed.map(escapeHtml).join(', ') : ''}${!added.length && !removed.length ? 'unchanged' : ''}`;
    }
    if (k === 'supplies') {
      const was = new Map((b || []).map(s => [s.key, s]));
      const ch = (a || []).filter(s => { const o = was.get(s.key); return !o || o.delivered_qty !== s.delivered_qty; })
        .map(s => `${escapeHtml(s.label)} ${was.get(s.key) ? was.get(s.key).delivered_qty : 0}/${s.expected} &rarr; ${s.delivered_qty}/${s.expected}`);
      return `${label}: ${ch.length ? ch.join(', ') : 'unchanged'}`;
    }
    if (k === 'route') return `${label}: ${escapeHtml((b && b.label) || '(none)')} &rarr; ${escapeHtml((a && a.label) || '(none)')}`;
    if (k === 'status_overridden') return `${label}: ${a ? 'on' : 'off (Auto)'}`;
    if (k === 'deleted') return '';
    return `${label}: ${escapeHtml(shortVal(b))} &rarr; ${escapeHtml(shortVal(a))}`;
  }).filter(Boolean);
}

async function loadHistory(box) {
  const id = box.dataset.historyFor;
  const editCount = Number(box.dataset.editCount);
  const cached = historyCache.get(id);
  if (cached && cached.editCount === editCount) { box.innerHTML = cached.html; return; }
  try {
    const snap = await firebase.firestore().collection('deliveries').doc(id).collection('revisions').orderBy('at', 'desc').get();
    const html = snap.empty ? '<span class="adm-small">No changes since the driver submitted it.</span>' : snap.docs.map(r => {
      const x = r.data();
      const verb = { edit: 'Edited', delete: 'Deleted', restore: 'Restored' }[x.type] || escapeHtml(x.type);
      const lines = describeRevision(x);
      return `<div class="adm-rev"><strong>${verb}</strong> by ${escapeHtml(x.by)} &middot; ${escapeHtml(fmtTime(x.at))}<div>Reason: ${escapeHtml(x.reason)}</div>${lines.length ? `<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}</div>`;
    }).join('');
    historyCache.set(id, { editCount, html });
    box.innerHTML = html;
  } catch (err) {
    box.textContent = 'Could not load history: ' + err.message;
  }
}

async function loadDrawerChecks(t) {
  const box = document.getElementById('admDrawerChecks');
  try {
    const snap = await firebase.firestore().collection('seal_checks')
      .where('election_id', '==', t.electionId).where('location_key', '==', t.locationKey).get();
    if (drawerTarget !== t) return;
    const rows = snap.docs.map(d => d.data()).sort((a, b) => (tsMs(b.at) || 0) - (tsMs(a.at) || 0));
    const locks = rateLimits.filter(r => r.location_key === t.locationKey && r.election_id === t.electionId && (r.failed || 0) > 0);
    box.innerHTML = (locks.length ? locks.map(r => `<div class="adm-d-row"><span>${escapeHtml(uidEmail.get(r.uid) || r.uid)}: ${r.failed} miss${r.failed === 1 ? '' : 'es'}${r.failed >= MAX_SEAL_FAILS ? ' <span class="adm-badge b-bad">Locked</span>' : ''}</span><button type="button" class="btn btn-small btn-outline" onclick="resetRateLimit('${escapeHtml(r.id)}')">Reset</button></div>`).join('') : '')
      + (rows.length ? `<table class="adm-mini"><thead><tr><th scope="col">Time</th><th scope="col">Driver</th><th scope="col">Code</th><th scope="col">Result</th></tr></thead><tbody>${rows.map(c => `<tr><td class="adm-nowrap">${escapeHtml(fmtTime(c.at))}</td><td>${escapeHtml(c.email || c.uid)}</td><td><code>${escapeHtml(c.code)}</code></td><td>${c.result === 'match' ? '<span class="adm-ok">match</span>' : '<span class="adm-bad">no match</span>'}</td></tr>`).join('')}</tbody></table>` : 'No seal checks at this location yet.');
  } catch (err) {
    box.textContent = 'Could not load seal checks: ' + err.message;
  }
}

// ---------------------------------------------------------------- CSV export (Playbook section 7)
// A cell starting with = + - @ (or tab/CR) is run as a formula by Excel; prefix text cells with '.
function csvCell(v) {
  if (v == null) return '""';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const toCsv = (headers, rows) => [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

function custodyCsv(rows) {
  return toCsv(['Delivery ID', 'Timestamp (UTC)', 'Local Time (Eastern)', 'Route', 'Day', 'Election', 'Precinct', 'Location', 'Address',
    'Scanned Seal', 'Expected Seal', 'Expected Count', 'Scanned Count', 'Missing Seals', 'Unexpected Seals', 'Status', 'Computed Status',
    'Status Overridden', 'Edit Count', 'Last Edited By', 'Supplies Status', 'Supplies Short', 'Driver', 'Notes', 'Latitude', 'Longitude',
    'Map Link', 'Photo Path', 'Photo URL (older records)'],
  rows.map(d => [
    d.id, tsMs(d.timestamp) ? new Date(tsMs(d.timestamp)).toISOString() : '', fmtTimeFull(d.timestamp),
    (d.route && d.route.label) || '', d.route && d.route.day != null ? d.route.day : '',
    d.election_name || '',
    Array.isArray(d.precincts) ? d.precincts.map(p => `${p.name} (${p.num})`).join('; ') : (d.precinct || ''),
    d.location_name || '', d.address || '',
    d.scanned_barcode || '', d.expected_barcode || '',
    d.expected_count != null ? d.expected_count : '', d.scanned_count != null ? d.scanned_count : '',
    Array.isArray(d.seals) ? d.seals.filter(x => !x.scanned).map(x => x.expected).join('|') : '',
    Array.isArray(d.unexpected_seals) ? d.unexpected_seals.map(x => x.code).join('|') : '',
    d.match_status || '', d.computed_status || d.match_status || '', d.status_overridden ? 'yes' : '',
    d.edit_count || 0, d.last_edited_by || '',
    d.supplies_status || '',
    Array.isArray(d.supplies) ? d.supplies.filter(x => !x.delivered).map(x => `${x.label} ${x.delivered_qty}/${x.expected}`).join('; ') : '',
    d.driver_email || '', d.notes || '',
    hasGps(d) ? d.gps.lat : '', hasGps(d) ? d.gps.lon : '',
    hasGps(d) ? mapsUrl(d.gps.lat + ',' + d.gps.lon) : '',
    d.photo_path || '', d.photo_url || ''
  ]));
}

function stopsCsv(rows) {
  return toCsv(['Route', 'Day', 'Location', 'Address', 'Precincts', 'Stop Status', 'Records', 'Latest Delivery (Eastern)', 'Driver',
    'Scanned Count', 'Expected Count', 'Supplies Status', 'Latest Delivery ID'],
  rows.map(r => [
    r.m.route.label || '', r.m.route.day != null ? r.m.route.day : '', r.m.location_name, r.m.address,
    r.m.precincts.map(p => `${p.name} (${p.num})`).join('; '),
    r.latest ? r.state : 'NOT DELIVERED', r.subs.length,
    r.latest ? fmtTimeFull(r.latest.timestamp) : '', r.latest ? r.latest.driver_email : '',
    r.latest ? r.latest.scanned_count : '', r.latest ? r.latest.expected_count : r.m.slots.length,
    r.latest ? (r.latest.supplies_status || '') : '', r.latest ? r.latest.id : ''
  ]));
}

function adminExportCSV() {
  const view = TABS[adminTab]();
  const csv = view.csv && view.csv();
  if (!csv || !view.rows.length) { alert('Nothing to export with the current filters.'); return; }
  const names = { stops: 'Stops', subs: 'ChainOfCustody', drivers: 'Drivers', seals: 'SealChecks', deleted: 'Deleted', past: 'PastElections' };
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `HCEC_${names[adminTab]}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- election import
let importPreviewOk = false;

const readFileText = (id) => {
  const f = document.getElementById(id).files[0];
  return f ? f.text() : Promise.resolve(null);
};

function renderImportResult(r, committed) {
  const dayText = Object.keys(r.days || {}).map(d => `Day ${d}: ${r.days[d]} stops`).join(', ');
  const supplyText = Object.keys(r.supplyTotals || {}).map(k => `${escapeHtml(k)} ${r.supplyTotals[k]}`).join(' &middot; ');
  const li = (a) => a.length ? `<ul>${a.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
  const warn = [].concat(
    r.unassigned.length ? ['Machines with no matching precinct: ' + r.unassigned.join(', ')] : [],
    r.noMachineBuildings.length ? ['Locations with no machines: ' + r.noMachineBuildings.join(', ')] : [],
    r.warnings);
  document.getElementById('importResult').innerHTML = `
    <div class="alert ${warn.length ? 'alert-warning' : 'alert-success'}" style="display:block;">
      <strong>${committed ? 'Published' : 'Preview'}:</strong> ${escapeHtml(r.election.name)} (${escapeHtml(r.election.date)}) &mdash;
      ${r.buildings} locations, ${r.seals} seals.
      ${dayText ? `<br>${escapeHtml(dayText)}` : ''}
      ${supplyText ? `<br><small>Supplies: ${supplyText}</small>` : ''}
      ${warn.length ? '<br><strong>Check these:</strong>' + li(warn) : ''}
    </div>`;
}

async function runImport(commit) {
  const out = document.getElementById('importResult');
  const btnP = document.getElementById('btnImportPreview'), btnC = document.getElementById('btnImportPublish');
  try {
    const [machineCsv, precinctCsv, scheduleCsv] = await Promise.all([readFileText('importMachine'), readFileText('importPrecinct'), readFileText('importSchedule')]);
    if (!machineCsv || !precinctCsv || !scheduleCsv) { out.innerHTML = '<div class="alert alert-danger" style="display:block;">Choose all three export files first (machine data, precincts, delivery schedule).</div>'; return; }
    if (commit && !confirm('Publish this election? It replaces any previous import of the same election and becomes the active election.')) return;
    btnP.disabled = btnC.disabled = true;
    out.textContent = commit ? 'Publishing...' : 'Checking...';
    const res = await callFn('importElection', { machineCsv, precinctCsv, scheduleCsv, commit }, { timeout: 120000 });
    renderImportResult(res.data, commit);
    importPreviewOk = !commit;
    if (commit) { manifestReady = loadElections(); loadElectionList(); }
  } catch (err) {
    importPreviewOk = false;
    out.innerHTML = `<div class="alert alert-danger" style="display:block;">Import failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    btnP.disabled = false;
    btnC.disabled = !importPreviewOk;
  }
}

function invalidateImportPreview() {
  importPreviewOk = false;
  document.getElementById('btnImportPublish').disabled = true;
}

async function loadElectionList() {
  const el = document.getElementById('electionList');
  try {
    const snap = await firebase.firestore().collection('elections').get();
    if (snap.empty) { el.textContent = 'No elections imported yet.'; return; }
    el.innerHTML = snap.docs.map(d => d.data()).sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map(e => `<div>${e.active ? '&#x2705; <strong>Active</strong>' : '&#x23F8;&#xFE0F; Inactive'} &mdash; ${escapeHtml(e.name)} (${escapeHtml(e.date)}), ${e.location_count || '?'} locations, ${e.seal_count || '?'} seals</div>`).join('');
  } catch (err) {
    el.textContent = 'Could not load elections: ' + err.message;
  }
}

// ---------------------------------------------------------------- clear test data
let clearChecked = null;   // { election, counts } from the last check of the selected election

async function loadClearCard() {
  const sel = document.getElementById('clearElection');
  const keep = sel.value;
  try {
    const snap = await firebase.firestore().collection('elections').get();
    const list = snap.docs.map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (b.active === true) - (a.active === true) || String(b.date).localeCompare(String(a.date)));
    sel.innerHTML = list.length
      ? list.map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} (${escapeHtml(e.date)})${e.active ? ' &mdash; active' : ''}</option>`).join('')
      : '<option value="">No elections imported yet</option>';
    if (keep && list.some(e => e.id === keep)) sel.value = keep;
  } catch (err) {
    sel.innerHTML = '<option value="">Could not load elections</option>';
  }
  resetClearCard();
  loadClearHistory();
}

function resetClearCard() {
  clearChecked = null;
  document.getElementById('clearResult').innerHTML = '';
  document.getElementById('clearConfirmBox').hidden = true;
  document.getElementById('clearReason').value = '';
  document.getElementById('clearConfirm').value = '';
  updateClearButton();
}

function updateClearButton() {
  const ok = !!clearChecked
    && document.getElementById('clearConfirm').value.trim() === clearChecked.election.id
    && document.getElementById('clearReason').value.trim().length >= 3;
  document.getElementById('btnClearRun').disabled = !ok;
}

const clearCountText = (c) => [
  `${c.deliveries} delivery record${c.deliveries === 1 ? '' : 's'}`,
  `${c.seal_checks} seal check${c.seal_checks === 1 ? '' : 's'}`,
  `${c.lockouts} driver lockout counter${c.lockouts === 1 ? '' : 's'}`,
  `${c.photos} photo${c.photos === 1 ? '' : 's'}`
].join(', ');

async function runClearTestData(commit) {
  const electionId = document.getElementById('clearElection').value;
  const out = document.getElementById('clearResult');
  const btnCheck = document.getElementById('btnClearCheck'), btnRun = document.getElementById('btnClearRun');
  if (!electionId) { out.innerHTML = '<div class="alert alert-danger" style="display:block;">Choose an election first.</div>'; return; }
  const data = { electionId, commit };
  if (commit) {
    if (!clearChecked || clearChecked.election.id !== electionId) return;
    data.confirm = document.getElementById('clearConfirm').value.trim();
    data.reason = document.getElementById('clearReason').value.trim();
    if (!confirm(`Clear the test data for ${clearChecked.election.name}? This removes ${clearCountText(clearChecked.counts)}. A backup copy is kept, but only a technical restore can bring them back.`)) return;
  }
  btnCheck.disabled = btnRun.disabled = true;
  out.textContent = commit ? 'Saving a backup and clearing. This can take a few minutes; keep this page open...' : 'Checking...';
  try {
    const r = (await callFn('clearTestData', data, { timeout: 540000 })).data;
    if (!commit) {
      clearChecked = r;
      const empty = !r.counts.deliveries && !r.counts.seal_checks && !r.counts.lockouts && !r.counts.photos;
      out.innerHTML = `<div class="alert alert-warning" style="display:block;">
        <strong>${escapeHtml(r.election.name)} (${escapeHtml(r.election.date)}):</strong> ${empty ? 'there is no test data to clear.' : `this will remove ${escapeHtml(clearCountText(r.counts))}.`}
        <br><small>Make sure every practice delivery is finished and no driver is out making real deliveries.</small></div>`;
      document.getElementById('clearConfirmId').textContent = r.election.id;
      document.getElementById('clearConfirmBox').hidden = empty;
    } else {
      out.innerHTML = `<div class="alert alert-success" style="display:block;">
        <strong>Cleared:</strong> ${escapeHtml(clearCountText(r.counts))}.${r.photosMissing ? ` (${r.photosMissing} photo${r.photosMissing === 1 ? ' was' : 's were'} already gone.)` : ''}
        <br>The stop list and seal numbers were kept, so drivers can start real deliveries now. Practice deliveries still waiting on a phone will be turned away and set aside.
        <br><small>Backup: ${escapeHtml(r.backupPath)} in Firebase Storage.</small></div>`;
      clearChecked = null;
      document.getElementById('clearConfirmBox').hidden = true;
      sealChecks = null; pastDocs = null;
      renderAdminAll();
      loadClearHistory();
    }
  } catch (err) {
    out.innerHTML = `<div class="alert alert-danger" style="display:block;">${commit ? 'Clear failed' : 'Check failed'}: ${escapeHtml(err.message)}</div>`;
  } finally {
    btnCheck.disabled = false;
    updateClearButton();
  }
}

async function loadClearHistory() {
  const el = document.getElementById('clearHistory');
  const electionId = document.getElementById('clearElection').value;
  if (!electionId) { el.textContent = 'Choose an election.'; return; }
  el.textContent = 'Loading...';
  try {
    const ref = firebase.firestore().collection('test_data_clears').doc(electionId);
    const [runs, late] = await Promise.all([ref.collection('runs').orderBy('at', 'desc').limit(10).get(), ref.collection('late').get()]);
    if (document.getElementById('clearElection').value !== electionId) return;
    const rows = runs.docs.map(d => d.data()).map(x => `<div>${escapeHtml(fmtTime(x.at))} by ${escapeHtml(x.by)}: ${escapeHtml(x.reason)} <span class="adm-note">(${escapeHtml(clearCountText(x.counts || {}))})</span></div>`);
    if (late.size) rows.push(`<div class="alert alert-warning" style="display:block; margin-top: 8px;">${late.size} practice deliver${late.size === 1 ? 'y' : 'ies'} reached the server from a phone after a clear and ${late.size === 1 ? 'was' : 'were'} set aside, not recorded.</div>`);
    el.innerHTML = rows.length ? rows.join('') : 'This election has not been cleared.';
  } catch (err) {
    el.textContent = 'Could not load the log: ' + err.message;
  }
}

// ---------------------------------------------------------------- edit / soft delete
let editingId = null;

const scanCodesOf = (d) => Array.isArray(d.scans) ? d.scans.map(s => s.code)
  : String(d.scanned_barcode || '').split('|').map(c => c.trim()).filter(Boolean);
const sameCodeSet = (a, b) => {
  const ka = new Set(a.map(normSeal)), kb = new Set(b.map(normSeal));
  return ka.size === kb.size && [...ka].every(k => kb.has(k));
};

function setEditError(msg) {
  const el = document.getElementById('editError');
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function openEditDialog(id) {
  const d = auditDocs.find(x => x.id === id);
  if (!d) return;
  editingId = id;
  const legacy = !Array.isArray(d.seals);
  setEditError('');

  const sel = document.getElementById('editLocation');
  sel.innerHTML = manifestData.filter(l => l.election_id === d.election_id)
    .map(l => `<option value="${escapeHtml(l.location_key)}">${escapeHtml((l.route.label ? l.route.label + ' - ' : '') + l.location_name)}</option>`).join('');
  sel.value = d.location_key || '';
  document.getElementById('editScans').value = scanCodesOf(d).join('\n');
  document.getElementById('editNotes').value = d.notes || '';
  document.getElementById('editStatus').value = d.status_overridden ? d.match_status : 'auto';
  document.getElementById('editReason').value = '';
  const hasSupplies = !legacy && Array.isArray(d.supplies) && d.supplies.length > 0;
  document.getElementById('editSuppliesBox').style.display = hasSupplies ? '' : 'none';
  document.getElementById('editSupplies').innerHTML = hasSupplies ? d.supplies.map(x => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0;">
      <span>${escapeHtml(x.label)} &mdash; ${x.expected}</span>
      <span><label style="display:inline !important;"><input type="checkbox" data-edit-supply="${escapeHtml(x.key)}" ${x.delivered ? 'checked' : ''}> Delivered</label>
      Qty <input type="number" min="0" max="${x.expected}" value="${x.delivered_qty}" data-edit-supply-qty="${escapeHtml(x.key)}" style="width:64px;" aria-label="${escapeHtml(x.label)} quantity delivered"></span>
    </div>`).join('') : '';
  ['editLocation', 'editScans', 'editStatus'].forEach(i => { document.getElementById(i).disabled = legacy; });
  document.getElementById('editLegacyNote').style.display = legacy ? 'block' : 'none';
  document.getElementById('editSummary').innerHTML =
    `<strong>${escapeHtml(d.location_name)}</strong> &middot; status ${statusBadge(d.match_status)}` +
    (d.status_overridden ? ` (override; computed ${escapeHtml(d.computed_status || '?')})` : '');
  document.getElementById('editDialog').showModal();
}

async function saveEdit() {
  const d = auditDocs.find(x => x.id === editingId);
  if (!d) return;
  const legacy = !Array.isArray(d.seals);
  const reason = document.getElementById('editReason').value.trim();
  const patch = {};

  const notes = document.getElementById('editNotes').value.trim();
  if (notes !== (d.notes || '')) patch.notes = notes;
  if (!legacy) {
    const loc = document.getElementById('editLocation').value;
    if (loc && loc !== d.location_key) patch.locationKey = loc;
    const codes = document.getElementById('editScans').value.split('\n').map(c => c.trim()).filter(Boolean);
    if (!sameCodeSet(codes, scanCodesOf(d))) patch.scans = codes;
    if (Array.isArray(d.supplies) && d.supplies.length) {
      const next = d.supplies.map(x => {
        const cb = document.querySelector(`input[data-edit-supply="${CSS.escape(x.key)}"]`);
        const q = document.querySelector(`input[data-edit-supply-qty="${CSS.escape(x.key)}"]`);
        const delivered = cb ? cb.checked : x.delivered;
        return delivered ? { key: x.key, delivered: true } : { key: x.key, delivered: false, qty: Math.max(0, Math.min(x.expected, Math.floor(Number(q && q.value) || 0))) };
      });
      const changed = d.supplies.some((x, i) => {
        const n = next[i];
        const nowDelivered = n.delivered || n.qty >= x.expected;
        const nowQty = n.delivered ? x.expected : n.qty;
        return nowDelivered !== x.delivered || nowQty !== x.delivered_qty;
      });
      if (changed) patch.supplies = next;
    }
    const st = document.getElementById('editStatus').value;
    const initial = d.status_overridden ? d.match_status : 'auto';
    if (st !== initial) patch.statusOverride = st === 'auto' ? null : st;
  }
  if (!Object.keys(patch).length) return setEditError('No changes to save.');
  if (reason.length < 3) return setEditError('Please enter a reason (at least 3 characters).');

  const btn = document.getElementById('btnEditSave');
  btn.disabled = true;
  setEditError('');
  try {
    const res = await callFn('adminUpdateDelivery', { deliveryId: d.id, baseEditCount: d.edit_count || 0, reason, patch });
    document.getElementById('editDialog').close();
    if (patch.locationKey && drawerTarget) drawerTarget = { ...drawerTarget, locationKey: patch.locationKey, deliveryId: d.id };
    if (res.data.status_overridden && res.data.match_status !== res.data.computed_status) {
      alert(`Saved. The status is overridden to ${res.data.match_status} (computed: ${res.data.computed_status}).`);
    }
  } catch (err) {
    setEditError(err.code === 'functions/aborted'
      ? 'This record was changed by someone else. Close this window, wait a moment, and reopen it.'
      : err.message);
  } finally {
    btn.disabled = false;
  }
}

async function setDeleted(id, deleted) {
  const d = auditDocs.find(x => x.id === id);
  if (!d) return;
  const reason = prompt(deleted
    ? `Delete the record for ${d.location_name}? It is hidden and can be restored.\nReason (required):`
    : `Restore the record for ${d.location_name}?\nReason (required):`);
  if (reason === null) return;
  if (reason.trim().length < 3) { alert('A reason of at least 3 characters is required.'); return; }
  try {
    await callFn('adminSetDeliveryDeleted', { deliveryId: id, baseEditCount: d.edit_count || 0, deleted, reason: reason.trim() });
  } catch (err) {
    alert(err.code === 'functions/aborted' ? 'This record was changed by someone else. Try again in a moment.' : err.message);
  }
}
