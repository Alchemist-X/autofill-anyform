/**
 * AutoFill AnyForm — Background Service Worker v2
 * Coordinates messages between popup/commands and content script.
 * Handles LLM API calls and applies the resulting mappings back to the page.
 */

'use strict';

// ── Keyboard command listener ──────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-page') return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const stored = await chrome.storage.local.get(['profiles', 'activeProfileId', 'siteDefaults', 'llmEnabled']);
    const profile = resolveActiveProfile(stored, tab.url);
    if (!profile) return;

    await runFill(tab.id, profile, Boolean(stored.llmEnabled), false);
  } catch (_err) {
    // Background commands can't show UI errors — fail silently
  }
});

// ── Message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_PAGE') {
    handleFillPage(message, sendResponse);
    return true;
  }

  if (message.type === 'LLM_MAP_FIELDS') {
    handleLlmMapFields(message, sendResponse);
    return true;
  }

  if (message.type === 'GET_SITE_PROFILE') {
    handleGetSiteProfile(message, sendResponse);
    return true;
  }

  if (message.type === 'SET_SITE_PROFILE') {
    handleSetSiteProfile(message, sendResponse);
    return true;
  }
});

// ── Fill page orchestration ────────────────────────────────────────────────

async function handleFillPage(message, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      sendResponse({ success: false, error: 'No active tab found.' });
      return;
    }

    const result = await runFill(tab.id, message.profile, message.useLlm, message.highlightUnmatched);
    sendResponse(result);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Core fill flow:
 * 1. Send DO_FILL to content script (heuristic pass).
 * 2. If useLlm and there are unmatched fields, call LLM, then apply mappings.
 * Returns merged stats.
 */
async function runFill(tabId, profile, useLlm, highlightUnmatched) {
  const firstPass = await chrome.tabs.sendMessage(tabId, {
    type: 'DO_FILL',
    profile,
    highlightUnmatched,
  });

  if (!firstPass?.success) return firstPass;

  if (!useLlm || !firstPass.unmatched || firstPass.unmatched.length === 0) {
    return firstPass;
  }

  // LLM second pass
  try {
    const stored = await chrome.storage.local.get(['apiKey', 'apiEndpoint', 'llmModel']);
    if (!stored.apiKey || !stored.apiEndpoint) {
      return { ...firstPass, llmNote: 'LLM skipped: key/endpoint not configured.' };
    }

    const profileKeys = buildAvailableProfileKeys(profile);
    const mappings = await callLlmApi({
      apiKey:           stored.apiKey,
      apiEndpoint:      stored.apiEndpoint,
      model:            stored.llmModel,
      fieldDescriptors: firstPass.unmatched,
      profileKeys,
    });

    if (!mappings.success) {
      return { ...firstPass, llmNote: `LLM error: ${mappings.error}` };
    }

    // Apply LLM-provided mappings in the content script
    const applyResult = await chrome.tabs.sendMessage(tabId, {
      type: 'APPLY_LLM_MAPPINGS',
      mappings: mappings.mappings,
      fieldRefs: firstPass.unmatched,
      profile,
    });

    const llmFilled = applyResult?.applied ?? 0;
    return {
      ...firstPass,
      filled:    firstPass.filled + llmFilled,
      llmFilled,
      unmatched: firstPass.unmatched.slice(llmFilled), // rough remainder
      message:   buildCombinedMessage(firstPass.filled + llmFilled, firstPass.skipped, llmFilled),
    };
  } catch (llmErr) {
    return { ...firstPass, llmNote: `LLM failed: ${llmErr.message}` };
  }
}

function buildAvailableProfileKeys(profile) {
  const standardKeys = Object.keys(profile).filter(k => k !== 'customFields' && profile[k]);
  const customKeys   = Object.keys(profile.customFields ?? {}).map(k => '__custom__' + k);
  return [...standardKeys, ...customKeys];
}

function buildCombinedMessage(filled, skipped, llmFilled) {
  const parts = [`Filled ${filled} field${filled !== 1 ? 's' : ''}`];
  if (llmFilled > 0) parts[0] += ` (${llmFilled} via LLM)`;
  parts[0] += '.';
  if (skipped > 0) parts.push(`${skipped} skipped.`);
  return parts.join(' ');
}

// ── LLM API call ──────────────────────────────────────────────────────────

async function handleLlmMapFields(message, sendResponse) {
  const result = await callLlmApi(message);
  sendResponse(result);
}

async function callLlmApi({ apiKey, apiEndpoint, model, fieldDescriptors, profileKeys }) {
  if (!apiKey || !apiEndpoint) {
    return { success: false, error: 'LLM API key or endpoint not configured.' };
  }

  try {
    const systemPrompt = buildSystemPrompt(profileKeys);
    const userPrompt   = buildUserPrompt(fieldDescriptors);
    const requestBody  = buildLlmRequestBody(model, systemPrompt, userPrompt);

    const response = await fetch(apiEndpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `LLM API error ${response.status}: ${errText}` };
    }

    const data     = await response.json();
    const mappings = parseLlmResponse(data);
    return { success: true, mappings };
  } catch (err) {
    return { success: false, error: `LLM request failed: ${err.message}` };
  }
}

// ── LLM prompt builders ────────────────────────────────────────────────────

function buildSystemPrompt(profileKeys) {
  return (
    'You are a form-field mapper. Given a list of HTML form field descriptors, ' +
    'map each field to the most appropriate profile key, or null if no match. ' +
    'Respond ONLY with a JSON object where each key is the field index (0-based string) ' +
    'and each value is a profile key name or null.\n\n' +
    'Available profile keys: ' + profileKeys.join(', ')
  );
}

function buildUserPrompt(fieldDescriptors) {
  const lines = fieldDescriptors.map((d, i) => `${i}: ${JSON.stringify(d)}`);
  return 'Map these fields:\n' + lines.join('\n');
}

function buildLlmRequestBody(model, systemPrompt, userPrompt) {
  return {
    model:       model || 'gpt-4o-mini',
    messages:    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0,
    max_tokens:  512,
  };
}

function parseLlmResponse(data) {
  try {
    const content = data?.choices?.[0]?.message?.content ?? '';
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('LLM response is not an object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Could not parse LLM response as JSON mapping: ${err.message}`);
  }
}

// ── Site default profile helpers ──────────────────────────────────────────

function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return '';
  }
}

function resolveActiveProfile(stored, tabUrl) {
  const profiles       = stored.profiles ?? {};
  const siteDefaults   = stored.siteDefaults ?? {};
  const hostname       = extractHostname(tabUrl);
  const siteProfileId  = siteDefaults[hostname];
  const activeId       = siteProfileId ?? stored.activeProfileId;

  if (activeId && profiles[activeId]) return profiles[activeId].data;

  // Fallback: first profile
  const ids = Object.keys(profiles);
  if (ids.length > 0) return profiles[ids[0]].data;

  return null;
}

async function handleGetSiteProfile(message, sendResponse) {
  try {
    const stored   = await chrome.storage.local.get(['siteDefaults']);
    const hostname = message.hostname;
    const siteId   = (stored.siteDefaults ?? {})[hostname] ?? null;
    sendResponse({ success: true, profileId: siteId });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleSetSiteProfile(message, sendResponse) {
  try {
    const stored       = await chrome.storage.local.get(['siteDefaults']);
    const siteDefaults = { ...(stored.siteDefaults ?? {}), [message.hostname]: message.profileId };
    await chrome.storage.local.set({ siteDefaults });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}
