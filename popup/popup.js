/**
 * AutoFill AnyForm — Popup Script
 * Handles UI interactions: fill button, LLM toggle, result display.
 */

'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────────

const fillBtn       = document.getElementById('fillBtn');
const useLlmToggle  = document.getElementById('useLlmToggle');
const llmHint       = document.getElementById('llmHint');
const goToOptions   = document.getElementById('goToOptions');
const optionsLink   = document.getElementById('optionsLink');
const statusBar     = document.getElementById('statusBar');
const statusText    = document.getElementById('statusText');
const resultBlock   = document.getElementById('resultBlock');
const filledCount   = document.getElementById('filledCount');
const skippedCount  = document.getElementById('skippedCount');
const unmatchedRow  = document.getElementById('unmatchedRow');
const unmatchedCount = document.getElementById('unmatchedCount');
const resultMessage = document.getElementById('resultMessage');

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    const stored = await chrome.storage.local.get(['profile', 'llmEnabled', 'apiKey']);
    const hasProfile = stored.profile && Object.keys(stored.profile).length > 0;
    const hasApiKey  = Boolean(stored.apiKey);

    if (!hasProfile) {
      showStatus('No profile saved yet. Set one up in Options.', 'warning');
    }

    // Restore LLM toggle state
    useLlmToggle.checked = Boolean(stored.llmEnabled);
    updateLlmHint(hasApiKey, stored.llmEnabled);

    useLlmToggle.addEventListener('change', () => handleToggleChange(hasApiKey));
    fillBtn.addEventListener('click', () => handleFillClick(stored.profile));
    optionsLink.addEventListener('click', openOptions);
    goToOptions.addEventListener('click', openOptions);
  } catch (err) {
    showStatus(`Initialization error: ${err.message}`, 'error');
  }
}

// ── Event handlers ─────────────────────────────────────────────────────────

async function handleToggleChange(hasApiKey) {
  const enabled = useLlmToggle.checked;

  try {
    await chrome.storage.local.set({ llmEnabled: enabled });
    updateLlmHint(hasApiKey, enabled);
  } catch (err) {
    showStatus(`Could not save toggle: ${err.message}`, 'error');
  }
}

async function handleFillClick(profile) {
  if (!profile || Object.keys(profile).length === 0) {
    showStatus('Please configure your profile in Options first.', 'warning');
    return;
  }

  setFilling(true);
  hideResult();
  clearStatus();

  try {
    const stored = await chrome.storage.local.get(['llmEnabled']);
    const useLlm = Boolean(stored.llmEnabled);

    const response = await chrome.runtime.sendMessage({
      type: 'FILL_PAGE',
      profile,
      useLlm,
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
    showStatus(`Done — ${response.filled} field${response.filled !== 1 ? 's' : ''} filled.`, 'success');
  }
}

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setFilling(isFilling) {
  fillBtn.disabled = isFilling;
  fillBtn.textContent = isFilling ? 'Filling…' : 'Fill this page';
}

function showStatus(message, type = 'warning') {
  statusText.textContent = message;
  statusBar.className = `status-bar ${type}`;
  statusBar.hidden = false;
}

function clearStatus() {
  statusBar.hidden = true;
  statusBar.className = 'status-bar';
  statusText.textContent = '';
}

function showResult(response) {
  filledCount.textContent  = response.filled ?? 0;
  skippedCount.textContent = response.skipped ?? 0;
  resultMessage.textContent = response.message ?? '';

  const hasUnmatched = (response.unmatched?.length ?? 0) > 0;
  unmatchedRow.hidden = !hasUnmatched;
  if (hasUnmatched) {
    unmatchedCount.textContent = response.unmatched.length;
  }

  resultBlock.hidden = false;
}

function hideResult() {
  resultBlock.hidden = true;
}

function updateLlmHint(hasApiKey, llmEnabled) {
  const showHint = llmEnabled && !hasApiKey;
  llmHint.hidden = !showHint;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

init();
