/**
 * AutoFill AnyForm — Content Script v2
 * Scans the active page for form fields and fills them from the user's profile
 * using a heuristic keyword/scoring matcher, with optional LLM second pass.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const HIGHLIGHT_FILLED_CLASS    = 'autofill-anyform-filled';
const HIGHLIGHT_UNMATCHED_CLASS = 'autofill-anyform-unmatched';
const HIGHLIGHT_DURATION_MS     = 2000;
const CONFIDENCE_THRESHOLD      = 0.4; // below this → low-confidence

/**
 * Scoring map: profile key → array of regex patterns.
 * Each pattern awards +1 point when it matches a field descriptor token.
 * Higher score → better match. Ties resolved by key order (first wins).
 */
const SCORE_MAP = Object.freeze({
  firstName:  [/\bfirst[\s_-]?name\b/i, /\bfname\b/i, /\bgiven[\s_-]?name\b/i, /\bforename\b/i],
  lastName:   [/\blast[\s_-]?name\b/i, /\blname\b/i, /\bsurname\b/i, /\bfamily[\s_-]?name\b/i],
  fullName:   [/\bfull[\s_-]?name\b/i, /\byour[\s_-]?name\b/i, /\bname\b/i],
  email:      [/\be[\s_-]?mail\b/i, /\bemail\b/i, /\buser@\b/i],
  phone:      [/\bphone\b/i, /\btel\b/i, /\bmobile\b/i, /\bcell\b/i, /\bcontact[\s_-]?no\b/i],
  address1:   [/\baddress[\s_-]?1\b/i, /\baddr[\s_-]?1\b/i, /\bstreet\b/i, /\bline[\s_-]?1\b/i, /\baddress\b/i],
  address2:   [/\baddress[\s_-]?2\b/i, /\bapt\b/i, /\bsuite\b/i, /\bunit\b/i, /\bline[\s_-]?2\b/i],
  city:       [/\bcity\b/i, /\btown\b/i, /\blocality\b/i],
  state:      [/\bstate\b/i, /\bregion\b/i, /\bprovince\b/i, /\bcounty\b/i],
  postalCode: [/\bzip\b/i, /\bpostal\b/i, /\bpost[\s_-]?code\b/i, /\bpin[\s_-]?code\b/i],
  country:    [/\bcountry\b/i, /\bnation\b/i],
  company:    [/\bcompany\b/i, /\borganiz[as]tion\b/i, /\bemployer\b/i, /\bfirm\b/i, /\bbusiness\b/i],
  jobTitle:   [/\bjob[\s_-]?title\b/i, /\btitle\b/i, /\bposition\b/i, /\brole\b/i, /\boccupation\b/i],
  website:    [/\bwebsite\b/i, /\bweb[\s_-]?url\b/i, /\burl\b/i, /\bhomepage\b/i, /\bsite\b/i],
  birthDate:  [/\bbirth[\s_-]?date\b/i, /\bdob\b/i, /\bdate[\s_-]?of[\s_-]?birth\b/i, /\bbirthday\b/i],
});

/**
 * Autocomplete attribute → profile key mapping (exact).
 * Takes priority over heuristic scoring when present.
 */
const AUTOCOMPLETE_MAP = Object.freeze({
  'given-name':         'firstName',
  'additional-name':    null,
  'family-name':        'lastName',
  'name':               'fullName',
  'email':              'email',
  'tel':                'phone',
  'tel-national':       'phone',
  'address-line1':      'address1',
  'address-line2':      'address2',
  'address-level2':     'city',
  'address-level1':     'state',
  'postal-code':        'postalCode',
  'country':            'country',
  'country-name':       'country',
  'organization':       'company',
  'organization-title': 'jobTitle',
  'url':                'website',
  'bday':               'birthDate',
});

// ── State ──────────────────────────────────────────────────────────────────

let stylesInjected = false;

// ── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DO_FILL') {
    handleDoFill(message, sendResponse);
    return true; // async
  }
  if (message.type === 'APPLY_LLM_MAPPINGS') {
    try {
      const result = applyLlmMappings(message.mappings, message.fieldRefs, message.profile);
      sendResponse(result);
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  if (message.type === 'CLEAR_HIGHLIGHTS') {
    clearUnmatchedHighlights();
    sendResponse({ success: true });
  }
});

