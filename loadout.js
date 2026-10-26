// Truck loadout list (driver side). Two ways to use it:
//   - By day: every stop on a delivery day with what goes on the truck for it, so drivers can load a trip
//     without opening each stop.
//   - My load (custom): the driver hand-picks stops from any day with "On truck". That load has its own
//     loadout totals and its own delivery order, which the driver can rearrange and then work through.
//
// Uses only manifestData (already loaded and cached offline by Firestore). Picks, the chosen order and
// loaded/delivered marks are kept on this phone only (localStorage): drivers cannot read the deliveries
// collection, so a stop delivered by another driver or phone is not known here until the driver marks it.

let loadoutDay = null;
let loadoutHideDelivered = true;
let loadoutTruckTab = 'load';   // 'load' = what to pull for this load, 'order' = the delivery sequence

const loadoutKey = () => `hcec_loadout_${selectedElection ? selectedElection.id : ''}_${currentAccount ? currentAccount.uid : ''}`;

function loadoutState() {
  try {
    const s = JSON.parse(storeGet(loadoutKey()) || '{}');
    return { loaded: s.loaded || {}, delivered: s.delivered || {}, order: Array.isArray(s.order) ? s.order : [] };
  } catch (e) { return { loaded: {}, delivered: {}, order: [] }; }
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
  const picks = all.filter(i => s.loaded[i.location_key] && !s.delivered[i.location_key]);
  const rank = k => { const n = s.order.indexOf(k); return n === -1 ? Number.MAX_SAFE_INTEGER : n; };
  return picks
    .map((i, n) => ({ i, n }))
    .sort((a, b) => (rank(a.i.location_key) - rank(b.i.location_key)) || (a.n - b.n))
    .map(x => x.i);
}

