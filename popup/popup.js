/**
 * AutoFill AnyForm — Popup Script v2
 * Multi-profile selector, site-default, dark-mode toggle, LLM toggle,
 * highlight-unmatched toggle, result display with confidence chips.
 */

'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────────

const themeToggle        = document.getElementById('themeToggle');
const emptyState         = document.getElementById('emptyState');
const mainContent        = document.getElementById('mainContent');
const goSetupProfile     = document.getElementById('goSetupProfile');
const profileSelect      = document.getElementById('profileSelect');
const siteBadge          = document.getElementById('siteBadge');
const siteBadgeText      = document.getElementById('siteBadgeText');
const clearSiteDefault   = document.getElementById('clearSiteDefault');
const useLlmToggle       = document.getElementById('useLlmToggle');
const highlightToggle    = document.getElementById('highlightUnmatched');
const llmDesc            = document.getElementById('llmDesc');
const llmHint            = document.getElementById('llmHint');
const fillBtn            = document.getElementById('fillBtn');
const statusBar          = document.getElementById('statusBar');
const statusText         = document.getElementById('statusText');
const resultCard         = document.getElementById('resultCard');
const filledCount        = document.getElementById('filledCount');
const skippedCount       = document.getElementById('skippedCount');
const unmatchedChip      = document.getElementById('unmatchedChip');
const unmatchedCount     = document.getElementById('unmatchedCount');
const resultMsg          = document.getElementById('resultMsg');
const setAsDefaultBtn    = document.getElementById('setAsDefaultBtn');
const optionsLink        = document.getElementById('optionsLink');
const goToOptionsLlm     = document.getElementById('goToOptionsLlm');

// ── State ──────────────────────────────────────────────────────────────────

let state = {
  profiles:      {},
  activeProfileId: null,
  llmEnabled:    false,
  highlightUnmatched: false,
  hasApiKey:     false,
  tabHostname:   '',
  siteProfileId: null,
  theme:         'auto', // 'auto' | 'light' | 'dark'
};

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    applyStoredTheme();

    const stored = await chrome.storage.local.get([
      'profiles', 'activeProfileId', 'llmEnabled', 'highlightUnmatched',
      'apiKey', 'siteDefaults', 'theme',
    ]);

    const profiles   = stored.profiles ?? {};
    const hasProfiles = Object.keys(profiles).length > 0;

    state = {
      ...state,
      profiles,
      activeProfileId:    stored.activeProfileId ?? null,
      llmEnabled:         Boolean(stored.llmEnabled),
      highlightUnmatched: Boolean(stored.highlightUnmatched),
      hasApiKey:          Boolean(stored.apiKey),
      theme:              stored.theme ?? 'auto',
    };

    applyTheme(state.theme);

    // Resolve tab hostname for site-default
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tabHostname = tab?.url ? extractHostname(tab.url) : '';
      if (state.tabHostname) {
        const siteDefaults = stored.siteDefaults ?? {};
        state.siteProfileId = siteDefaults[state.tabHostname] ?? null;
      }
    } catch (_e) {
      // Can't query tabs on restricted pages — ignore
    }

    if (!hasProfiles) {
      emptyState.hidden = false;
    } else {
      mainContent.hidden = false;
      renderProfileSelect();
      renderSiteBadge();
      renderToggles();
    }

    bindEvents();
  } catch (err) {
    showStatus(`Init error: ${err.message}`, 'error');
  }
}

// ── Profile rendering ──────────────────────────────────────────────────────

function renderProfileSelect() {
  const profileIds = Object.keys(state.profiles);
  profileSelect.innerHTML = '';

  for (const id of profileIds) {
    const opt = document.createElement('option');
    opt.value       = id;
    opt.textContent = state.profiles[id].name || id;
    profileSelect.appendChild(opt);
  }

  // Determine which profile to select
  const preferred = state.siteProfileId ?? state.activeProfileId ?? profileIds[0];
  profileSelect.value = profileIds.includes(preferred) ? preferred : profileIds[0];
}

function getSelectedProfile() {
  const id = profileSelect.value;
  return state.profiles[id]?.data ?? null;
}

// ── Site badge ─────────────────────────────────────────────────────────────

function renderSiteBadge() {
  if (!state.siteProfileId || !state.tabHostname) {
    siteBadge.hidden = true;
    return;
  }
  const profileName = state.profiles[state.siteProfileId]?.name ?? state.siteProfileId;
  siteBadgeText.textContent = `${state.tabHostname} → ${profileName}`;
  siteBadge.hidden = false;
}

// ── Toggles ────────────────────────────────────────────────────────────────

function renderToggles() {
  useLlmToggle.checked    = state.llmEnabled;
  highlightToggle.checked = state.highlightUnmatched;
  updateLlmHint();
}

function updateLlmHint() {
  const showHint = state.llmEnabled && !state.hasApiKey;
  llmHint.hidden = !showHint;
  llmDesc.textContent = state.llmEnabled
    ? (state.hasApiKey ? 'Enabled · using your API key' : 'Needs API key in Options')
    : 'Off by default · uses your API key';
}

// ── Event binding ──────────────────────────────────────────────────────────

