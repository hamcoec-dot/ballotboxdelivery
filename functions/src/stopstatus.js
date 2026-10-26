'use strict';
// Shared per-stop status that every driver can read (elections/{eid}/stop_status/{locationKey}), so drivers
// see each other's work without reading the deliveries collection. Pure helpers (unit tested).
//
//   truck_uid, truck_name, truck_at        whose truck the stop is on now (written by drivers, see firestore.rules)
//   delivered_at, delivered_by, delivery_id  the latest live delivery at the stop (written only by the functions)

const DELIVERED_FIELDS = ['delivered_at', 'delivered_by', 'delivery_id'];

// What drivers see of a person: the part of the email before the @ (staff accounts only).
const shortName = (email) => String(email || '').split('@')[0].slice(0, 60) || 'another driver';

// Given every delivery record at one stop ({ id, data }), the delivered fields for its status:
// the newest one that is not soft-deleted, or null when there is none.
function deliveredFields(records) {
  const live = records.filter(r => r.data && !r.data.deleted);
  if (!live.length) return null;
  const ms = (r) => (r.data.timestamp && typeof r.data.timestamp.toMillis === 'function' ? r.data.timestamp.toMillis() : 0);
  const latest = live.reduce((a, b) => (ms(b) > ms(a) ? b : a));
  return { delivered_at: latest.data.timestamp || null, delivered_by: shortName(latest.data.driver_email), delivery_id: latest.id };
}

module.exports = { DELIVERED_FIELDS, shortName, deliveredFields };
