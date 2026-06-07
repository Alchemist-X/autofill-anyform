/**
 * AutoFill AnyForm — Content Script
 * Scans the active page for form fields and fills them from the user's profile
 * using a heuristic keyword/scoring matcher.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const HIGHLIGHT_CLASS = 'autofill-anyform-highlight';
const HIGHLIGHT_DURATION_MS = 1800;

/**
 * Scoring map: profile key → array of regex patterns.
 * Each pattern awards +1 point when it matches a field descriptor token.
 * Higher score → better match. Ties resolved by key order (first wins).
 */
const SCORE_MAP = Object.freeze({
  firstName:   [/\bfirst[\s_-]?name\b/i, /\bfname\b/i, /\bgiven[\s_-]?name\b/i, /\bforename\b/i],
  lastName:    [/\blast[\s_-]?name\b/i, /\blname\b/i, /\bsurname\b/i, /\bfamily[\s_-]?name\b/i],
  fullName:    [/\bfull[\s_-]?name\b/i, /\byour[\s_-]?name\b/i, /\bname\b/i],
  email:       [/\be[\s_-]?mail\b/i, /\bemail\b/i, /\buser@\b/i],
  phone:       [/\bphone\b/i, /\btel\b/i, /\bmobile\b/i, /\bcell\b/i, /\bcontact[\s_-]?no\b/i],
  address1:    [/\baddress[\s_-]?1\b/i, /\baddr[\s_-]?1\b/i, /\bstreet\b/i, /\bline[\s_-]?1\b/i, /\baddress\b/i],
  address2:    [/\baddress[\s_-]?2\b/i, /\bapt\b/i, /\bsuite\b/i, /\bunit\b/i, /\bline[\s_-]?2\b/i],
  city:        [/\bcity\b/i, /\btown\b/i, /\blocality\b/i],
  state:       [/\bstate\b/i, /\bregion\b/i, /\bprovince\b/i, /\bcounty\b/i],
  postalCode:  [/\bzip\b/i, /\bpostal\b/i, /\bpost[\s_-]?code\b/i, /\bpin[\s_-]?code\b/i],
  country:     [/\bcountry\b/i, /\bnation\b/i],
  company:     [/\bcompany\b/i, /\borganiz[as]tion\b/i, /\bemployer\b/i, /\bfirm\b/i, /\bbusiness\b/i],
  jobTitle:    [/\bjob[\s_-]?title\b/i, /\btitle\b/i, /\bposition\b/i, /\brole\b/i, /\boccupation\b/i],
  website:     [/\bwebsite\b/i, /\bweb[\s_-]?url\b/i, /\burl\b/i, /\bhomepage\b/i, /\bsite\b/i],
});

/**
 * Autocomplete attribute → profile key mapping (exact).
 * Takes priority over heuristic scoring when present.
 */
const AUTOCOMPLETE_MAP = Object.freeze({
  'given-name':      'firstName',
  'additional-name': null,
  'family-name':     'lastName',
  'name':            'fullName',
  'email':           'email',
  'tel':             'phone',
  'tel-national':    'phone',
  'address-line1':   'address1',
  'address-line2':   'address2',
  'address-level2':  'city',
  'address-level1':  'state',
  'postal-code':     'postalCode',
  'country':         'country',
  'country-name':    'country',
  'organization':    'company',
  'organization-title': 'jobTitle',
  'url':             'website',
});

// ── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DO_FILL') {
    try {
      const result = fillPage(message.profile, message.useLlm);
      sendResponse(result);
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  // Return false — fillPage is synchronous; no async needed here.
});

// ── Main fill orchestration ────────────────────────────────────────────────

function fillPage(profile, useLlm) {
  if (!profile || typeof profile !== 'object') {
    return { success: false, error: 'No profile data provided.' };
  }

  const fields = collectFillableFields();
  if (fields.length === 0) {
    return { success: true, filled: 0, skipped: 0, unmatched: [], message: 'No form fields found on this page.' };
  }

  const results = fields.map(fieldEl => attemptFill(fieldEl, profile));

  const filled = results.filter(r => r.filled).length;
  const skipped = results.filter(r => !r.filled && !r.needsLlm).length;
  const unmatched = results.filter(r => r.needsLlm).map(r => r.descriptor);

  return {
    success: true,
    filled,
    skipped,
    unmatched,
    message: buildSummaryMessage(filled, skipped, unmatched.length),
  };
}

function buildSummaryMessage(filled, skipped, unmatchedCount) {
  const parts = [`Filled ${filled} field${filled !== 1 ? 's' : ''}.`];
  if (skipped > 0) parts.push(`${skipped} skipped (no match).`);
  if (unmatchedCount > 0) parts.push(`${unmatchedCount} could use LLM mapping.`);
  return parts.join(' ');
}