function bindEvents() {
  themeToggle.addEventListener('click', handleThemeToggle);

  useLlmToggle.addEventListener('change', async () => {
    state = { ...state, llmEnabled: useLlmToggle.checked };
    updateLlmHint();
    try {
      await chrome.storage.local.set({ llmEnabled: state.llmEnabled });
    } catch (_e) { /* ignore */ }
  });

  highlightToggle.addEventListener('change', async () => {
    state = { ...state, highlightUnmatched: highlightToggle.checked };
    if (!highlightToggle.checked) {
      // Clear existing highlights when turned off
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_HIGHLIGHTS' }).catch(() => {});
        }
      } catch (_e) { /* ignore */ }
    }
    try {
      await chrome.storage.local.set({ highlightUnmatched: state.highlightUnmatched });
    } catch (_e) { /* ignore */ }
  });

  profileSelect.addEventListener('change', async () => {
    const newId = profileSelect.value;
    state = { ...state, activeProfileId: newId };
    try {
      await chrome.storage.local.set({ activeProfileId: newId });
    } catch (_e) { /* ignore */ }
    hideResult();
  });

  fillBtn.addEventListener('click', handleFillClick);

  setAsDefaultBtn.addEventListener('click', handleSetAsDefault);

  clearSiteDefault.addEventListener('click', handleClearSiteDefault);

  optionsLink.addEventListener('click', openOptions);
  goSetupProfile?.addEventListener('click', openOptions);
  goToOptionsLlm?.addEventListener('click', openOptions);
}

// ── Fill ──────────────────────────────────────────────────────────────────

async function handleFillClick() {
  const profile = getSelectedProfile();
  if (!profile || Object.keys(profile).length === 0) {
    showStatus('Configure your profile in Options first.', 'warning');
    return;
  }

  setFilling(true);
  hideResult();
  clearStatus();

  try {
    const response = await chrome.runtime.sendMessage({
      type:               'FILL_PAGE',
      profile,
      useLlm:             state.llmEnabled,
      highlightUnmatched: state.highlightUnmatched,
    });

    handleFillResponse(response);
  } catch (err) {
    showStatus(`Fill failed: ${err.message}`, 'error');
  } finally {
    setFilling(false);
  }
}

function handleFillResponse(response) {
  if (!response) {
    showStatus('No response from page. Try reloading the tab.', 'error');
    return;
  }
  if (!response.success) {
    showStatus(response.error || 'Unknown error during fill.', 'error');
    return;
  }

  showResult(response);

  if (response.filled === 0) {
    showStatus('No fields matched your profile.', 'warning');
  } else {
    const msg = `Done — ${response.filled} field${response.filled !== 1 ? 's' : ''} filled.`;
    showStatus(response.llmNote ? `${msg} ${response.llmNote}` : msg, 'success');
  }
}

// ── Site default ──────────────────────────────────────────────────────────

async function handleSetAsDefault() {
  if (!state.tabHostname) return;
  const profileId = profileSelect.value;
  try {
    await chrome.runtime.sendMessage({
      type:      'SET_SITE_PROFILE',
      hostname:  state.tabHostname,
      profileId,
    });
    state = { ...state, siteProfileId: profileId };
    renderSiteBadge();
    setAsDefaultBtn.hidden = true;
    showStatus('Set as default for this site.', 'success');
  } catch (err) {
    showStatus(`Could not set default: ${err.message}`, 'error');
  }
}

async function handleClearSiteDefault() {
  if (!state.tabHostname) return;
  try {
    await chrome.runtime.sendMessage({
      type:      'SET_SITE_PROFILE',
      hostname:  state.tabHostname,
      profileId: null,
    });
    state = { ...state, siteProfileId: null };
    renderSiteBadge();
  } catch (err) {
    showStatus(`Could not clear default: ${err.message}`, 'error');
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────

function applyStoredTheme() {
  // Immediately apply without waiting for storage, to avoid flash
  const saved = localStorage.getItem('autofill-theme');
  if (saved) applyTheme(saved);
}

function applyTheme(theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark     = theme === 'dark' || (theme === 'auto' && prefersDark);
  document.documentElement.classList.toggle('dark', useDark);
}

async function handleThemeToggle() {
  const isDark  = document.documentElement.classList.contains('dark');
  const newTheme = isDark ? 'light' : 'dark';
  state = { ...state, theme: newTheme };
  applyTheme(newTheme);
  localStorage.setItem('autofill-theme', newTheme);
  try {
    await chrome.storage.local.set({ theme: newTheme });
  } catch (_e) { /* ignore */ }
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setFilling(isFilling) {
  fillBtn.disabled    = isFilling;
  fillBtn.textContent = isFilling ? 'Filling…' : '';
  if (!isFilling) {
    // Restore with icon
    fillBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
      Fill this page`;
  }
}

function showStatus(message, type = 'warning') {
  statusText.textContent = message;
  statusBar.className    = `status-bar ${type}`;
  statusBar.hidden       = false;
}

function clearStatus() {
  statusBar.hidden       = true;
  statusBar.className    = 'status-bar';
  statusText.textContent = '';
}

function showResult(response) {
  filledCount.textContent  = response.filled ?? 0;
  skippedCount.textContent = response.skipped ?? 0;

  const hasUnmatched = (response.unmatched?.length ?? 0) > 0;
  unmatchedChip.hidden   = !hasUnmatched;
  if (hasUnmatched) unmatchedCount.textContent = response.unmatched.length;

  resultMsg.textContent = response.message ?? '';

  // Show "set as default" if a fill succeeded and hostname is available
  const canSetDefault = state.tabHostname && !state.siteProfileId && (response.filled ?? 0) > 0;
  setAsDefaultBtn.hidden = !canSetDefault;

  resultCard.hidden = false;
}

function hideResult() {
  resultCard.hidden = true;
  setAsDefaultBtn.hidden = true;
}

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
}

function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return '';
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

init();