// ── Main fill orchestration ────────────────────────────────────────────────

async function handleDoFill(message, sendResponse) {
  try {
    const result = await fillPage(message.profile, message.useLlm, message.highlightUnmatched);
    sendResponse(result);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function fillPage(profile, useLlm, highlightUnmatched) {
  if (!profile || typeof profile !== 'object') {
    return { success: false, error: 'No profile data provided.' };
  }

  injectHighlightStyles();

  const fields = collectFillableFields();
  if (fields.length === 0) {
    return {
      success: true,
      filled: 0,
      skipped: 0,
      lowConfidence: 0,
      unmatched: [],
      message: 'No form fields found on this page.',
    };
  }

  const results = fields.map(fieldEl => attemptFill(fieldEl, profile));

  const filled       = results.filter(r => r.filled && r.confidence >= CONFIDENCE_THRESHOLD).length;
  const lowConf      = results.filter(r => r.filled && r.confidence < CONFIDENCE_THRESHOLD).length;
  const skipped      = results.filter(r => !r.filled && !r.needsLlm).length;
  const unmatchedRes = results.filter(r => r.needsLlm);
  const unmatched    = unmatchedRes.map(r => r.descriptor);

  if (highlightUnmatched) {
    unmatchedRes.forEach(r => r.element && highlightUnmatchedField(r.element));
  }

  return {
    success: true,
    filled: filled + lowConf,
    lowConfidence: lowConf,
    skipped,
    unmatched,
    message: buildSummaryMessage(filled + lowConf, skipped, unmatched.length),
  };
}

function buildSummaryMessage(filled, skipped, unmatchedCount) {
  const parts = [`Filled ${filled} field${filled !== 1 ? 's' : ''}.`];
  if (skipped > 0)       parts.push(`${skipped} skipped (no match).`);
  if (unmatchedCount > 0) parts.push(`${unmatchedCount} could use LLM mapping.`);
  return parts.join(' ');
}

// ── LLM result application ─────────────────────────────────────────────────

/**
 * Called after the service worker gets LLM mappings back.
 * mappings: { "0": "firstName", "2": null, ... }
 * fieldRefs: array of descriptors (indexed same as when sent)
 * We re-collect fields, find matching descriptors, and fill.
 */
function applyLlmMappings(mappings, fieldDescriptors, profile) {
  if (!mappings || typeof mappings !== 'object') {
    return { success: false, error: 'Invalid LLM mappings.' };
  }

  const fields = collectFillableFields();
  let applied = 0;

  for (const [indexStr, profileKey] of Object.entries(mappings)) {
    if (!profileKey) continue;

    const index = parseInt(indexStr, 10);
    const descriptor = fieldDescriptors[index];
    if (!descriptor) continue;

    // Find the field element that matches this descriptor
    const fieldEl = findFieldByDescriptor(fields, descriptor);
    if (!fieldEl) continue;

    const value = resolveProfileValue(profileKey, profile);
    if (value === null || value === undefined || value === '') continue;

    setFieldValue(fieldEl, value);
    highlightFilledField(fieldEl);
    applied++;
  }

  return { success: true, applied };
}

function findFieldByDescriptor(fields, descriptor) {
  return fields.find(f => {
    const d = buildFieldDescriptor(f);
    return d.name === descriptor.name && d.id === descriptor.id && d.type === descriptor.type;
  }) ?? null;
}

// ── Field collection ───────────────────────────────────────────────────────

function collectFillableFields() {
  const selector = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
    ':not([type="reset"]):not([type="image"]):not([type="file"])',
    ':not([disabled]):not([readonly])',
    ', select:not([disabled]):not([readonly])',
    ', textarea:not([disabled]):not([readonly])',
  ].join('');
  return Array.from(document.querySelectorAll(selector));
}

// ── Per-field fill attempt ─────────────────────────────────────────────────

function attemptFill(fieldEl, profile) {
  const descriptor = buildFieldDescriptor(fieldEl);
  const { profileKey, confidence } = resolveProfileKey(descriptor, profile);

  if (profileKey === null) {
    return { filled: false, needsLlm: true, descriptor, element: fieldEl, confidence: 0 };
  }

  const value = resolveProfileValue(profileKey, profile);
  if (value === null || value === undefined || value === '') {
    return { filled: false, needsLlm: false, descriptor, element: fieldEl, confidence };
  }

  setFieldValue(fieldEl, value);
  highlightFilledField(fieldEl);
  return { filled: true, needsLlm: false, descriptor, element: fieldEl, confidence };
}

// ── Field descriptor builder ───────────────────────────────────────────────

function buildFieldDescriptor(fieldEl) {
  const autocomplete = (fieldEl.getAttribute('autocomplete') || '').trim().toLowerCase();
  const name         = (fieldEl.getAttribute('name') || '').trim();
  const id           = (fieldEl.getAttribute('id') || '').trim();
  const placeholder  = (fieldEl.getAttribute('placeholder') || '').trim();
  const ariaLabel    = (fieldEl.getAttribute('aria-label') || '').trim();
  const labelText    = findLabelText(fieldEl);
  const type         = (fieldEl.getAttribute('type') || fieldEl.tagName.toLowerCase()).toLowerCase();

  return Object.freeze({ autocomplete, name, id, placeholder, ariaLabel, labelText, type });
}

function findLabelText(fieldEl) {
  if (fieldEl.id) {
    const label = document.querySelector(`label[for="${CSS.escape(fieldEl.id)}"]`);
    if (label) return label.textContent.trim();
  }
  const parent = fieldEl.closest('label');
  if (parent) return parent.textContent.trim();
  const labelledBy = fieldEl.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent.trim();
  }
  return '';
}