// loadoutDay is 'all', a day number, or 'truck' (My load: only the stops picked for this trip, from any day)
function openLoadout(mode) {
  const days = loadoutDays();
  if (mode === 'truck') loadoutDay = 'truck';
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

function loadoutStopHtml(i, s, showDay) {
  const k = escapeHtml(i.location_key);
  const dayTag = showDay ? (i.route.day == null ? 'Unscheduled' : 'Day ' + i.route.day) + ' &middot; ' : '';
  const isDone = !!s.delivered[i.location_key];
  const isLoaded = !isDone && !!s.loaded[i.location_key];
  const boxes = i.ballot_boxes || i.slots.length;
  const doneAt = isDone ? new Date(s.delivered[i.location_key]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const precincts = precinctListText(i);
  return `<div class="lo-stop${isLoaded ? ' loaded' : ''}${isDone ? ' delivered' : ''}">
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
      ? `<p class="lo-done-line"><span aria-hidden="true">&#x2705;</span> Delivered ${escapeHtml(doneAt)}</p>
         <button type="button" class="btn btn-small btn-outline" data-lo-undo="${k}" aria-label="Undo delivered mark for ${escapeHtml(i.location_name)}">Undo delivered</button>`
      : `<label class="lo-check"><input type="checkbox" data-lo-load="${k}" ${isLoaded ? 'checked' : ''}> <span>On truck</span></label>
         <div class="lo-actions">
           <button type="button" class="btn btn-small" data-lo-open="${k}" aria-label="Start delivery at ${escapeHtml(i.location_name)}">Start Delivery &rarr;</button>
           <button type="button" class="btn btn-small btn-outline" data-lo-done="${k}" aria-label="Mark ${escapeHtml(i.location_name)} delivered without recording">Mark delivered</button>
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
      <button type="button" class="btn btn-small btn-outline" data-lo-done="${k}" aria-label="Mark ${escapeHtml(i.location_name)} delivered without recording">Mark delivered</button>
      <button type="button" class="btn btn-small btn-outline" data-lo-drop="${k}" aria-label="Take ${escapeHtml(i.location_name)} off this load">Take off load</button>
    </div>
  </div>`;
}

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
  const left = scope.filter(i => !s.delivered[i.location_key]);
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
    const tab = (value, label) => {
      const on = loadoutTruckTab === value;
      return `<button type="button" class="btn btn-small${on ? '' : ' btn-outline'}" aria-pressed="${on}" onclick="setLoadoutTruckTab('${value}')">${label}</button>`;
    };
    const seqCards = onTruck.map((i, n) => loadoutSeqHtml(i, n + 1, onTruck.length)).join('');
    const loadCards = onTruck.map(i => loadoutStopHtml(i, s, true)).join('');
    const doneToday = Object.keys(s.delivered).length;

    view.innerHTML = `<div class="card">
      <div class="lo-head">
        <h2 class="card-title" style="margin-bottom: 0 !important;"><span aria-hidden="true">&#x1F69A;</span> My Load</h2>
        <button type="button" class="btn btn-small btn-secondary" onclick="showView('viewPollingPlaces')" aria-label="Back to stop list">&larr; Back to Stops</button>
      </div>
      ${chips}
      <p class="meta-line lo-progress"><strong>${onTruck.length}</strong> stop${onTruck.length === 1 ? '' : 's'} on this load, mixed from any day${doneToday ? ` &middot; ${doneToday} delivered from this phone` : ''}</p>

      ${onTruck.length ? `<div class="lo-chips lo-tabs" role="group" aria-label="Show">${tab('load', 'What to load')}${tab('order', 'Delivery order')}</div>` : ''}

      ${onTruck.length ? (seqTab
        ? `<section class="lo-truck" aria-live="polite">
             <h3 class="step-title" style="margin-bottom: 8px;">Deliver in this order</h3>
             <p class="hint">Use &uarr; and &darr; to rearrange. The top stop is your next one.</p>
             <div class="lo-actions">
               <button type="button" class="btn btn-small" data-lo-open="${escapeHtml(onTruck[0].location_key)}" aria-label="Start delivery at ${escapeHtml(onTruck[0].location_name)}">Start next stop &rarr;</button>
               <button type="button" class="btn btn-small btn-outline" onclick="loadoutSortRoute()" aria-label="Put this load back in scheduled route order">Use route order</button>
             </div>
           </section>
           <div class="lo-list">${seqCards}</div>`
        : `<section class="lo-truck" aria-live="polite">
             <h3 class="step-title" style="margin-bottom: 8px;">Pull this for the load</h3>
             ${loadLinesHtml(truck)}
             <div class="lo-actions">
               <button type="button" class="btn btn-small" onclick="setLoadoutTruckTab('order')">See delivery order &rarr;</button>
               <button type="button" class="btn btn-small btn-outline" onclick="loadoutClearTruck()">Empty load</button>
             </div>
           </section>
           <div class="lo-list">${loadCards}</div>`)
        : `<p class="hint">This load is empty. Pick a day above or <strong>All days</strong>, then tick <strong>On truck</strong> for each stop you are taking, from any day you like. The totals to pull and the delivery order show up here.</p>
           <div class="lo-actions"><button type="button" class="btn btn-small" onclick="setLoadoutDay('all')">Pick stops &rarr;</button></div>`}

      <p class="hint" style="margin-top: 16px;">Delivered marks come from deliveries recorded on this phone, or <strong>Mark delivered</strong>. Stops another driver delivered do not show as delivered here.</p>
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
    <p class="meta-line lo-progress">${escapeHtml(scopeTitle)}: <strong>${left.length}</strong> stop${left.length === 1 ? '' : 's'} to deliver${deliveredCount ? ` &middot; ${deliveredCount} delivered from this phone` : ''}</p>

    <section class="lo-truck" aria-live="polite">
      <h3 class="step-title" style="margin-bottom: 8px;"><span aria-hidden="true">&#x1F69A;</span> My load: ${onTruck.length} stop${onTruck.length === 1 ? '' : 's'}</h3>
      ${onTruck.length ? loadLinesHtml(truck) : '<p class="hint">Tick <strong>On truck</strong> for each stop you are taking this trip, from any day. The totals to load show here.</p>'}
      ${onTruck.length ? `<div class="lo-actions"><button type="button" class="btn btn-small" onclick="setLoadoutDay('truck')">Open my load</button><button type="button" class="btn btn-small btn-outline" onclick="loadoutClearTruck()">Empty load</button></div>` : ''}
    </section>

    <div class="lo-bulk">
      ${left.length ? `<button type="button" class="btn btn-small btn-outline" onclick="loadoutAddNext(5)">Add next 5 stops</button>` : ''}
      <label class="lo-check lo-toggle"><input type="checkbox" ${loadoutHideDelivered ? 'checked' : ''} onchange="loadoutHideDelivered = this.checked; renderLoadout();"> <span>Hide delivered</span></label>
    </div>

    <div class="lo-list">${cards || '<p class="hint">Every stop here is marked delivered.</p>'}</div>

    ${left.length ? `<details class="lo-remaining"><summary>Everything still to deliver (${escapeHtml(scopeTitle)})</summary>${loadLinesHtml(remaining)}</details>` : ''}
    <p class="hint" style="margin-top: 16px;">Delivered marks come from deliveries recorded on this phone, or <strong>Mark delivered</strong>. Stops another driver delivered do not show as delivered here.</p>
  </div>`;
  loadoutUpdateEntryButton();
}

function loadoutClearTruck() {
  if (!confirm('Take every stop off this load? Delivered marks are kept.')) return;
  const s = loadoutState();
  s.loaded = {};
  s.order = [];
  loadoutSave(s);
  renderLoadout();
}

// Put the load back in the scheduled route order (day, then stop)
function loadoutSortRoute() {
  const s = loadoutState();
  s.order = loadoutStops().filter(i => s.loaded[i.location_key] && !s.delivered[i.location_key]).map(i => i.location_key);
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

// Tick the next n stops in route order that are neither delivered nor already on the truck
function loadoutAddNext(n) {
  const s = loadoutState();
  loadoutStops().filter(i => (loadoutDay === 'all' || i.route.day === loadoutDay) && !s.delivered[i.location_key] && !s.loaded[i.location_key])
    .slice(0, n).forEach(i => { s.loaded[i.location_key] = true; s.order.push(i.location_key); });
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

function loadoutSetPick(key, on) {
  const s = loadoutState();
  s.order = s.order.filter(k => k !== key);
  if (on) { s.loaded[key] = true; s.order.push(key); } else { delete s.loaded[key]; }
  loadoutSave(s);
  renderLoadout();
}

document.addEventListener('change', (e) => {
  const cb = e.target.closest && e.target.closest('input[data-lo-load]');
  if (!cb) return;
  loadoutSetPick(cb.dataset.loLoad, cb.checked);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-lo-open],[data-lo-done],[data-lo-undo],[data-lo-drop],[data-lo-up],[data-lo-down]');
  if (!b || !b.closest('#viewLoadout')) return;
  if (b.dataset.loOpen) { loadoutOpenedKey = b.dataset.loOpen; return selectPollingPlace(b.dataset.loOpen); }
  if (b.dataset.loUp) return loadoutMove(b.dataset.loUp, -1);
  if (b.dataset.loDown) return loadoutMove(b.dataset.loDown, 1);
  if (b.dataset.loDrop) return loadoutSetPick(b.dataset.loDrop, false);
  const s = loadoutState();
  if (b.dataset.loDone) {
    const stop = loadoutStops().find(i => i.location_key === b.dataset.loDone);
    if (!confirm(`Mark ${stop ? stop.location_name : 'this stop'} as delivered on this list? This does not record a custody delivery.`)) return;
    s.delivered[b.dataset.loDone] = new Date().toISOString();
    delete s.loaded[b.dataset.loDone];
    s.order = s.order.filter(k => k !== b.dataset.loDone);
  } else {
    delete s.delivered[b.dataset.loUndo];
  }
  loadoutSave(s);
  renderLoadout();
});
