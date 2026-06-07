/**
 * AutoFill AnyForm — Options Page Script v2
 * Multi-profile CRUD, import/export, theme selector, LLM config,
 * custom fields. Uses immutable update patterns throughout.
 */

'use strict';

// ── Profile field IDs ──────────────────────────────────────────────────────

const PROFILE_FIELDS = Object.freeze([
  'firstName', 'lastName', 'fullName',
  'email', 'phone', 'birthDate',
  'address1', 'address2', 'city', 'state', 'postalCode', 'country',
  'company', 'jobTitle', 'website',
]);

// ── DOM refs ───────────────────────────────────────────────────────────────

const toastEl         = document.getElementById('toast');
const toastText       = document.getElementById('toastText');
const profileSelect   = document.getElementById('profileSelect');
const newProfileBtn   = document.getElementById('newProfileBtn');
const renameProfileBtn= document.getElementById('renameProfileBtn');
const deleteProfileBtn= document.getElementById('deleteProfileBtn');
const exportBtn       = document.getElementById('exportBtn');
const importFile      = document.getElementById('importFile');
const saveBtn         = document.getElementById('saveBtn');
const saveBtnBottom   = document.getElementById('saveBtnBottom');
const clearBtn        = document.getElementById('clearBtn');
const addCustomField  = document.getElementById('addCustomField');
const customFieldsList= document.getElementById('customFieldsList');
const apiEndpointEl   = document.getElementById('apiEndpoint');
const llmModelEl      = document.getElementById('llmModel');
const apiKeyEl        = document.getElementById('apiKey');
const toggleApiKey    = document.getElementById('toggleApiKey');
const themeRadios     = document.querySelectorAll('input[name="theme"]');
const navLinks        = document.querySelectorAll('.nav-link');

// ── In-memory state ────────────────────────────────────────────────────────

let state = {
  profiles:        {},  // { [id]: { name: string, data: ProfileData } }
  activeProfileId: null,
  theme:           'auto',
};

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    applyStoredTheme();

    const stored = await chrome.storage.local.get([
      'profiles', 'activeProfileId', 'apiKey', 'apiEndpoint', 'llmModel', 'theme',
    ]);

    // Migrate legacy single-profile storage if needed
    const profiles = stored.profiles ?? migrateLegacyProfile(stored);

    state = {
      ...state,
      profiles,
      activeProfileId: stored.activeProfileId ?? (Object.keys(profiles)[0] ?? null),
      theme:           stored.theme ?? 'auto',
    };

    if (!state.activeProfileId && Object.keys(profiles).length === 0) {
      const id = createNewProfile('Personal');
      state = { ...state, profiles: { ...state.profiles }, activeProfileId: id };
    }

    renderProfileSelect();
    loadProfileIntoForm(state.activeProfileId);
    populateLlmFields(stored);
    applyTheme(state.theme);
    setThemeRadio(state.theme);
    bindEvents();
    bindNavHighlight();
  } catch (err) {
    showToast(`Failed to load: ${err.message}`, 'error');
  }
}

// ── Legacy migration ───────────────────────────────────────────────────────

function migrateLegacyProfile(stored) {
  if (!stored.profile) return {};
  const id = generateId();
  return { [id]: { name: 'Personal', data: stored.profile } };
}

// ── Profile CRUD ───────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function createNewProfile(name) {
  const id      = generateId();
  const newProf = { name, data: buildEmptyProfileData() };
  state = { ...state, profiles: { ...state.profiles, [id]: newProf } };
  return id;
}

function buildEmptyProfileData() {
  return Object.freeze(
    PROFILE_FIELDS.reduce((acc, f) => ({ ...acc, [f]: '' }), { customFields: {} })
  );
}

function renderProfileSelect() {
  const ids = Object.keys(state.profiles);
  profileSelect.innerHTML = '';
  for (const id of ids) {
    const opt       = document.createElement('option');
    opt.value       = id;
    opt.textContent = state.profiles[id].name;
    profileSelect.appendChild(opt);
  }
  if (state.activeProfileId && ids.includes(state.activeProfileId)) {
    profileSelect.value = state.activeProfileId;
  }
}

function loadProfileIntoForm(profileId) {
  if (!profileId || !state.profiles[profileId]) return;
  const { data } = state.profiles[profileId];
  populateProfileFields(data);
  populateCustomFields(data.customFields ?? {});
}

// ── Populate helpers ───────────────────────────────────────────────────────

function populateProfileFields(data) {
  for (const field of PROFILE_FIELDS) {
    const el = document.getElementById(field);
    if (el) el.value = data[field] ?? '';
  }
}

