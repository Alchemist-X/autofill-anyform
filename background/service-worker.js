/**
 * AutoFill AnyForm — Background Service Worker
 * Coordinates messages between popup and content script.
 * Handles optional LLM API calls so the content script stays lightweight.
 */

'use strict';

// ── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_PAGE') {
    handleFillPage(message, sender, sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === 'LLM_MAP_FIELDS') {
    handleLlmMapFields(message, sender, sendResponse);
    return true;
  }
});

// ── Fill page: inject content script command ─────────────────────────────────

async function handleFillPage(message, sender, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      sendResponse({ success: false, error: 'No active tab found.' });
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'DO_FILL',
      profile: message.profile,
      useLlm: message.useLlm,
    });

    sendResponse(result);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── LLM mapping: call user-configured endpoint ───────────────────────────────

async function handleLlmMapFields(message, sender, sendResponse) {
  const { apiKey, apiEndpoint, model, fieldDescriptors, profileKeys } = message;

  if (!apiKey || !apiEndpoint) {
    sendResponse({ success: false, error: 'LLM API key or endpoint not configured.' });
    return;
  }

  try {
    const systemPrompt = buildSystemPrompt(profileKeys);
    const userPrompt = buildUserPrompt(fieldDescriptors);

    const requestBody = buildLlmRequestBody(model, systemPrompt, userPrompt);

    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      sendResponse({ success: false, error: `LLM API error ${response.status}: ${errText}` });
      return;
    }

    const data = await response.json();
    const mappings = parseLlmResponse(data);
    sendResponse({ success: true, mappings });
  } catch (err) {
    sendResponse({ success: false, error: `LLM request failed: ${err.message}` });
  }
}

// ── LLM helpers ───────────────────────────────────────────────────────────────

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
  const lines = fieldDescriptors.map((d, i) =>
    `${i}: ${JSON.stringify(d)}`
  );
  return 'Map these fields:\n' + lines.join('\n');
}

function buildLlmRequestBody(model, systemPrompt, userPrompt) {
  const resolvedModel = model || 'gpt-4o-mini';
  return {
    model: resolvedModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 512,
  };
}

function parseLlmResponse(data) {
  try {
    // Support OpenAI-compatible response format
    const content = data?.choices?.[0]?.message?.content ?? '';
    // Strip markdown code fences if present
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('LLM response is not an object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Could not parse LLM response as JSON mapping: ${err.message}`);
  }
}
