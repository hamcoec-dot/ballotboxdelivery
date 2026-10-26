// Truck loadout list (driver side). Two ways to use it:
//   - By day: every stop on a delivery day with what goes on the truck for it, so drivers can load a trip
//     without opening each stop.
//   - My load (custom): the driver hand-picks stops from any day with "On truck". That load has its own
//     loadout totals and its own delivery order, which the driver can rearrange and then work through.
//
// Stops come from manifestData (already loaded and cached offline by Firestore). What every driver sees of
// each other's work comes from elections/{eid}/stop_status (see functions/src/stopstatus.js): which truck a
// stop is on, and whether a chain of custody record exists for it. A stop is delivered only when a custody
// record exists: on the server, or recorded on this phone and still waiting in its offline queue.
// The load itself (picks and the chosen order) is kept in localStorage so it works with no signal; whenever
// the phone hears from the server, the shared status wins.

let loadoutDay = null;
let loadoutHideDelivered = true;
let loadoutTruckTab = 'add';    // My Load steps: 'add' = 1 build the load, 'load' = 2 load details, 'order' = 3 deliver

const loadoutKey = () => `hcec_loadout_${selectedElection ? selectedElection.id : ''}_${currentAccount ? currentAccount.uid : ''}`;

function loadoutState() {
  try {
    const s = JSON.parse(storeGet(loadoutKey()) || '{}');
    return { loaded: s.loaded || {}, delivered: s.delivered || {}, order: Array.isArray(s.order) ? s.order : [] };
  } catch (e) { return { loaded: {}, delivered: {}, order: [] }; }
}
function loadoutSave(s) { storeSet(loadoutKey(), JSON.stringify(s)); }

let loadoutOpenedKey = null;   // stop opened from this page, so the driver comes back here after recording it

// ---- shared status (live from Firestore, cached offline)
let loShared = {};          // location_key -> { truck_uid, truck_name, delivered_at, delivered_by, ... }
let loSharedSig = '';
let loWatchId = null;
let loUnsub = null;
let loTaken = [];           // stops another driver took off this load: [{ name, by }]

const loMe = () => (currentAccount ? currentAccount.uid : '');

// When the stop got its custody record (a Date), or null. Local marks only cover deliveries recorded on this
// phone that the server has not confirmed yet.
function loDoneAt(s, key) {
  const sh = loShared[key];
  if (sh && sh.delivered_at) return typeof sh.delivered_at.toDate === 'function' ? sh.delivered_at.toDate() : new Date();
  return s.delivered[key] ? new Date(s.delivered[key]) : null;
}
// Name of the other driver whose truck the stop is on, or ''.
function loOtherTruck(s, key) {
  const sh = loShared[key];
  return sh && sh.truck_uid && sh.truck_uid !== loMe() && !loDoneAt(s, key) ? (sh.truck_name || 'another driver') : '';
}

function loadoutUnwatch() {
  if (loUnsub) loUnsub();
  loUnsub = null; loWatchId = null; loShared = {}; loSharedSig = ''; loTaken = [];
}

// Listen to the shared status for the selected election (called whenever the stop list renders).
function loadoutWatch() {
  if (typeof firebase === 'undefined' || !selectedElection || !currentAccount) return;
  const id = selectedElection.id + '/' + currentAccount.uid;
  if (loWatchId === id) return;
  loadoutUnwatch();
  loWatchId = id;
  loUnsub = firebase.firestore().collection('elections').doc(selectedElection.id).collection('stop_status')
    .onSnapshot({ includeMetadataChanges: true }, (snap) => {
      const next = {};
      snap.forEach(d => { next[d.id] = d.data(); });
      loShared = next;
      const sig = Object.keys(next).sort().map(k => `${k}:${next[k].truck_uid || ''}:${next[k].delivery_id || ''}`).join('|');
      const fresh = !snap.metadata.fromCache;
      if (fresh) loadoutReconcile().then(changed => { if (changed || sig !== loSharedSig) { loSharedSig = sig; loadoutRefresh(); } });
      else if (sig !== loSharedSig) { loSharedSig = sig; loadoutRefresh(); }
    }, (err) => { console.warn('Shared stop status unavailable:', err); });
}

// Location keys with a custody record saved on this phone that has not reached the server yet.
async function loPendingKeys() {
  try {
    if (typeof idbAll !== 'function') return new Set();
    return new Set((await idbAll()).filter(x => x.uid === loMe() && !x.failed && x.payload && x.payload.electionId === selectedElection.id)
      .map(x => x.payload.locationKey));
  } catch (e) { return new Set(); }
}