function populateCustomFields(customFields) {
  customFieldsList.innerHTML = '';
  for (const [key, value] of Object.entries(customFields)) {
    appendCustomFieldRow(key, value);
  }
}

function populateLlmFields(stored) {
  apiEndpointEl.value = stored.apiEndpoint ?? '';
  llmModelEl.value    = stored.llmModel    ?? '';
  apiKeyEl.value      = stored.apiKey      ?? '';
}

// ── Read helpers ───────────────────────────────────────────────────────────

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
    const key   = row.querySelector('.custom-key')?.value.trim()   ?? '';
    const value = row.querySelector('.custom-value')?.value.trim() ?? '';
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

// ── Save handler ───────────────────────────────────────────────────────────

async function handleSave() {
  try {
    const profileData  = readProfileFromForm();
    const llmSettings  = readLlmFromForm();
    const activeId     = profileSelect.value;

    const updatedProfile = {
      name: state.profiles[activeId]?.name ?? 'Profile',
      data: profileData,
    };

    state = {
      ...state,
      activeProfileId: activeId,
      profiles: { ...state.profiles, [activeId]: updatedProfile },
    };

    await chrome.storage.local.set({
      profiles:        state.profiles,
      activeProfileId: activeId,
      apiKey:          llmSettings.apiKey,
      apiEndpoint:     llmSettings.apiEndpoint,
      llmModel:        llmSettings.llmModel,
    });

    showToast('Profile saved successfully.');
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

// ── New profile ────────────────────────────────────────────────────────────

async function handleNewProfile() {
  const name = window.prompt('Profile name:', 'New Profile');
  if (!name?.trim()) return;

  const id = createNewProfile(name.trim());
  state = { ...state, activeProfileId: id };

  renderProfileSelect();
  profileSelect.value = id;
  loadProfileIntoForm(id);

  try {
    await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: id });
    showToast(`Profile "${name.trim()}" created.`);
  } catch (err) {
    showToast(`Could not save: ${err.message}`, 'error');
  }
}

// ── Rename profile ─────────────────────────────────────────────────────────

async function handleRenameProfile() {
  const activeId = profileSelect.value;
  if (!activeId) return;

  const currentName = state.profiles[activeId]?.name ?? '';
  const newName     = window.prompt('New name:', currentName);
  if (!newName?.trim() || newName.trim() === currentName) return;

  const updated = { ...state.profiles[activeId], name: newName.trim() };
  state = { ...state, profiles: { ...state.profiles, [activeId]: updated } };

  renderProfileSelect();
  profileSelect.value = activeId;

  try {
    await chrome.storage.local.set({ profiles: state.profiles });
    showToast(`Renamed to "${newName.trim()}".`);
  } catch (err) {
    showToast(`Rename failed: ${err.message}`, 'error');
  }
}

// ── Delete profile ─────────────────────────────────────────────────────────

async function handleDeleteProfile() {
  const activeId = profileSelect.value;
  if (!activeId) return;

  const profileName = state.profiles[activeId]?.name ?? activeId;
  const ids         = Object.keys(state.profiles);

  if (ids.length <= 1) {
    showToast('Cannot delete the only profile.', 'error');
    return;
  }

  if (!window.confirm(`Delete profile "${profileName}"? This cannot be undone.`)) return;

  const { [activeId]: _removed, ...remaining } = state.profiles;
  const newActiveId = Object.keys(remaining)[0];

  state = { ...state, profiles: remaining, activeProfileId: newActiveId };

  renderProfileSelect();
  profileSelect.value = newActiveId;
  loadProfileIntoForm(newActiveId);

  try {
    await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: newActiveId });
    showToast(`Profile "${profileName}" deleted.`);
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

