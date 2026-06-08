/**
 * AutoFill AnyForm — Pure field matcher (DOM-free, importable ESM).
 *
 * Maps a field descriptor to a profile key with a confidence score using
 * specificity-ranked rules. This is the single source of truth for matching;
 * the content script imports it so the browser and the unit tests share logic.
 *
 * Contract:  matchField(descriptor, profile) -> { key: string|null, confidence: number }
 *
 * Design notes (the mis-fill bug fix):
 * - A generic `name` rule must NOT greedily swallow "Company Name", "Username",
 *   or "Cardholder Name". We do this two ways:
 *     1. Specificity: each rule carries a `specificity` weight; the highest
 *        specificity match wins (company/jobTitle beat the generic full-name rule).
 *     2. Guards: the generic full-name rule is suppressed when a qualifying token
 *        (company, user, card, cardholder, nick, login, …) appears next to "name".
 * - Ambiguous / unmatched descriptors return a confidence below the fill
 *   threshold (or null), never a confident wrong fill.
 */

'use strict';

// Below this, a match is "low confidence" and must not be treated as a fill.
// Mirrors the content script's CONFIDENCE_THRESHOLD.
export const CONFIDENCE_THRESHOLD = 0.4;

/**
 * Tokens that, when adjacent to the word "name", mean the field is NOT a
 * person's full name (it's a company / username / cardholder / nickname / …).
 * Used to suppress the greedy generic full-name rule.
 */
const NAME_DISQUALIFIERS = Object.freeze([
  'company', 'organization', 'organisation', 'business', 'firm', 'employer',
  'user', 'login', 'account', 'screen', 'display', 'nick', 'nickname',
  'card', 'cardholder', 'holder', 'brand', 'product', 'project', 'team',
  'pet', 'host', 'domain', 'file', 'event', 'group', 'channel',
]);

/**
 * Ordered, specificity-ranked rule set. Higher `specificity` wins ties.
 * `patterns` are tested against a normalized token string. Specific keys
 * (company, jobTitle, postalCode, …) carry higher specificity than the
 * generic fullName rule so they beat a stray "name" match.
 */
const RULES = Object.freeze([
  // ── Highly specific person-name parts ──
  rule('firstName', 9, [/\bfirst[\s_-]?name\b/i, /\bfname\b/i, /\bgiven[\s_-]?name\b/i, /\bforename\b/i]),
  rule('lastName', 9, [/\blast[\s_-]?name\b/i, /\blname\b/i, /\bsurname\b/i, /\bfamily[\s_-]?name\b/i]),

  // ── Contact ──
  rule('email', 9, [/\be[\s_-]?mail\b/i, /\bemail\b/i]),
  rule('phone', 8, [/\bphone\b/i, /\btelephone\b/i, /\btel\b/i, /\bmobile\b/i, /\bcell\b/i, /\bcontact[\s_-]?no\b/i]),

  // ── Address ──
  rule('address2', 8, [/\baddress[\s_-]?2\b/i, /\baddr[\s_-]?2\b/i, /\bapt\b/i, /\bapartment\b/i, /\bsuite\b/i, /\bunit\b/i, /\bline[\s_-]?2\b/i]),
  rule('address1', 7, [/\baddress[\s_-]?1\b/i, /\baddr[\s_-]?1\b/i, /\bstreet\b/i, /\bline[\s_-]?1\b/i, /\baddress\b/i, /\baddr\b/i]),
  rule('city', 8, [/\bcity\b/i, /\btown\b/i, /\blocality\b/i, /\bsuburb\b/i]),
  rule('state', 8, [/\bstate\b/i, /\bregion\b/i, /\bprovince\b/i, /\bcounty\b/i]),
  rule('postalCode', 9, [/\bzip\b/i, /\bpostal\b/i, /\bpost[\s_-]?code\b/i, /\bpostcode\b/i, /\bpin[\s_-]?code\b/i]),
  rule('country', 8, [/\bcountry\b/i, /\bnation\b/i]),

  // ── Work (jobTitle MUST beat generic name) ──
  rule('company', 10, [/\bcompany\b/i, /\borganiz[as]tion\b/i, /\borganis[as]tion\b/i, /\bemployer\b/i, /\bfirm\b/i, /\bbusiness\b/i]),
  rule('jobTitle', 10, [/\bjob[\s_-]?title\b/i, /\bposition\b/i, /\brole\b/i, /\boccupation\b/i, /\btitle\b/i]),

  // ── Misc ──
  rule('website', 7, [/\bwebsite\b/i, /\bweb[\s_-]?url\b/i, /\bhomepage\b/i, /\burl\b/i, /\bsite\b/i]),
  rule('birthDate', 9, [/\bbirth[\s_-]?date\b/i, /\bdate[\s_-]?of[\s_-]?birth\b/i, /\bdob\b/i, /\bbirthday\b/i]),

  // ── Generic full name (LOWEST specificity; guarded against disqualifiers) ──
  rule('fullName', 3, [/\bfull[\s_-]?name\b/i, /\byour[\s_-]?name\b/i, /\bname\b/i], { generic: true }),
]);

function rule(key, specificity, patterns, opts = {}) {
  return Object.freeze({ key, specificity, patterns, generic: Boolean(opts.generic) });
}

/**
 * Build a normalized lowercase token string from a descriptor. Splits
 * camelCase / snake_case / kebab so "company_name" and "companyName" both
 * surface the word "company".
 */