// ── Profile key resolution ─────────────────────────────────────────────────

function resolveProfileKey(descriptor, profile) {
  // Step 1: autocomplete attribute takes priority — confidence = 1.0
  if (descriptor.autocomplete && Object.prototype.hasOwnProperty.call(AUTOCOMPLETE_MAP, descriptor.autocomplete)) {
    const key = AUTOCOMPLETE_MAP[descriptor.autocomplete];
    if (key !== null) return { profileKey: key, confidence: 1.0 };
  }

  // Step 2: heuristic scoring
  const tokens = buildTokenString(descriptor);
  const { key: bestKey, score, maxScore } = scoreTokensAgainstMap(tokens, profile);
  if (bestKey) {
    const confidence = maxScore > 0 ? Math.min(score / maxScore, 1) : 0;
    return { profileKey: bestKey, confidence };
  }

  // Step 3: custom fields
  const customKey = matchCustomFields(tokens, profile);
  if (customKey) return { profileKey: customKey, confidence: 0.8 };

  return { profileKey: null, confidence: 0 };
}

function buildTokenString(descriptor) {
  return [
    descriptor.labelText,
    descriptor.ariaLabel,
    descriptor.placeholder,
    descriptor.name,
    descriptor.id,
  ].join(' ').toLowerCase();
}

function scoreTokensAgainstMap(tokens, profile) {
  let bestKey   = null;
  let bestScore = 0;
  let maxScore  = 0;

  for (const [key, patterns] of Object.entries(SCORE_MAP)) {
    if (!hasProfileValue(key, profile)) continue;

    const score = patterns.reduce((acc, pattern) => pattern.test(tokens) ? acc + 1 : acc, 0);
    if (score > bestScore) {
      bestScore = score;
      bestKey   = key;
      maxScore  = patterns.length;
    }
  }

  return { key: bestScore > 0 ? bestKey : null, score: bestScore, maxScore };
}