function handleExport() {
  const activeId = profileSelect.value;
  if (!activeId) return;

  const profileData = readProfileFromForm();
  const exportObj   = {
    name:    state.profiles[activeId]?.name ?? 'Profile',
    data:    profileData,
    version: '2',
  };

  const blob     = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url      = URL.createObjectURL(blob);
  const anchor   = document.createElement('a');
  anchor.href    = url;
  anchor.download = `autofill-profile-${(exportObj.name).replace(/\s+/g, '-').toLowerCase()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Import ─────────────────────────────────────────────────────────────────

async function handleImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  // Reset input so the same file can be reimported
  importFile.value = '';

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== 'object') {
      showToast('Invalid profile file.', 'error');
      return;
    }

    const name = parsed.name ?? file.name.replace('.json', '');
    const data = parsed.data ?? parsed; // support both v2 and raw profile objects
    const id   = generateId();

    state = {
      ...state,
      profiles: { ...state.profiles, [id]: { name, data } },
      activeProfileId: id,
    };

    renderProfileSelect();
    profileSelect.value = id;
    loadProfileIntoForm(id);

    await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: id });
    showToast(`Imported profile "${name}".`);
  } catch (err) {
    showToast(`Import failed: ${err.message}`, 'error');
  }
}

// ── Clear all ──────────────────────────────────────────────────────────────

async function handleClear() {
  if (!window.confirm('Delete ALL profiles, custom fields, and API key? This cannot be undone.')) return;

  try {
    await chrome.storage.local.clear();
    const id = generateId();
    state = {
      profiles: { [id]: { name: 'Personal', data: buildEmptyProfileData() } },
      activeProfileId: id,
      theme: 'auto',
    };
    renderProfileSelect();
    profileSelect.value = id;
    loadProfileIntoForm(id);
    populateLlmFields({});
    setThemeRadio('auto');
    showToast('All data cleared.');
  } catch (err) {
    showToast(`Clear failed: ${err.message}`, 'error');
  }
}

// ── Custom fields ──────────────────────────────────────────────────────────

function appendCustomFieldRow(key, value) {
  const row = document.createElement('div');
  row.className = 'custom-field-row';

  const keyInput         = document.createElement('input');
  keyInput.type          = 'text';
  keyInput.className     = 'custom-key';
  keyInput.placeholder   = 'Field name (e.g. Username)';
  keyInput.value         = key;
  keyInput.setAttribute('aria-label', 'Custom field name');

  const valueInput       = document.createElement('input');
  valueInput.type        = 'text';
  valueInput.className   = 'custom-value';
  valueInput.placeholder = 'Value';
  valueInput.value       = value;
  valueInput.setAttribute('aria-label', 'Custom field value');

  const removeBtn        = document.createElement('button');
  removeBtn.type         = 'button';
  removeBtn.className    = 'btn-remove';
  removeBtn.textContent  = '×';
  removeBtn.setAttribute('aria-label', 'Remove custom field');
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  customFieldsList.appendChild(row);
  keyInput.focus();
}

// ── Theme ─────────────────────────────────────────────────────────────────

function applyStoredTheme() {
  const saved = localStorage.getItem('autofill-theme');
  if (saved) applyTheme(saved);
}

function applyTheme(theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark     = theme === 'dark' || (theme === 'auto' && prefersDark);
  document.documentElement.classList.toggle('dark', useDark);
}

function setThemeRadio(theme) {
  for (const radio of themeRadios) {
    radio.checked = radio.value === theme;
  }
}

async function handleThemeChange(theme) {
  state = { ...state, theme };
  applyTheme(theme);
  localStorage.setItem('autofill-theme', theme);
  try {
    await chrome.storage.local.set({ theme });
  } catch (_e) { /* ignore */ }
}

// ── Nav highlight (scroll spy) ─────────────────────────────────────────────

function bindNavHighlight() {
  const sections = document.querySelectorAll('.section');

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          for (const link of navLinks) {
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
          }
          break;
        }
      }
    },
    { threshold: 0.4 }
  );

  for (const section of sections) observer.observe(section);

  for (const link of navLinks) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = link.getAttribute('href').slice(1);
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
    });
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = 'success') {
  toastText.textContent = message;
  toastEl.className     = type === 'error' ? 'toast error' : 'toast';
  toastEl.hidden        = false;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

// ── API key show/hide ──────────────────────────────────────────────────────

function bindApiKeyToggle() {
  toggleApiKey.addEventListener('click', () => {
    const isPassword = apiKeyEl.type === 'password';
    apiKeyEl.type    = isPassword ? 'text' : 'password';
  });
}

// ── Event binding ──────────────────────────────────────────────────────────

function bindEvents() {
  saveBtn.addEventListener('click', handleSave);
  saveBtnBottom.addEventListener('click', handleSave);
  clearBtn.addEventListener('click', handleClear);

  newProfileBtn.addEventListener('click', handleNewProfile);
  renameProfileBtn.addEventListener('click', handleRenameProfile);
  deleteProfileBtn.addEventListener('click', handleDeleteProfile);

  exportBtn.addEventListener('click', handleExport);
  importFile.addEventListener('change', handleImport);

  addCustomField.addEventListener('click', () => appendCustomFieldRow('', ''));

  profileSelect.addEventListener('change', () => {
    const newId = profileSelect.value;
    state = { ...state, activeProfileId: newId };
    loadProfileIntoForm(newId);
  });

  for (const radio of themeRadios) {
    radio.addEventListener('change', () => handleThemeChange(radio.value));
  }

  bindApiKeyToggle();
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

init();