export function buildTokenString(descriptor) {
  const d = descriptor || {};
  const raw = [
    d.labelText, d.label, d.ariaLabel, d.placeholder, d.name, d.id, d.autocomplete,
  ]
    .filter(v => typeof v === 'string' && v.length > 0)
    .join(' ');
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase split
    .replace(/[_\-./]+/g, ' ') // separators -> space
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Does the generic full-name rule apply, or is it disqualified by an adjacent
 * qualifier (company name, user name, cardholder name, …)?
 */
function genericNameIsDisqualified(tokens) {
  if (!/\bname\b/i.test(tokens)) return false;
  // "full name" / "your name" are legit full-name signals — never disqualify.
  if (/\bfull[\s_-]?name\b/i.test(tokens) || /\byour[\s_-]?name\b/i.test(tokens)) return false;
  for (const q of NAME_DISQUALIFIERS) {
    const re = new RegExp(`\\b${q}\\b`, 'i');
    if (re.test(tokens)) return true;
  }
  return false;
}

function countMatches(patterns, tokens) {
  return patterns.reduce((acc, p) => (p.test(tokens) ? acc + 1 : acc), 0);
}

function hasProfileValue(key, profile) {
  if (!profile) return true; // no profile constraint -> consider all keys
  if (key.startsWith('__custom__')) {
    const ck = key.slice('__custom__'.length);
    const v = profile.customFields?.[ck];
    return v !== null && v !== undefined && v !== '';
  }
  if (!(key in profile)) return true; // key absent from profile -> still matchable
  const v = profile[key];
  return v !== null && v !== undefined && v !== '';
}

/**
 * Match a descriptor to a profile key.
 * Returns { key, confidence }. key is null when nothing matches.
 */
export function matchField(descriptor, profile) {
  if (!descriptor || typeof descriptor !== 'object') {
    return { key: null, confidence: 0 };
  }

  // Step 1: explicit autocomplete attribute wins (confidence 1.0).
  const ac = normalizeAutocomplete(descriptor.autocomplete);
  if (ac && Object.prototype.hasOwnProperty.call(AUTOCOMPLETE_MAP, ac)) {
    const key = AUTOCOMPLETE_MAP[ac];
    if (key !== null && hasProfileValue(key, profile)) {
      return { key, confidence: 1.0 };
    }
  }

  const tokens = buildTokenString(descriptor);
  if (!tokens) return { key: null, confidence: 0 };

  const genericDisqualified = genericNameIsDisqualified(tokens);

  // Step 2: specificity-ranked scoring.
  let best = null; // { key, specificity, hits, total }
  for (const r of RULES) {
    if (r.generic && genericDisqualified) continue; // suppress greedy name
    if (!hasProfileValue(r.key, profile)) continue;

    const hits = countMatches(r.patterns, tokens);
    if (hits === 0) continue;

    const candidate = { key: r.key, specificity: r.specificity, hits, total: r.patterns.length };
    if (isBetter(candidate, best)) best = candidate;
  }

  if (best) {
    return { key: best.key, confidence: confidenceFor(best) };
  }

  // Step 3: custom fields (matched by key name in tokens).
  const customKey = matchCustomFields(tokens, profile);
  if (customKey) return { key: customKey, confidence: 0.8 };

  return { key: null, confidence: 0 };
}

/**
 * Prefer higher specificity; break ties by more pattern hits, then by ratio.
 */
function isBetter(a, b) {
  if (!b) return true;
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  if (a.hits !== b.hits) return a.hits > b.hits;
  return a.hits / a.total > b.hits / b.total;
}

/**
 * Confidence in [0, 1]. Specific, clearly-matched fields are HIGH; a lone
 * generic match is dampened so ambiguous descriptors stay below threshold.
 */
function confidenceFor(best) {
  // Base from specificity (10 -> ~1.0, 3 -> ~0.5).
  const specScore = Math.min(best.specificity / 10, 1);
  // A clear specific match is confident; generic-only matches are dampened.
  if (best.specificity >= 7) return Math.max(0.7, specScore);
  if (best.specificity >= 5) return Math.max(0.55, specScore);
  // generic name rule (specificity 3): low confidence on its own.
  return 0.35;
}

function matchCustomFields(tokens, profile) {
  const custom = profile?.customFields;
  if (!custom || typeof custom !== 'object') return null;
  for (const key of Object.keys(custom)) {
    if (!custom[key]) continue;
    const norm = String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]+/g, ' ')
      .trim()
      .toLowerCase();
    const re = new RegExp(`\\b${escapeRegex(norm)}\\b`, 'i');
    if (re.test(tokens)) return '__custom__' + key;
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAutocomplete(ac) {
  return typeof ac === 'string' ? ac.trim().toLowerCase() : '';
}

/**
 * Autocomplete attribute -> profile key (exact). null means "intentionally
 * ignore" (e.g. additional-name).
 */
export const AUTOCOMPLETE_MAP = Object.freeze({
  'given-name': 'firstName',
  'additional-name': null,
  'family-name': 'lastName',
  'name': 'fullName',
  'email': 'email',
  'tel': 'phone',
  'tel-national': 'phone',
  'address-line1': 'address1',
  'address-line2': 'address2',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  'country': 'country',
  'country-name': 'country',
  'organization': 'company',
  'organization-title': 'jobTitle',
  'url': 'website',
  'bday': 'birthDate',
});

/**
 * Resolve a profile key (including __custom__ keys) to its value, or null.
 */
export function resolveProfileValue(profileKey, profile) {
  if (!profileKey || !profile) return null;
  if (profileKey.startsWith('__custom__')) {
    const ck = profileKey.slice('__custom__'.length);
    const v = profile.customFields?.[ck];
    return v === undefined ? null : v;
  }
  const v = profile[profileKey];
  return v === undefined ? null : v;
}
