'use strict';
// Pure helpers for clearing practice-run data (no Firebase dependencies, unit tested).

const ELECTION_TZ = 'America/New_York';   // Hamilton County, TN

// Today's date (YYYY-MM-DD) in the election office's time zone.
function localDate(now, tz = ELECTION_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Why clearing is not allowed, or null if it is. From election day on, records are real and must be kept.
function clearBlockedReason(electionDate, now) {
  if (typeof electionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(electionDate)) {
    return 'This election has no valid date, so its records cannot be cleared here.';
  }
  if (localDate(now) >= electionDate) {
    return `Election day (${electionDate}) has arrived or passed. Records for this election are kept and can no longer be cleared.`;
  }
  return null;
}

// True when every scan in a submission was made before the data was cleared, i.e. it is a
// practice delivery that waited in a phone's offline queue. No usable scan times: false (record it).
function recordedBeforeClear(scans, clearedAtMs) {
  if (!Number.isFinite(clearedAtMs)) return false;
  const times = (Array.isArray(scans) ? scans : []).map(s => Date.parse(s && s.at)).filter(Number.isFinite);
  return times.length > 0 && Math.max(...times) < clearedAtMs;
}

module.exports = { localDate, clearBlockedReason, recordedBeforeClear, ELECTION_TZ };