// With a fresh server snapshot the shared status is the truth: this phone's load is exactly the stops on
// this driver's truck, and a local delivered mark stays only while its record is still queued here.
async function loadoutReconcile() {
  if (!selectedElection) return false;
  const s = loadoutState();
  const pending = await loPendingKeys();
  const before = JSON.stringify(s);
  const names = new Map(loadoutStops().map(i => [i.location_key, i.location_name]));
  Object.keys(s.delivered).forEach(k => { if (!pending.has(k)) delete s.delivered[k]; });
  Object.keys(s.loaded).forEach(k => {
    const sh = loShared[k] || {};
    if (sh.truck_uid === loMe() && !sh.delivered_at) return;
    if (sh.truck_uid && sh.truck_uid !== loMe() && !sh.delivered_at) loTaken.push({ name: names.get(k) || k, by: sh.truck_name || 'another driver' });
    delete s.loaded[k];
  });
  Object.keys(loShared).forEach(k => {
    const sh = loShared[k];
    if (sh.truck_uid === loMe() && !sh.delivered_at && !s.loaded[k] && !pending.has(k) && names.has(k)) { s.loaded[k] = true; s.order.push(k); }
  });
  s.order = s.order.filter((k, n) => s.loaded[k] && s.order.indexOf(k) === n);
  if (JSON.stringify(s) === before) return false;
  loadoutSave(s);
  return true;
}

// Put a stop on this driver's truck for everyone to see, or take it off. Fire and forget: Firestore queues
// the write while offline, and the shared status corrects the load if the server refuses it.
function loadoutShareTruck(key, on) {
  try {
    if (typeof firebase === 'undefined' || !selectedElection || !currentAccount) return;
    const sh = loShared[key] || {};
    if (!on && sh.truck_uid !== loMe()) return;      // only your own flag (the rules refuse anything else)
    if (on && sh.truck_uid === loMe()) return;
    const FV = firebase.firestore.FieldValue;
    const data = on
      ? { truck_uid: loMe(), truck_name: String(currentAccount.email || '').split('@')[0], truck_at: FV.serverTimestamp() }
      : { truck_uid: FV.delete(), truck_name: FV.delete(), truck_at: FV.delete() };
    firebase.firestore().collection('elections').doc(selectedElection.id).collection('stop_status').doc(key)
      .set(data, { merge: true }).catch(e => console.warn('Could not update truck status:', e));
  } catch (e) { console.warn('Could not update truck status:', e); }
}

// Redraw whatever is on screen after the shared status changed, keeping the driver's search and place.
function loadoutRefresh() {
  loadoutUpdateEntryButton();
  const lo = document.getElementById('viewLoadout');
  if (lo && lo.classList.contains('active')) {
    const search = document.getElementById('loPickSearch');
    const q = search ? search.value : '';
    const focused = search && document.activeElement === search;
    const y = window.scrollY;
    renderLoadout();
    const again = document.getElementById('loPickSearch');
    if (again && q) { again.value = q; loadoutFilterPicker(); }
    if (again && focused) again.focus({ preventScroll: true });
    window.scrollTo(0, y);
  }
  const list = document.getElementById('viewPollingPlaces');
  if (list && list.classList.contains('active') && typeof renderPollingPlaces === 'function') {
    const y = window.scrollY;
    renderPollingPlaces();
    window.scrollTo(0, y);
  }
}

// One line for a stop card on the main stop list: delivered, or on whose truck.
function loadoutStatusHtml(item) {
  const s = loadoutState();
  const done = loDoneAt(s, item.location_key);
  if (done) {
    const by = (loShared[item.location_key] || {}).delivered_by;
    return `<p class="lo-status lo-status-done"><span aria-hidden="true">&#x2705;</span> Delivered ${escapeHtml(done.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}${by ? ` by ${escapeHtml(by)}` : ''}</p>`;
  }
  const other = loOtherTruck(s, item.location_key);
  if (other) return `<p class="lo-status lo-status-taken"><span aria-hidden="true">&#x1F69A;</span> On ${escapeHtml(other)}'s truck</p>`;
  if (s.loaded[item.location_key]) return `<p class="lo-status lo-status-mine"><span aria-hidden="true">&#x1F69A;</span> On your truck</p>`;
  return '';
}

