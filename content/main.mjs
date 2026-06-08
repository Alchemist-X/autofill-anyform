/**
 * AutoFill AnyForm — Content module (DOM orchestration).
 *
 * This is an ES module loaded by the classic bootstrap (content.js) via a
 * dynamic import. It imports the PURE, unit-tested logic modules and applies
 * their decisions to the live DOM. Keeping the pure logic in match.mjs /
 * fields.mjs / apply-llm.mjs means the browser and the test suite share one
 * implementation.
 */

'use strict';

import { matchField, resolveProfileValue, CONFIDENCE_THRESHOLD } from './match.mjs';
import {
  matchSelectOption, toCheckboxState, matchRadioValue, toIsoDate,
} from './fields.mjs';
import { applyLlmMappings } from './apply-llm.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const HIGHLIGHT_FILLED_CLASS = 'autofill-anyform-filled';
const HIGHLIGHT_UNMATCHED_CLASS = 'autofill-anyform-unmatched';
const HIGHLIGHT_DURATION_MS = 2000;

let stylesInjected = false;

// ── Public entry: wire the message listener ──────────────────────────────────

export function init() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'DO_FILL') {
      handleDoFill(message, sendResponse);
      return true; // async
    }
    if (message.type === 'APPLY_LLM_MAPPINGS') {
      try {
        const result = applyLlmToDom(message.mappings, message.fieldRefs, message.profile);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
    if (message.type === 'CLEAR_HIGHLIGHTS') {
      clearUnmatchedHighlights();
      sendResponse({ success: true });
      return false;
    }
    return false;
  });
}

// ── Fill orchestration ───────────────────────────────────────────────────────

async function handleDoFill(message, sendResponse) {
  try {
    const result = fillPage(message.profile, message.highlightUnmatched);
    sendResponse(result);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

function fillPage(profile, highlightUnmatched) {
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

  const filled = results.filter(r => r.filled && r.confidence >= CONFIDENCE_THRESHOLD).length;
  const lowConf = results.filter(r => r.filled && r.confidence < CONFIDENCE_THRESHOLD).length;
  const skipped = results.filter(r => !r.filled && !r.needsLlm).length;
  const unmatchedRes = results.filter(r => r.needsLlm);
  const unmatched = unmatchedRes.map(r => r.descriptor);

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
  if (skipped > 0) parts.push(`${skipped} skipped (no match).`);
  if (unmatchedCount > 0) parts.push(`${unmatchedCount} could use LLM mapping.`);
  return parts.join(' ');
}

// ── Per-field fill attempt ───────────────────────────────────────────────────

function attemptFill(fieldEl, profile) {
  const descriptor = buildFieldDescriptor(fieldEl);
  const { key, confidence } = matchField(descriptor, profile);

  if (key === null) {
    return { filled: false, needsLlm: true, descriptor, element: fieldEl, confidence: 0 };
  }
  if (confidence < CONFIDENCE_THRESHOLD) {
    // Low confidence: defer to LLM rather than risk a wrong fill.
    return { filled: false, needsLlm: true, descriptor, element: fieldEl, confidence };
  }

  const value = resolveProfileValue(key, profile);
  if (value === null || value === undefined || value === '') {
    return { filled: false, needsLlm: false, descriptor, element: fieldEl, confidence };
  }

  setFieldValue(fieldEl, value);
  highlightFilledField(fieldEl);
  return { filled: true, needsLlm: false, descriptor, element: fieldEl, confidence };
}

// ── LLM mapping application (pure compute -> DOM write) ───────────────────────

function applyLlmToDom(mappings, fieldDescriptors, profile) {
  const fills = applyLlmMappings(mappings, fieldDescriptors, profile);
  const fields = collectFillableFields();
  let applied = 0;

  for (const { descriptor, value } of fills) {
    const fieldEl = findFieldByDescriptor(fields, descriptor);
    if (!fieldEl) continue;
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

// ── Field collection ─────────────────────────────────────────────────────────

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

// ── Field descriptor builder ─────────────────────────────────────────────────

function buildFieldDescriptor(fieldEl) {
  const autocomplete = (fieldEl.getAttribute('autocomplete') || '').trim().toLowerCase();
  const name = (fieldEl.getAttribute('name') || '').trim();
  const id = (fieldEl.getAttribute('id') || '').trim();
  const placeholder = (fieldEl.getAttribute('placeholder') || '').trim();
  const ariaLabel = (fieldEl.getAttribute('aria-label') || '').trim();
  const labelText = findLabelText(fieldEl);
  const type = (fieldEl.getAttribute('type') || fieldEl.tagName.toLowerCase()).toLowerCase();

  return Object.freeze({ autocomplete, name, id, placeholder, ariaLabel, labelText, label: labelText, type });
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

// ── Field value setter (uses pure helpers to decide values) ──────────────────

function setFieldValue(fieldEl, value) {
  const tag = fieldEl.tagName.toLowerCase();
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
  const tag = fieldEl.tagName.toLowerCase();

  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
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
  const options = Array.from(fieldEl.options).map(o => ({ value: o.value, text: o.text }));
  const chosen = matchSelectOption(value, options);
  if (chosen === null) return;
  fieldEl.value = chosen;
  dispatchEvents(fieldEl);
}

function setCheckboxValue(fieldEl, value) {
  const checked = toCheckboxState(value);
  if (fieldEl.checked !== checked) {
    fieldEl.checked = checked;
    dispatchEvents(fieldEl);
  }
}

function setRadioValue(fieldEl, value) {
  const radioGroup = Array.from(
    document.querySelectorAll(`input[type="radio"][name="${CSS.escape(fieldEl.name)}"]`),
  );
  const group = radioGroup.map(r => ({
    value: r.value,
    label: r.labels?.[0]?.textContent?.trim() ?? '',
  }));
  const chosen = matchRadioValue(value, group);
  if (chosen === null) return;
  const target = radioGroup.find(r => r.value === chosen);
  if (target) {
    target.checked = true;
    dispatchEvents(target);
  }
}

function setDateValue(fieldEl, value) {
  const iso = toIsoDate(value);
  if (iso) setTextValue(fieldEl, iso);
}

function dispatchEvents(fieldEl) {
  for (const name of ['input', 'change', 'blur']) {
    fieldEl.dispatchEvent(new Event(name, { bubbles: true }));
  }
}

// ── Visual highlight ─────────────────────────────────────────────────────────

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
