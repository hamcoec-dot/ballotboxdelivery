// Truck loadout list (driver side). One page per delivery day: every stop with what goes on the truck for it,
// so drivers can load a trip without opening each stop. Drivers tick "On truck" for the stops in this trip;
// the totals at the top add up exactly what to pull for that trip.
//
// Uses only manifestData (already loaded and cached offline by Firestore). Loaded/delivered marks are kept on
// this phone only (localStorage): drivers cannot read the deliveries collection, so a stop delivered by another
// driver or phone is not known here until the driver marks it.

let loadoutDay = null;
let loadoutHideDelivered = true;

const loadoutKey = () => `hcec_loadout_${selectedElection ? selectedElection.id : ''}_${currentAccount ? currentAccount.uid : ''}`;

function loadoutState() {
  try {
    const s = JSON.parse(storeGet(loadoutKey()) || '{}');
    return { loaded: s.loaded || {}, delivered: s.delivered || {} };
  } catch (e) { return { loaded: {}, delivered: {} }; }
}
function loadoutSave(s) { storeSet(loadoutKey(), JSON.stringify(s)); }

let loadoutOpenedKey = null;   // stop opened from this page, so the driver comes back here after recording it

// Called after a delivery is recorded or saved for later sync on this phone: it is off the truck.
// Returns the view to go back to.
function loadoutAfterDelivery(locationKey) {
  let back = false;
  try {
    const s = loadoutState();
    s.delivered[locationKey] = new Date().toISOString();
    delete s.loaded[locationKey];
    loadoutSave(s);
    back = loadoutOpenedKey === locationKey;
    loadoutOpenedKey = null;
    if (back) renderLoadout();
  } catch (e) { /* never block a delivery */ }
  return back ? 'viewLoadout' : 'viewPollingPlaces';
}

function loadoutStops() {
  return manifestData.filter(i => selectedElection && i.election_id === selectedElection.id);
}

// loadoutDay is 'all', a day number, or 'truck' (only the stops picked for this trip, from any day)
function openLoadout() {
  const days = loadoutDays();
  if (dayFilter !== 'all' && days.includes(Number(dayFilter))) loadoutDay = Number(dayFilter);
  else if (loadoutDay == null) loadoutDay = 'all';
  renderLoadout();
  showView('viewLoadout');
  window.scrollTo(0, 0);
}

const loadoutDays = () => [...new Set(loadoutStops().map(i => i.route.day).filter(d => d != null))].sort((a, b) => a - b);

function setLoadoutDay(d) { loadoutDay = d; renderLoadout(); }

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