// ── Field collection ───────────────────────────────────────────────────────

function collectFillableFields() {
  const selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]):not([disabled]):not([readonly]), select:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])';
  return Array.from(document.querySelectorAll(selector));
}

// ── Per-field fill attempt ─────────────────────────────────────────────────

function attemptFill(fieldEl, profile) {
  const descriptor = buildFieldDescriptor(fieldEl);
  const profileKey = resolveProfileKey(descriptor, profile);

  if (profileKey === null) {
    return { filled: false, needsLlm: true, descriptor };
  }

  const value = resolveProfileValue(profileKey, profile);
  if (value === null || value === undefined || value === '') {
    return { filled: false, needsLlm: false, descriptor };
  }

  setFieldValue(fieldEl, value);
  highlightField(fieldEl);
  return { filled: true, needsLlm: false, descriptor };
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
  // 1. Explicit label via id
  if (fieldEl.id) {
    const label = document.querySelector(`label[for="${CSS.escape(fieldEl.id)}"]`);
    if (label) return label.textContent.trim();
  }
  // 2. Wrapping label ancestor
  const parent = fieldEl.closest('label');
  if (parent) return parent.textContent.trim();
  // 3. aria-labelledby
  const labelledBy = fieldEl.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent.trim();
  }
  return '';
}

// ── Profile key resolution ─────────────────────────────────────────────────

function resolveProfileKey(descriptor, profile) {
  // Step 1: autocomplete attribute takes priority
  if (descriptor.autocomplete && AUTOCOMPLETE_MAP.hasOwnProperty(descriptor.autocomplete)) {
    const key = AUTOCOMPLETE_MAP[descriptor.autocomplete];
    if (key !== null) return key;
  }

  // Step 2: heuristic scoring across all text tokens
  const tokens = buildTokenString(descriptor);
  const bestKey = scoreTokensAgainstMap(tokens, profile);
  if (bestKey) return bestKey;

  // Step 3: custom fields — check if any custom key appears in tokens
  const customKey = matchCustomFields(tokens, profile);
  if (customKey) return customKey;

  return null; // unmatched
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
  let bestKey = null;
  let bestScore = 0;

  for (const [key, patterns] of Object.entries(SCORE_MAP)) {
    // Only attempt to match keys the profile actually has a value for
    if (!hasProfileValue(key, profile)) continue;

    const score = patterns.reduce((acc, pattern) => {
      return pattern.test(tokens) ? acc + 1 : acc;
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  return bestScore > 0 ? bestKey : null;
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
  const tag = fieldEl.tagName.toLowerCase();

  if (tag === 'select') {
    setSelectValue(fieldEl, value);
  } else if (fieldEl.type === 'checkbox') {
    setCheckboxValue(fieldEl, value);
  } else if (fieldEl.type === 'radio') {
    setRadioValue(fieldEl, value);
  } else {
    setTextValue(fieldEl, value);
  }
}

function setTextValue(fieldEl, value) {
  const strValue = String(value);

  // Use React's synthetic event system if present, otherwise fall back to native
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  if (fieldEl.tagName.toLowerCase() === 'textarea' && nativeTextareaSetter) {
    nativeTextareaSetter.call(fieldEl, strValue);
  } else if (nativeInputValueSetter) {
    nativeInputValueSetter.call(fieldEl, strValue);
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
    if (optValue === strValue || optText === strValue || optText.includes(strValue)) {
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
  const strValue = String(value).toLowerCase();
  const radioGroup = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(fieldEl.name)}"]`);
  for (const radio of radioGroup) {
    if (radio.value.toLowerCase() === strValue) {
      radio.checked = true;
      dispatchEvents(radio);
      break;
    }
  }
}

function dispatchEvents(fieldEl) {
  const eventNames = ['input', 'change', 'blur'];
  for (const name of eventNames) {
    fieldEl.dispatchEvent(new Event(name, { bubbles: true }));
  }
}

// ── Visual highlight ───────────────────────────────────────────────────────

function highlightField(fieldEl) {
  injectHighlightStyles();
  fieldEl.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => {
    fieldEl.classList.remove(HIGHLIGHT_CLASS);
  }, HIGHLIGHT_DURATION_MS);
}

let stylesInjected = false;

function injectHighlightStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid #4f9ef8 !important;
      background-color: #eef6ff !important;
      transition: outline 0.3s ease, background-color 0.3s ease;
    }
  `;
  document.head.appendChild(style);
}
