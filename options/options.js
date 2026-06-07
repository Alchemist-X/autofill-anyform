/**
 * AutoFill AnyForm — Options Page Script
 * Loads/saves the user profile and LLM config to chrome.storage.local.
 * Uses immutable update patterns throughout.
 */

'use strict';

// ── Profile field IDs (maps directly to storage keys) ─────────────────────

const PROFILE_FIELDS = Object.freeze([
  'firstName', 'lastName', 'fullName',
  'email', 'phone',
  'address1', 'address2', 'city', 'state', 'postalCode', 'country',
  'company', 'jobTitle', 'website',
]);

// ── DOM refs ───────────────────────────────────────────────────────────────

const alertEl          = document.getElementById('alert');
const alertText        = document.getElementById('alertText');
const saveBtn          = document.getElementById('saveBtn');
const clearBtn         = document.getElementById('clearBtn');
const addCustomField   = document.getElementById('addCustomField');
const customFieldsList = document.getElementById('customFieldsList');
const apiEndpointEl    = document.getElementById('apiEndpoint');
const llmModelEl       = document.getElementById('llmModel');
const apiKeyEl         = document.getElementById('apiKey');

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    const stored = await chrome.storage.local.get([
      'profile', 'apiKey', 'apiEndpoint', 'llmModel',
    ]);

    populateProfileFields(stored.profile ?? {});
    populateCustomFields(stored.profile?.customFields ?? {});
    populateLlmFields(stored);

    saveBtn.addEventListener('click', handleSave);
    clearBtn.addEventListener('click', handleClear);
    addCustomField.addEventListener('click', handleAddCustomField);
  } catch (err) {
    showAlert(`Failed to load saved data: ${err.message}`, 'error');
  }
}

// ── Populate helpers ───────────────────────────────────────────────────────

function populateProfileFields(profile) {
  for (const field of PROFILE_FIELDS) {
    const el = document.getElementById(field);
    if (el) el.value = profile[field] ?? '';
  }
}

function populateCustomFields(customFields) {
  // Clear existing rows
  customFieldsList.innerHTML = '';

  for (const [key, value] of Object.entries(customFields)) {
    appendCustomFieldRow(key, value);
  }
}

function populateLlmFields(stored) {
  apiEndpointEl.value = stored.apiEndpoint ?? '';
  llmModelEl.value    = stored.llmModel ?? '';
  apiKeyEl.value      = stored.apiKey ?? '';
}

// ── Save handler ───────────────────────────────────────────────────────────

async function handleSave() {
  try {
    const profile     = readProfileFromForm();
    const llmSettings = readLlmFromForm();

    // Immutable merge: store each concern separately
    await chrome.storage.local.set({
      profile,
      apiKey:      llmSettings.apiKey,
      apiEndpoint: llmSettings.apiEndpoint,
      llmModel:    llmSettings.llmModel,
    });

    showAlert('Profile saved successfully.', 'success');
  } catch (err) {
    showAlert(`Save failed: ${err.message}`, 'error');
  }
}

function readProfileFromForm() {
  const base = PROFILE_FIELDS.reduce((acc, field) => {
    const el = document.getElementById(field);
    return { ...acc, [field]: el ? el.value.trim() : '' };
  }, {});

  const customFields = readCustomFieldsFromForm();
  return Object.freeze({ ...base, customFields });
}

function readCustomFieldsFromForm() {
  const rows = customFieldsList.querySelectorAll('.custom-field-row');
  return Array.from(rows).reduce((acc, row) => {
    const keyEl   = row.querySelector('.custom-key');
    const valueEl = row.querySelector('.custom-value');
    const key   = keyEl?.value.trim() ?? '';
    const value = valueEl?.value.trim() ?? '';
    if (!key) return acc;
    return { ...acc, [key]: value };
  }, {});
}

function readLlmFromForm() {
  return Object.freeze({
    apiKey:      apiKeyEl.value.trim(),
    apiEndpoint: apiEndpointEl.value.trim(),
    llmModel:    llmModelEl.value.trim(),
  });
}

// ── Clear handler ──────────────────────────────────────────────────────────

async function handleClear() {
  const confirmed = window.confirm(
    'This will delete your entire profile, custom fields, and API key. Are you sure?'
  );
  if (!confirmed) return;

  try {
    await chrome.storage.local.clear();
    populateProfileFields({});
    populateCustomFields({});
    populateLlmFields({});
    showAlert('All data cleared.', 'success');
  } catch (err) {
    showAlert(`Clear failed: ${err.message}`, 'error');
  }
}

// ── Custom fields ──────────────────────────────────────────────────────────

function handleAddCustomField() {
  appendCustomFieldRow('', '');
}

function appendCustomFieldRow(key, value) {
  const row = document.createElement('div');
  row.className = 'custom-field-row';

  const keyInput = document.createElement('input');
  keyInput.type        = 'text';
  keyInput.className   = 'custom-key';
  keyInput.placeholder = 'Field name (e.g. Username)';
  keyInput.value       = key;
  keyInput.setAttribute('aria-label', 'Custom field name');

  const valueInput = document.createElement('input');
  valueInput.type        = 'text';
  valueInput.className   = 'custom-value';
  valueInput.placeholder = 'Value';
  valueInput.value       = value;
  valueInput.setAttribute('aria-label', 'Custom field value');

  const removeBtn = document.createElement('button');
  removeBtn.type      = 'button';
  removeBtn.className = 'btn-remove';
  removeBtn.textContent = '×';
  removeBtn.setAttribute('aria-label', 'Remove custom field');
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  customFieldsList.appendChild(row);

  keyInput.focus();
}

// ── Alert helper ───────────────────────────────────────────────────────────

function showAlert(message, type = 'success') {
  alertText.textContent = message;
  alertEl.className = type === 'error' ? 'alert error' : 'alert';
  alertEl.hidden = false;

  setTimeout(() => {
    alertEl.hidden = true;
  }, 4000);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

init();