function loadoutStopHtml(i, s) {
  const k = escapeHtml(i.location_key);
  const isDone = !!s.delivered[i.location_key];
  const isLoaded = !isDone && !!s.loaded[i.location_key];
  const boxes = i.ballot_boxes || i.slots.length;
  const doneAt = isDone ? new Date(s.delivered[i.location_key]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const precincts = precinctListText(i);
  return `<div class="lo-stop${isLoaded ? ' loaded' : ''}${isDone ? ' delivered' : ''}">
    <div class="stop-eyebrow">${i.route.label ? `Stop ${escapeHtml(i.route.label)}` : 'Unscheduled'}${precincts ? ` &middot; ${escapeHtml(precincts)}` : ''}</div>
    <h3 class="stop-name">${escapeHtml(i.location_name)}</h3>
    ${i.address ? `<p class="meta-line lo-addr">${escapeHtml(i.address)}</p>` : ''}
    <ul class="lo-lines">
      <li><span>Ballot boxes / machines</span><strong>${boxes}</strong></li>
      ${i.slots.length ? `<li class="lo-machines"><ul>${i.slots.map(m => `<li>${escapeHtml(sealLabel(m))}</li>`).join('')}</ul></li>` : ''}
      ${i.supplies.map(x => `<li><span>${escapeHtml(x.label)}</span><strong>${x.qty}</strong></li>`).join('')}
    </ul>
    ${i.slots.length !== boxes ? `<p class="hint lo-warn">&#x26A0;&#xFE0F; ${i.slots.length} machine${i.slots.length === 1 ? '' : 's'} with seals on file for ${boxes} ballot box${boxes === 1 ? '' : 'es'}</p>` : ''}
    ${isDone
      ? `<p class="lo-done-line"><span aria-hidden="true">&#x2705;</span> Delivered ${escapeHtml(doneAt)}</p>
         <button type="button" class="btn btn-small btn-outline" data-lo-undo="${k}" aria-label="Undo delivered mark for ${escapeHtml(i.location_name)}">Undo delivered</button>`
      : `<label class="lo-check"><input type="checkbox" data-lo-load="${k}" ${isLoaded ? 'checked' : ''}> <span>On truck</span></label>
         <div class="lo-actions">
           <button type="button" class="btn btn-small" data-lo-open="${k}" aria-label="Start delivery at ${escapeHtml(i.location_name)}">Start Delivery &rarr;</button>
           <button type="button" class="btn btn-small btn-outline" data-lo-done="${k}" aria-label="Mark ${escapeHtml(i.location_name)} delivered without recording">Mark delivered</button>
         </div>`}
  </div>`;
}

function renderLoadout() {
  const view = document.getElementById('viewLoadout');
  const all = loadoutStops();
  const days = loadoutDays();
  const s = loadoutState();
  if (loadoutDay !== 'all' && loadoutDay !== 'truck' && !days.includes(loadoutDay)) loadoutDay = 'all';
  const onTruck = all.filter(i => s.loaded[i.location_key] && !s.delivered[i.location_key]);
  const truck = sumLoad(onTruck);
  const isTruck = loadoutDay === 'truck';
  const scope = isTruck ? onTruck : loadoutDay === 'all' ? all : all.filter(i => i.route.day === loadoutDay);
  const left = scope.filter(i => !s.delivered[i.location_key]);
  const deliveredCount = scope.length - left.length;
  const remaining = sumLoad(left);
  const scopeTitle = isTruck ? 'On the truck' : loadoutDay === 'all' ? 'All days' : 'Day ' + loadoutDay;

  const chip = (value, label) => {
    const on = String(value) === String(loadoutDay);
    return `<button type="button" class="btn btn-small${on ? '' : ' btn-outline'}" aria-pressed="${on}" onclick="setLoadoutDay(${typeof value === 'number' ? value : `'${value}'`})">${label}</button>`;
  };
  const chips = `<div class="lo-chips" role="group" aria-label="Show stops">${chip('all', 'All days')}${days.length > 1 ? days.map(d => chip(d, 'Day ' + d)).join('') : ''}${chip('truck', `<span aria-hidden="true">&#x1F69A;</span> On truck (${onTruck.length})`)}</div>`;

  const shown = loadoutHideDelivered ? left : scope;
  // group by day so "All days" reads like the stop list
  const groups = [];
  shown.forEach(i => {
    const title = i.route.day == null ? 'Other stops' : 'Day ' + i.route.day;
    if (!groups.length || groups[groups.length - 1].title !== title) groups.push({ title, list: [] });
    groups[groups.length - 1].list.push(i);
  });
  const cards = groups.map(g => `${loadoutDay === 'all' || isTruck ? `<h3 class="day-heading lo-day">${escapeHtml(g.title)} (${g.list.length})</h3>` : ''}${g.list.map(i => loadoutStopHtml(i, s)).join('')}`).join('');
  const emptyMsg = isTruck ? 'Nothing is on the truck yet. Pick a day, then tick <strong>On truck</strong> for each stop you are taking this trip.'
    : 'Every stop here is marked delivered.';

  view.innerHTML = `<div class="card">
    <div class="lo-head">
      <h2 class="card-title" style="margin-bottom: 0 !important;">Truck Loadout</h2>
      <button type="button" class="btn btn-small btn-secondary" onclick="showView('viewPollingPlaces')" aria-label="Back to stop list">&larr; Back to Stops</button>
    </div>
    ${chips}
    <p class="meta-line lo-progress">${escapeHtml(scopeTitle)}: <strong>${left.length}</strong> stop${left.length === 1 ? '' : 's'} to deliver${deliveredCount ? ` &middot; ${deliveredCount} delivered from this phone` : ''}</p>

    <section class="lo-truck" aria-live="polite">
      <h3 class="step-title" style="margin-bottom: 8px;"><span aria-hidden="true">&#x1F69A;</span> Load for this trip: ${onTruck.length} stop${onTruck.length === 1 ? '' : 's'}</h3>
      ${onTruck.length ? loadLinesHtml(truck) : '<p class="hint">Tick <strong>On truck</strong> for each stop you are taking this trip, from any day. The totals to load show here.</p>'}
      ${onTruck.length ? `<div class="lo-actions">${isTruck ? '' : `<button type="button" class="btn btn-small" onclick="setLoadoutDay('truck')">Show my trip</button>`}<button type="button" class="btn btn-small btn-outline" onclick="loadoutClearTruck()">Empty truck</button></div>` : ''}
    </section>

    <div class="lo-bulk">
      ${left.length && !isTruck ? `<button type="button" class="btn btn-small btn-outline" onclick="loadoutAddNext(5)">Add next 5 stops</button>` : ''}
      <label class="lo-check lo-toggle"><input type="checkbox" ${loadoutHideDelivered ? 'checked' : ''} onchange="loadoutHideDelivered = this.checked; renderLoadout();"> <span>Hide delivered</span></label>
    </div>

    <div class="lo-list">${cards || `<p class="hint">${emptyMsg}</p>`}</div>

    ${left.length && !isTruck ? `<details class="lo-remaining"><summary>Everything still to deliver (${escapeHtml(scopeTitle)})</summary>${loadLinesHtml(remaining)}</details>` : ''}
    <p class="hint" style="margin-top: 16px;">Delivered marks come from deliveries recorded on this phone, or <strong>Mark delivered</strong>. Stops another driver delivered do not show as delivered here.</p>
  </div>`;
}

function loadoutClearTruck() {
  const s = loadoutState();
  s.loaded = {};
  loadoutSave(s);
  renderLoadout();
}

// Tick the next n stops in route order that are neither delivered nor already on the truck
function loadoutAddNext(n) {
  const s = loadoutState();
  loadoutStops().filter(i => (loadoutDay === 'all' || i.route.day === loadoutDay) && !s.delivered[i.location_key] && !s.loaded[i.location_key])
    .slice(0, n).forEach(i => { s.loaded[i.location_key] = true; });
  loadoutSave(s);
  renderLoadout();
}

document.addEventListener('change', (e) => {
  const cb = e.target.closest && e.target.closest('input[data-lo-load]');
  if (!cb) return;
  const s = loadoutState();
  if (cb.checked) s.loaded[cb.dataset.loLoad] = true; else delete s.loaded[cb.dataset.loLoad];
  loadoutSave(s);
  renderLoadout();
});

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-lo-open],[data-lo-done],[data-lo-undo]');
  if (!b || !b.closest('#viewLoadout')) return;
  if (b.dataset.loOpen) { loadoutOpenedKey = b.dataset.loOpen; return selectPollingPlace(b.dataset.loOpen); }
  const s = loadoutState();
  if (b.dataset.loDone) {
    const stop = loadoutStops().find(i => i.location_key === b.dataset.loDone);
    if (!confirm(`Mark ${stop ? stop.location_name : 'this stop'} as delivered on this list? This does not record a custody delivery.`)) return;
    s.delivered[b.dataset.loDone] = new Date().toISOString();
    delete s.loaded[b.dataset.loDone];
  } else {
    delete s.delivered[b.dataset.loUndo];
  }
  loadoutSave(s);
  renderLoadout();
});
