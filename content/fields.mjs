/**
 * AutoFill AnyForm — Pure field-type helpers (DOM-free, importable ESM).
 *
 * These helpers compute *what value to set* for non-text inputs without
 * touching the DOM, so they are deterministic and unit-testable. The content
 * script imports them and applies the result to the real elements.
 */

'use strict';

/**
 * Choose a <select> option value matching `value` by exact value, exact text,
 * or (as a fallback) case-insensitive containment.
 *
 * @param {*} value        profile value to match
 * @param {Array<{value:string,text:string}>} options
 * @returns {string|null}  chosen option value, or null when nothing matches
 */
export function matchSelectOption(value, options) {
  if (value === null || value === undefined || !Array.isArray(options)) return null;
  const wanted = String(value).trim().toLowerCase();
  if (wanted === '') return null;

  // 1. exact value or text match (strongest).
  for (const opt of options) {
    if (!opt) continue;
    const ov = String(opt.value ?? '').trim().toLowerCase();
    const ot = String(opt.text ?? '').trim().toLowerCase();
    if (ov === wanted || ot === wanted) return opt.value;
  }
  // 2. containment fallback (e.g. "United" -> "United States").
  for (const opt of options) {
    if (!opt) continue;
    const ot = String(opt.text ?? '').trim().toLowerCase();
    if (ot && (ot.includes(wanted) || wanted.includes(ot))) return opt.value;
  }
  return null;
}

/**
 * Coerce an arbitrary profile value to a checkbox boolean.
 * Truthy strings: true/yes/1/on/checked/y. Everything else -> false.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function toCheckboxState(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === null || value === undefined) return false;
  return /^(true|yes|1|on|checked|y)$/i.test(String(value).trim());
}

/**
 * Choose a radio value from a group by exact value or exact label
 * (case-insensitive).
 *
 * @param {*} value
 * @param {Array<{value:string,label:string}>} group
 * @returns {string|null}
 */
export function matchRadioValue(value, group) {
  if (value === null || value === undefined || !Array.isArray(group)) return null;
  const wanted = String(value).trim().toLowerCase();
  if (wanted === '') return null;
  for (const item of group) {
    if (!item) continue;
    const iv = String(item.value ?? '').trim().toLowerCase();
    const il = String(item.label ?? '').trim().toLowerCase();
    if (iv === wanted || il === wanted) return item.value;
  }
  return null;
}

const MONTHS = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
});

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Normalize a date-ish value to an ISO `YYYY-MM-DD` string, or null if it
 * cannot be parsed. Uses explicit parsing (no timezone surprises) for the
 * common formats; falls back to Date for the rest.
 *
 * @param {*} value
 * @returns {string|null}
 */
export function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;

  // Already ISO YYYY-MM-DD.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
  }

  // "Month D, YYYY" / "Month D YYYY" / "D Month YYYY".
  const monthName = s.match(/^([a-zA-Z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthName) {
    const mo = MONTHS[monthName[1].toLowerCase()];
    if (mo) return `${monthName[3]}-${pad2(mo)}-${pad2(Number(monthName[2]))}`;
  }
  const dayMonth = s.match(/^(\d{1,2})\s+([a-zA-Z]+)\.?,?\s+(\d{4})$/);
  if (dayMonth) {
    const mo = MONTHS[dayMonth[2].toLowerCase()];
    if (mo) return `${dayMonth[3]}-${pad2(mo)}-${pad2(Number(dayMonth[1]))}`;
  }

  // MM/DD/YYYY or M/D/YYYY (US convention).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    return `${slash[3]}-${pad2(Number(slash[1]))}-${pad2(Number(slash[2]))}`;
  }

  // Fallback: Date parse, but read UTC parts to avoid tz drift.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getUTCFullYear()}-${pad2(parsed.getUTCMonth() + 1)}-${pad2(parsed.getUTCDate())}`;
  }
  return null;
}