// Ask before taking a stop that is on another driver's truck. True when it is fine to add.
function loadoutConfirmTake(key) {
  const other = loOtherTruck(loadoutState(), key);
  if (!other) return true;
  const stop = loadoutStops().find(i => i.location_key === key);
  return confirm(`${stop ? stop.location_name : 'This stop'} is already on ${other}'s truck. Move it to your load instead?`);
}

// Called after a custody record is recorded or saved for later sync on this phone: it is off the truck.
// Returns the view to go back to.
function loadoutAfterDelivery(locationKey) {
  let back = false;
  try {
    const s = loadoutState();
    s.delivered[locationKey] = new Date().toISOString();
    delete s.loaded[locationKey];
    s.order = s.order.filter(k => k !== locationKey);
    loadoutSave(s);
    back = loadoutOpenedKey === locationKey;
    loadoutOpenedKey = null;
    if (back) renderLoadout();
    loadoutUpdateEntryButton();
  } catch (e) { /* never block a delivery */ }
  return back ? 'viewLoadout' : 'viewPollingPlaces';
}

function loadoutStops() {
  return manifestData.filter(i => selectedElection && i.election_id === selectedElection.id);
}

// The stops in this custom load, in the driver's chosen order. Anything picked but not yet in the saved
// order (just ticked, or ticked by an older version) falls in at the end, in route order.
function loadoutPicks(all, s) {
  const picks = all.filter(i => s.loaded[i.location_key] && !loDoneAt(s, i.location_key));
  const rank = k => { const n = s.order.indexOf(k); return n === -1 ? Number.MAX_SAFE_INTEGER : n; };
  return picks
    .map((i, n) => ({ i, n }))
    .sort((a, b) => (rank(a.i.location_key) - rank(b.i.location_key)) || (a.n - b.n))
    .map(x => x.i);
}

// loadoutDay is 'all', a day number, or 'truck' (My load: only the stops picked for this trip, from any day)
function openLoadout(mode) {
  const days = loadoutDays();
  if (mode === 'truck') {
    loadoutDay = 'truck';
    loadoutTruckTab = loadoutPicks(loadoutStops(), loadoutState()).length ? 'order' : 'add';
  }
  else if (dayFilter !== 'all' && days.includes(Number(dayFilter))) loadoutDay = Number(dayFilter);
  else if (loadoutDay == null) loadoutDay = 'all';
  renderLoadout();
  showView('viewLoadout');
  window.scrollTo(0, 0);
}

const loadoutDays = () => [...new Set(loadoutStops().map(i => i.route.day).filter(d => d != null))].sort((a, b) => a - b);

function setLoadoutDay(d) { loadoutDay = d; renderLoadout(); }
function setLoadoutTruckTab(t) { loadoutTruckTab = t; renderLoadout(); }

function sumLoad(stops) {
  const supplies = new Map();
  let boxes = 0, seals = 0;
  stops.forEach(i => {
    boxes += i.ballot_boxes || i.slots.length;
    seals += i.slots.length;
    i.supplies.forEach(x => {
      const t = supplies.get(x.key) || { label: x.label, qty: 0 };
      t.qty += x.qty;
      supplies.set(x.key, t);
    });
  });
  return { boxes, seals, supplies: [...supplies.values()] };
}

function loadLinesHtml(t) {
  const lines = [`<li><span>Ballot boxes / machines</span><strong>${t.boxes}</strong></li>`]
    .concat(t.supplies.map(x => `<li><span>${escapeHtml(x.label)}</span><strong>${x.qty}</strong></li>`));
  return `<ul class="lo-lines">${lines.join('')}</ul>`;
}