function matchCustomFields(tokens, profile) {
  const custom = profile.customFields;
  if (!custom || typeof custom !== 'object') return null;

  for (const key of Object.keys(custom)) {
    const pattern = new RegExp('\\b' + escapeRegex(key) + '\\b', 'i');
    if (pattern.test(tokens) && custom[key]) {
      return '__custom__' + key;
    }
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasProfileValue(key, profile) {
  const val = profile[key];
  return val !== null && val !== undefined && val !== '';
}

function resolveProfileValue(profileKey, profile) {
  if (profileKey.startsWith('__custom__')) {
    const customKey = profileKey.slice('__custom__'.length);
    return profile.customFields?.[customKey] ?? null;
  }
  return profile[profileKey] ?? null;
}

// ── Field value setter ─────────────────────────────────────────────────────

function setFieldValue(fieldEl, value) {
  const tag  = fieldEl.tagName.toLowerCase();
  const type = (fieldEl.type || '').toLowerCase();

  if (tag === 'select') {
    setSelectValue(fieldEl, value);
  } else if (type === 'checkbox') {
    setCheckboxValue(fieldEl, value);
  } else if (type === 'radio') {
    setRadioValue(fieldEl, value);
  } else if (type === 'date') {
    setDateValue(fieldEl, value);
  } else {
    setTextValue(fieldEl, value);
  }
}

function setTextValue(fieldEl, value) {
  const strValue = String(value);
  const tag      = fieldEl.tagName.toLowerCase();

  const nativeInputSetter    = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (tag === 'textarea' && nativeTextareaSetter) {
    nativeTextareaSetter.call(fieldEl, strValue);
  } else if (nativeInputSetter) {
    nativeInputSetter.call(fieldEl, strValue);
  } else {
    fieldEl.value = strValue;
  }

  dispatchEvents(fieldEl);
}

function setSelectValue(fieldEl, value) {
  const strValue = String(value).toLowerCase();
  let matched = false;

  for (const option of fieldEl.options) {
    const optText  = option.text.toLowerCase();
    const optValue = option.value.toLowerCase();
    if (optValue === strValue || optText === strValue || optText.includes(strValue) || strValue.includes(optValue)) {
      fieldEl.value = option.value;
      matched = true;
      break;
    }
  }

  if (matched) dispatchEvents(fieldEl);
}

function setCheckboxValue(fieldEl, value) {
  const checked = /^(true|yes|1|on)$/i.test(String(value));
  if (fieldEl.checked !== checked) {
    fieldEl.checked = checked;
    dispatchEvents(fieldEl);
  }
}

function setRadioValue(fieldEl, value) {
  const strValue   = String(value).toLowerCase();
  const radioGroup = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(fieldEl.name)}"]`);
  for (const radio of radioGroup) {
    if (radio.value.toLowerCase() === strValue || radio.labels?.[0]?.textContent?.toLowerCase().trim() === strValue) {
      radio.checked = true;
      dispatchEvents(radio);
      break;
    }
  }
}

function setDateValue(fieldEl, value) {
  // Accept ISO date (YYYY-MM-DD) or try to parse common formats
  const strValue = String(value).trim();
  // Already ISO format?
  if (/^\d{4}-\d{2}-\d{2}$/.test(strValue)) {
    setTextValue(fieldEl, strValue);
    return;
  }
  // Try parsing
  const parsed = new Date(strValue);
  if (!isNaN(parsed.getTime())) {
    const iso = parsed.toISOString().split('T')[0];
    setTextValue(fieldEl, iso);
  }
}

function dispatchEvents(fieldEl) {
  for (const name of ['input', 'change', 'blur']) {
    fieldEl.dispatchEvent(new Event(name, { bubbles: true }));
  }
}

// ── Visual highlight ───────────────────────────────────────────────────────

function highlightFilledField(fieldEl) {
  fieldEl.classList.remove(HIGHLIGHT_UNMATCHED_CLASS);
  fieldEl.classList.add(HIGHLIGHT_FILLED_CLASS);
  setTimeout(() => fieldEl.classList.remove(HIGHLIGHT_FILLED_CLASS), HIGHLIGHT_DURATION_MS);
}

function highlightUnmatchedField(fieldEl) {
  if (!fieldEl.classList.contains(HIGHLIGHT_FILLED_CLASS)) {
    fieldEl.classList.add(HIGHLIGHT_UNMATCHED_CLASS);
  }
}

function clearUnmatchedHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_UNMATCHED_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_UNMATCHED_CLASS);
  });
}

function injectHighlightStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .${HIGHLIGHT_FILLED_CLASS} {
      outline: 2px solid #4f9ef8 !important;
      background-color: #eef6ff !important;
      transition: outline 0.3s ease, background-color 0.3s ease;
    }
    .${HIGHLIGHT_UNMATCHED_CLASS} {
      outline: 2px solid #f59e0b !important;
      background-color: #fffbeb !important;
    }
  `;
  document.head.appendChild(style);
}
