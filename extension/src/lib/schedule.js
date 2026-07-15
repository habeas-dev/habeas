// Declarative recurring-schedule engine for the download planner. A schedule spec is a small, auditable
// object (data, not code). All times are LOCAL (the user's machine timezone) — `time: "HH:MM"`.
//
// Spec kinds (cover the versatile cases the UI offers):
//   { kind: 'daily', time }                                  every day at HH:MM
//   { kind: 'weekly', weekdays: [1..7], time }               those ISO weekdays (1=Mon … 7=Sun)
//   { kind: 'monthly-day', days: [1..31], time }             those calendar days of each month
//   { kind: 'monthly-weekday', nth: 1..5|-1, weekday, time } the nth (or last) <weekday> of each month
//   { kind: 'monthly-businessday', nth: 1..N|-1, time }      the nth (or last) business day (Mon–Fri) of the month
//
// nextOccurrence(spec, fromMs) → the first firing time strictly AFTER fromMs (ms), or null if none within ~13
// months (a malformed spec). Day-by-day scan: robust for every kind, including month rollover + clamping.

const isoDay = (d) => ((d.getDay() + 6) % 7) + 1;               // JS 0=Sun..6=Sat → ISO 1=Mon..7=Sun
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const isBusinessDay = (d) => { const w = isoDay(d); return w >= 1 && w <= 5; }; // Mon–Fri (holidays not modelled)

// Which occurrence (1-based) of its own weekday `d` is within its month (e.g. the 2nd Tuesday → 2).
const weekdayIndex = (d) => Math.floor((d.getDate() - 1) / 7) + 1;
const isLastWeekday = (d) => d.getDate() + 7 > daysInMonth(d); // no later same-weekday date this month
// Which business day (1-based) `d` is within its month; and whether it's the last one.
function businessDayIndex(d) {
  let n = 0;
  for (let day = 1; day <= d.getDate(); day++) if (isBusinessDay(new Date(d.getFullYear(), d.getMonth(), day))) n++;
  return n;
}
function isLastBusinessDay(d) {
  const dim = daysInMonth(d);
  for (let day = d.getDate() + 1; day <= dim; day++) if (isBusinessDay(new Date(d.getFullYear(), d.getMonth(), day))) return false;
  return true;
}

export function dayMatches(spec, d) {
  switch (spec && spec.kind) {
    case 'daily': return true;
    case 'weekly': return Array.isArray(spec.weekdays) && spec.weekdays.includes(isoDay(d));
    case 'monthly-day': return Array.isArray(spec.days) && spec.days.includes(d.getDate());
    case 'monthly-weekday':
      if (isoDay(d) !== spec.weekday) return false;
      return spec.nth === -1 ? isLastWeekday(d) : weekdayIndex(d) === spec.nth;
    case 'monthly-businessday':
      if (!isBusinessDay(d)) return false;
      return spec.nth === -1 ? isLastBusinessDay(d) : businessDayIndex(d) === spec.nth;
    default: return false;
  }
}

export function nextOccurrence(spec, fromMs) {
  if (!spec || !spec.kind) return null;
  const from = new Date(fromMs);
  const [hh, mm] = String(spec.time || '00:00').split(':').map((x) => Number(x) || 0);
  for (let i = 0; i <= 400; i++) {                              // ~13 months of look-ahead
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh, mm, 0, 0); // JS normalises rollover
    if (d.getTime() <= fromMs) continue;                        // strictly in the future
    if (dayMatches(spec, d)) return d.getTime();
  }
  return null;
}

// Validate a spec (used by the UI + before storing). Returns { ok, error }.
export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'no spec' };
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(spec.time || ''))) return { ok: false, error: 'time must be HH:MM (24h)' };
  const nthOk = (n) => n === -1 || (Number.isInteger(n) && n >= 1 && n <= 31);
  switch (spec.kind) {
    case 'daily': return { ok: true };
    case 'weekly': return Array.isArray(spec.weekdays) && spec.weekdays.length && spec.weekdays.every((w) => w >= 1 && w <= 7) ? { ok: true } : { ok: false, error: 'weekdays 1..7 required' };
    case 'monthly-day': return Array.isArray(spec.days) && spec.days.length && spec.days.every((x) => x >= 1 && x <= 31) ? { ok: true } : { ok: false, error: 'days 1..31 required' };
    case 'monthly-weekday': return nthOk(spec.nth) && spec.weekday >= 1 && spec.weekday <= 7 ? { ok: true } : { ok: false, error: 'nth + weekday required' };
    case 'monthly-businessday': return nthOk(spec.nth) ? { ok: true } : { ok: false, error: 'nth required' };
    default: return { ok: false, error: 'unknown kind' };
  }
}

const WD_KEY = ['', 'sched_mon', 'sched_tue', 'sched_wed', 'sched_thu', 'sched_fri', 'sched_sat', 'sched_sun'];
const ORD_KEY = { 1: 'sched_ord_1', 2: 'sched_ord_2', 3: 'sched_ord_3', 4: 'sched_ord_4', 5: 'sched_ord_5', '-1': 'sched_ord_last' };

// Human, i18n description of a spec. `t` is the i18n lookup (t(key, subs?)); falls back to plain English.
export function describeSchedule(spec, t) {
  const T = t || ((k, s) => defaultEn(k, s));
  const at = T('sched_at', [spec.time || '']);
  switch (spec && spec.kind) {
    case 'daily': return T('sched_desc_daily', [at]);
    case 'weekly': return T('sched_desc_weekly', [spec.weekdays.map((w) => T(WD_KEY[w])).join(', '), at]);
    case 'monthly-day': return T('sched_desc_monthlyday', [spec.days.join(', '), at]);
    case 'monthly-weekday': return T('sched_desc_monthlyweekday', [T(ORD_KEY[spec.nth]), T(WD_KEY[spec.weekday]), at]);
    case 'monthly-businessday': return T('sched_desc_monthlybusiness', [T(ORD_KEY[spec.nth]), at]);
    default: return '';
  }
}

// Minimal English fallback so the engine is usable without the i18n layer (tests, logs).
function defaultEn(k, s) {
  const M = {
    sched_at: `at ${s && s[0]}`, sched_mon: 'Mon', sched_tue: 'Tue', sched_wed: 'Wed', sched_thu: 'Thu', sched_fri: 'Fri', sched_sat: 'Sat', sched_sun: 'Sun',
    sched_ord_1: '1st', sched_ord_2: '2nd', sched_ord_3: '3rd', sched_ord_4: '4th', sched_ord_5: '5th', sched_ord_last: 'last',
    sched_desc_daily: `Every day ${s && s[0]}`, sched_desc_weekly: `Every ${s && s[0]} ${s && s[1]}`,
    sched_desc_monthlyday: `Day ${s && s[0]} of each month ${s && s[1]}`,
    sched_desc_monthlyweekday: `The ${s && s[0]} ${s && s[1]} of each month ${s && s[2]}`,
    sched_desc_monthlybusiness: `The ${s && s[0]} business day of each month ${s && s[1]}`,
  };
  return M[k] != null ? M[k] : k;
}