function loadoutStopHtml(i, s, inLoad) {
  const showDay = inLoad;
  const k = escapeHtml(i.location_key);
  const dayTag = showDay ? (i.route.day == null ? 'Unscheduled' : 'Day ' + i.route.day) + ' &middot; ' : '';
  const done = loDoneAt(s, i.location_key);
  const isDone = !!done;
  const isLoaded = !isDone && !!s.loaded[i.location_key];
  const other = loOtherTruck(s, i.location_key);
  const boxes = i.ballot_boxes || i.slots.length;
  const doneBy = isDone ? (loShared[i.location_key] || {}).delivered_by : '';
  const doneAt = isDone ? done.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const precincts = precinctListText(i);
  return `<div class="lo-stop${isLoaded ? ' loaded' : ''}${isDone ? ' delivered' : ''}${other ? ' taken' : ''}">
    <div class="stop-eyebrow">${dayTag}${i.route.label ? `Stop ${escapeHtml(i.route.label)}` : 'Unscheduled'}${precincts ? ` &middot; ${escapeHtml(precincts)}` : ''}</div>
    <h3 class="stop-name">${escapeHtml(i.location_name)}</h3>
    ${i.address ? `<p class="meta-line lo-addr">${escapeHtml(i.address)}</p>` : ''}
    <ul class="lo-lines">
      <li><span>Ballot boxes / machines</span><strong>${boxes}</strong></li>
      ${i.slots.length ? `<li class="lo-machines"><ul>${i.slots.map(m => `<li>${escapeHtml(sealLabel(m))}</li>`).join('')}</ul></li>` : ''}
      ${i.supplies.map(x => `<li><span>${escapeHtml(x.label)}</span><strong>${x.qty}</strong></li>`).join('')}
    </ul>
    ${i.slots.length !== boxes ? `<p class="hint lo-warn">&#x26A0;&#xFE0F; ${i.slots.length} machine${i.slots.length === 1 ? '' : 's'} with seals on file for ${boxes} ballot box${boxes === 1 ? '' : 'es'}</p>` : ''}
    ${isDone
      ? `<p class="lo-done-line"><span aria-hidden="true">&#x2705;</span> Delivered ${escapeHtml(doneAt)}${doneBy ? ` by ${escapeHtml(doneBy)}` : ''}</p>`
      : inLoad
      ? `<button type="button" class="btn btn-small btn-outline" data-lo-drop="${k}" aria-label="Take ${escapeHtml(i.location_name)} off this load">Take off load</button>`
      : `${other ? `<p class="lo-status lo-status-taken"><span aria-hidden="true">&#x1F69A;</span> On ${escapeHtml(other)}'s truck</p>` : ''}
         <label class="lo-check"><input type="checkbox" data-lo-load="${k}" ${isLoaded ? 'checked' : ''}> <span>On my truck</span></label>
         <div class="lo-actions">
           <button type="button" class="btn btn-small" data-lo-open="${k}" aria-label="Start delivery at ${escapeHtml(i.location_name)}">Start Delivery &rarr;</button>
         </div>`}
  </div>`;
}

// One stop in the delivery sequence for a custom load: its position, where it is, and how to move it.
function loadoutSeqHtml(i, pos, total) {
  const k = escapeHtml(i.location_key);
  const boxes = i.ballot_boxes || i.slots.length;
  const supplyCount = i.supplies.reduce((n, x) => n + x.qty, 0);
  const isNext = pos === 1;
  const mapUrl = `https://maps.google.com/?q=${encodeURIComponent(i.address || i.location_name)}`;
  return `<div class="lo-stop lo-seq${isNext ? ' lo-next' : ''}">
    <div class="lo-seq-head">
      <span class="lo-pos" aria-hidden="true">${pos}</span>
      <div class="lo-seq-main">
        ${isNext ? '<div class="lo-next-tag">Next stop</div>' : ''}
        <div class="stop-eyebrow">${i.route.day == null ? 'Unscheduled' : 'Day ' + i.route.day}${i.route.label ? ` &middot; Stop ${escapeHtml(i.route.label)}` : ''}</div>
        <h3 class="stop-name">${escapeHtml(i.location_name)}</h3>
        ${i.address ? `<p class="meta-line lo-addr"><a href="${mapUrl}" target="_blank" rel="noopener noreferrer" class="map-link">&#x1F4CD; ${escapeHtml(i.address)}</a></p>` : ''}
        <p class="meta-line">&#x1F512; ${boxes} ballot box${boxes === 1 ? '' : 'es'} / machine${boxes === 1 ? '' : 's'}${supplyCount ? ` &middot; &#x1F9F0; ${supplyCount} supply item${supplyCount === 1 ? '' : 's'}` : ''}</p>
      </div>
      <div class="lo-move" role="group" aria-label="Move ${escapeHtml(i.location_name)} in the delivery order">
        <button type="button" class="btn btn-small btn-outline" data-lo-up="${k}" ${pos === 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(i.location_name)} earlier in the delivery order">&uarr;</button>
        <button type="button" class="btn btn-small btn-outline" data-lo-down="${k}" ${pos === total ? 'disabled' : ''} aria-label="Move ${escapeHtml(i.location_name)} later in the delivery order">&darr;</button>
      </div>
    </div>
    <div class="lo-actions">
      <button type="button" class="btn btn-small" data-lo-open="${k}" aria-label="Start delivery at ${escapeHtml(i.location_name)}">Start Delivery &rarr;</button>
      <button type="button" class="btn btn-small btn-outline" data-lo-drop="${k}" aria-label="Take ${escapeHtml(i.location_name)} off this load">Take off load</button>
    </div>
  </div>`;
}

// Compact pick list for building a custom load: one short row per stop from every day, A to Z by precinct
// name (drivers know stops by precinct), with search, so a driver can pull a Day 3 stop into a Day 1 trip
// without scrolling through day-by-day cards. A place with several precincts sorts by the first one A to Z;
// a place with no precinct on file goes at the end by its own name.
const loCollate = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const loPrecinctsAZ = (i) => i.precincts.slice().sort((a, b) => loCollate(a.name || '', b.name || ''));

function loadoutPickerHtml(all, s, truck, count) {
  const open = all.filter(i => !loDoneAt(s, i.location_key))
    .map(i => ({ i, ps: loPrecinctsAZ(i) }))
    .sort((a, b) => (!a.ps.length - !b.ps.length)
      || loCollate(a.ps.length ? a.ps[0].name || '' : a.i.location_name, b.ps.length ? b.ps[0].name || '' : b.i.location_name)
      || loCollate(a.i.location_name, b.i.location_name));
  const rows = open.map(({ i, ps }) => {
    const on = !!s.loaded[i.location_key];
    const other = loOtherTruck(s, i.location_key);
    const boxes = i.ballot_boxes || i.slots.length;
    const precincts = ps.map(p => `${p.name} (${p.num})`).join(', ');
    const find = [i.location_name, i.address, i.route.label, precincts].join(' ').toLowerCase();
    return `<label class="lo-pick-row${on ? ' on' : ''}${other ? ' taken' : ''}" data-find="${escapeHtml(find)}">
      <input type="checkbox" data-lo-pick="${escapeHtml(i.location_key)}" ${on ? 'checked' : ''}>
      <span class="lo-pick-text"><strong>${escapeHtml(precincts || i.location_name)}</strong>
        ${precincts ? `<span class="lo-pick-place">${escapeHtml(i.location_name)}</span>` : ''}
        <span class="lo-pick-meta">${i.route.day == null ? 'Unscheduled' : 'Day ' + i.route.day}${i.route.label ? ` &middot; Stop ${escapeHtml(i.route.label)}` : ''} &middot; ${boxes} box${boxes === 1 ? '' : 'es'}${i.address ? ` &middot; ${escapeHtml(i.address)}` : ''}</span>
        ${other ? `<span class="lo-pick-taken"><span aria-hidden="true">&#x1F69A;</span> On ${escapeHtml(other)}'s truck</span>` : ''}</span>
    </label>`;
  }).join('');
  return `<div class="form-group" style="margin-bottom: 8px;">
      <label for="loPickSearch">Find a stop</label>
      <input type="text" id="loPickSearch" placeholder="Name, stop number, precinct or address" oninput="loadoutFilterPicker()" autocomplete="off">
    </div>
    <div class="lo-pick-list">${rows || '<p class="hint">Every stop has a custody record.</p>'}</div>
    <p class="hint" id="loPickNone" hidden>No stops match. Try part of the name or the precinct number.</p>
    <div class="lo-pick-bar" id="loPickBar" aria-live="polite">${loadoutPickBarHtml(count, truck)}</div>`;
}

function loadoutPickBarHtml(count, truck) {
  return `<span><strong>${count}</strong> stop${count === 1 ? '' : 's'} &middot; ${truck.boxes} box${truck.boxes === 1 ? '' : 'es'}</span>
    <button type="button" class="btn btn-small" ${count ? '' : 'disabled'} onclick="setLoadoutTruckTab('load')">Next: load details &rarr;</button>`;
}

function loadoutFilterPicker() {
  const q = (document.getElementById('loPickSearch').value || '').trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#viewLoadout .lo-pick-row').forEach(r => {
    const hit = !q || r.dataset.find.includes(q);
    r.hidden = !hit;
    if (hit) shown++;
  });
  document.getElementById('loPickNone').hidden = shown > 0;
}

const LO_STATUS_HINT = 'A stop shows as delivered once its chain of custody record is recorded, by any driver. Trucks and deliveries from other drivers update live; with no signal you see the last status this phone received.';

function renderLoadout() {
  const view = document.getElementById('viewLoadout');
  const all = loadoutStops();
  const days = loadoutDays();
  const s = loadoutState();
  if (loadoutDay !== 'all' && loadoutDay !== 'truck' && !days.includes(loadoutDay)) loadoutDay = 'all';
  const onTruck = loadoutPicks(all, s);
  const truck = sumLoad(onTruck);
  const isTruck = loadoutDay === 'truck';
  const scope = isTruck ? onTruck : loadoutDay === 'all' ? all : all.filter(i => i.route.day === loadoutDay);
  const left = scope.filter(i => !loDoneAt(s, i.location_key));
  const deliveredCount = scope.length - left.length;
  const remaining = sumLoad(left);
  const scopeTitle = isTruck ? 'My load' : loadoutDay === 'all' ? 'All days' : 'Day ' + loadoutDay;
  const seqTab = isTruck && loadoutTruckTab === 'order';

  const chip = (value, label) => {
    const on = String(value) === String(loadoutDay);
    return `<button type="button" class="btn btn-small${on ? '' : ' btn-outline'}" aria-pressed="${on}" onclick="setLoadoutDay(${typeof value === 'number' ? value : `'${value}'`})">${label}</button>`;
  };
  const chips = `<div class="lo-chips" role="group" aria-label="Show stops">${chip('all', 'All days')}${days.length > 1 ? days.map(d => chip(d, 'Day ' + d)).join('') : ''}${chip('truck', `<span aria-hidden="true">&#x1F69A;</span> My load (${onTruck.length})`)}</div>`;

  // Custom load: pick stops from any day, see the loadout for them, then work them in your own order.
  if (isTruck) {
    if (!onTruck.length) loadoutTruckTab = 'add';
    const step = (value, n, label) => {
      const on = loadoutTruckTab === value;
      const off = value !== 'add' && !onTruck.length;
      return `<button type="button" class="lo-step${on ? ' on' : ''}" ${on ? 'aria-current="step"' : ''} ${off ? 'disabled' : ''} onclick="setLoadoutTruckTab('${value}')"><span class="lo-step-n">${n}</span> ${label}</button>`;
    };
    const doneAll = all.filter(i => loDoneAt(s, i.location_key)).length;
    const taken = loTaken.length
      ? `<div class="alert alert-warning lo-taken" role="status"><span class="lo-taken-text"><span aria-hidden="true">&#x26A0;&#xFE0F;</span> Another driver took ${loTaken.map(t => `<strong>${escapeHtml(t.name)}</strong> (${escapeHtml(t.by)})`).join(', ')}. ${loTaken.length === 1 ? 'It is' : 'They are'} off your load.</span>
           <button type="button" class="btn btn-small btn-outline" onclick="loTaken = []; renderLoadout();">OK</button></div>`
      : '';
    let body;
    if (loadoutTruckTab === 'add') {
      body = loadoutPickerHtml(all, s, truck, onTruck.length);
    } else if (seqTab) {
      body = `<section class="lo-truck" aria-live="polite">
           <h3 class="step-title" style="margin-bottom: 8px;">Deliver in this order</h3>
           <p class="hint">Use &uarr; and &darr; to rearrange. The top stop is your next one.</p>
           <div class="lo-actions">
             <button type="button" class="btn btn-small" data-lo-open="${escapeHtml(onTruck[0].location_key)}" aria-label="Start delivery at ${escapeHtml(onTruck[0].location_name)}">Start next stop &rarr;</button>
             <button type="button" class="btn btn-small btn-outline" onclick="loadoutSortRoute()" aria-label="Put this load back in scheduled route order">Use route order</button>
           </div>
         </section>
         <div class="lo-list">${onTruck.map((i, n) => loadoutSeqHtml(i, n + 1, onTruck.length)).join('')}</div>`;
    } else {
      body = `<section class="lo-truck" aria-live="polite">
           <h3 class="step-title" style="margin-bottom: 8px;">Pull this for the load</h3>
           ${loadLinesHtml(truck)}
         </section>
         <div class="lo-list">${onTruck.map(i => loadoutStopHtml(i, s, true)).join('')}</div>
         <div class="lo-actions" style="margin-top: 12px;">
           <button type="button" class="btn btn-small" onclick="setLoadoutTruckTab('order')">Loaded. Start delivering &rarr;</button>
           <button type="button" class="btn btn-small btn-outline" onclick="setLoadoutTruckTab('add')">&larr; Add or remove stops</button>
           <button type="button" class="btn btn-small btn-outline" onclick="loadoutClearTruck()">Empty load</button>
         </div>`;
    }

    view.innerHTML = `<div class="card">
      <div class="lo-head">
        <h2 class="card-title" style="margin-bottom: 0 !important;"><span aria-hidden="true">&#x1F69A;</span> My Load</h2>
        <button type="button" class="btn btn-small btn-secondary" onclick="showView('viewPollingPlaces')" aria-label="Back to stop list">&larr; Back to Stops</button>
      </div>
      <p class="meta-line lo-progress"><strong>${onTruck.length}</strong> stop${onTruck.length === 1 ? '' : 's'} on this load, mixed from any day &middot; ${doneAll} of ${all.length} delivered</p>
      ${taken}
      <nav class="lo-steps" aria-label="My Load steps">${step('add', 1, 'Build load')}${step('load', 2, 'Load details')}${step('order', 3, 'Deliver')}</nav>
      ${body}
      <p class="hint" style="margin-top: 16px;">${LO_STATUS_HINT}</p>
      <button type="button" class="btn btn-small btn-outline" style="margin-top: 8px;" onclick="setLoadoutDay('all')" aria-label="Open the loadout list by delivery day">Loadout by day</button>
    </div>`;
    loadoutUpdateEntryButton();
    return;
  }

  const shown = loadoutHideDelivered ? left : scope;
  // group by day so "All days" reads like the stop list
  const groups = [];
  shown.forEach(i => {
    const title = i.route.day == null ? 'Other stops' : 'Day ' + i.route.day;
    if (!groups.length || groups[groups.length - 1].title !== title) groups.push({ title, list: [] });
    groups[groups.length - 1].list.push(i);
  });
  const cards = groups.map(g => `${loadoutDay === 'all' ? `<h3 class="day-heading lo-day">${escapeHtml(g.title)} (${g.list.length})</h3>` : ''}${g.list.map(i => loadoutStopHtml(i, s)).join('')}`).join('');

  view.innerHTML = `<div class="card">
    <div class="lo-head">
      <h2 class="card-title" style="margin-bottom: 0 !important;">Truck Loadout</h2>
      <button type="button" class="btn btn-small btn-secondary" onclick="showView('viewPollingPlaces')" aria-label="Back to stop list">&larr; Back to Stops</button>
    </div>
    ${chips}
    <p class="meta-line lo-progress">${escapeHtml(scopeTitle)}: <strong>${left.length}</strong> stop${left.length === 1 ? '' : 's'} to deliver${deliveredCount ? ` &middot; ${deliveredCount} delivered` : ''}</p>

    <section class="lo-truck" aria-live="polite">
      <h3 class="step-title" style="margin-bottom: 8px;"><span aria-hidden="true">&#x1F69A;</span> My load: ${onTruck.length} stop${onTruck.length === 1 ? '' : 's'}</h3>
      ${onTruck.length ? loadLinesHtml(truck) : '<p class="hint">Tick <strong>On my truck</strong> for each stop you are taking this trip, from any day. The totals to load show here.</p>'}
      ${onTruck.length ? `<div class="lo-actions"><button type="button" class="btn btn-small" onclick="setLoadoutDay('truck')">Open my load</button><button type="button" class="btn btn-small btn-outline" onclick="loadoutClearTruck()">Empty load</button></div>` : ''}
    </section>

    <div class="lo-bulk">
      ${left.length ? `<button type="button" class="btn btn-small btn-outline" onclick="loadoutAddNext(5)">Add next 5 stops</button>` : ''}
      <label class="lo-check lo-toggle"><input type="checkbox" ${loadoutHideDelivered ? 'checked' : ''} onchange="loadoutHideDelivered = this.checked; renderLoadout();"> <span>Hide delivered</span></label>
    </div>

    <div class="lo-list">${cards || '<p class="hint">Every stop here has a custody record.</p>'}</div>

    ${left.length ? `<details class="lo-remaining"><summary>Everything still to deliver (${escapeHtml(scopeTitle)})</summary>${loadLinesHtml(remaining)}</details>` : ''}
    <p class="hint" style="margin-top: 16px;">${LO_STATUS_HINT}</p>
  </div>`;
  loadoutUpdateEntryButton();
}

function loadoutClearTruck() {
  if (!confirm('Take every stop off this load?')) return;
  const s = loadoutState();
  Object.keys(s.loaded).forEach(k => loadoutShareTruck(k, false));
  s.loaded = {};
  s.order = [];
  loadoutSave(s);
  renderLoadout();
}

// Put the load back in the scheduled route order (day, then stop)
function loadoutSortRoute() {
  const s = loadoutState();
  s.order = loadoutStops().filter(i => s.loaded[i.location_key] && !loDoneAt(s, i.location_key)).map(i => i.location_key);
  loadoutSave(s);
  renderLoadout();
}

// Move a stop one place earlier (dir -1) or later (dir 1) in this load's delivery order
function loadoutMove(key, dir) {
  const s = loadoutState();
  const seq = loadoutPicks(loadoutStops(), s).map(i => i.location_key);
  const from = seq.indexOf(key);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= seq.length) return;
  seq.splice(to, 0, seq.splice(from, 1)[0]);
  s.order = seq;
  loadoutSave(s);
  renderLoadout();
}

// Tick the next n stops in route order that are not delivered and not on anyone's truck
function loadoutAddNext(n) {
  const s = loadoutState();
  loadoutStops().filter(i => (loadoutDay === 'all' || i.route.day === loadoutDay) && !loDoneAt(s, i.location_key) && !s.loaded[i.location_key] && !loOtherTruck(s, i.location_key))
    .slice(0, n).forEach(i => { s.loaded[i.location_key] = true; s.order.push(i.location_key); loadoutShareTruck(i.location_key, true); });
  loadoutSave(s);
  renderLoadout();
}

// Keeps the "My Load" button on the stop list showing how many stops are on the load right now.
function loadoutUpdateEntryButton() {
  const btn = document.getElementById('myLoadBtn');
  if (!btn || !selectedElection) return;
  const s = loadoutState();
  const n = loadoutPicks(loadoutStops(), s).length;
  btn.innerHTML = `<span aria-hidden="true">&#x1F69A;</span> My Load (${n})`;
  btn.setAttribute('aria-label', `Open my custom delivery load, ${n} stop${n === 1 ? '' : 's'} on it`);
}

function loadoutStorePick(key, on) {
  const s = loadoutState();
  s.order = s.order.filter(k => k !== key);
  if (on) { s.loaded[key] = true; s.order.push(key); } else { delete s.loaded[key]; }
  loadoutSave(s);
  loadoutShareTruck(key, on);
  return s;
}
function loadoutSetPick(key, on) { loadoutStorePick(key, on); renderLoadout(); }

document.addEventListener('change', (e) => {
  const cb = e.target.closest && e.target.closest('input[data-lo-load]');
  if (cb) {
    if (cb.checked && !loadoutConfirmTake(cb.dataset.loLoad)) { cb.checked = false; return; }
    return loadoutSetPick(cb.dataset.loLoad, cb.checked);
  }
  // pick list: update in place so the search box and scroll position stay put
  const pick = e.target.closest && e.target.closest('input[data-lo-pick]');
  if (!pick) return;
  if (pick.checked && !loadoutConfirmTake(pick.dataset.loPick)) { pick.checked = false; return; }
  const s = loadoutStorePick(pick.dataset.loPick, pick.checked);
  pick.closest('.lo-pick-row').classList.toggle('on', pick.checked);
  const picks = loadoutPicks(loadoutStops(), s);
  const bar = document.getElementById('loPickBar');
  if (bar) bar.innerHTML = loadoutPickBarHtml(picks.length, sumLoad(picks));
  const progress = document.querySelector('#viewLoadout .lo-progress strong');
  if (progress) progress.textContent = picks.length;
  loadoutUpdateEntryButton();
});

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-lo-open],[data-lo-drop],[data-lo-up],[data-lo-down]');
  if (!b || !b.closest('#viewLoadout')) return;
  if (b.dataset.loOpen) { loadoutOpenedKey = b.dataset.loOpen; return selectPollingPlace(b.dataset.loOpen); }
  if (b.dataset.loUp) return loadoutMove(b.dataset.loUp, -1);
  if (b.dataset.loDown) return loadoutMove(b.dataset.loDown, 1);
  if (b.dataset.loDrop) return loadoutSetPick(b.dataset.loDrop, false);
});
