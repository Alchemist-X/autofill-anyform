/**
 * AutoFill AnyForm — Pure LLM-mapping apply logic (DOM-free, importable ESM).
 *
 * Given an LLM mapping of fieldIndex -> profileKey (or null), the indexed list
 * of field descriptors that was sent, and the user's profile, compute the
 * concrete value to write into each field. No DOM, no network.
 *
 * Returns an array of { index, descriptor, key, value }, only for fields that
 * resolve to a non-empty value (null mappings and empty profile values are
 * skipped). The content script takes this list and writes the DOM.
 */

'use strict';

import { resolveProfileValue } from './match.mjs';

/**
 * @param {Object<string,string|null>} mappings  e.g. { "0": "email", "1": null }
 * @param {Array<object>} fieldDescriptors        indexed descriptor list
 * @param {object} profile                        user profile (incl. customFields)
 * @returns {Array<{index:number, descriptor:object, key:string, value:*}>}
 */
export function applyLlmMappings(mappings, fieldDescriptors, profile) {
  if (!mappings || typeof mappings !== 'object') {
    throw new Error('applyLlmMappings: mappings must be an object of index -> profileKey');
  }
  if (!Array.isArray(fieldDescriptors)) {
    throw new Error('applyLlmMappings: fieldDescriptors must be an array');
  }
  if (!profile || typeof profile !== 'object') {
    throw new Error('applyLlmMappings: profile must be an object');
  }

  const out = [];
  for (const [indexStr, profileKey] of Object.entries(mappings)) {
    if (!profileKey) continue; // null / empty -> skip

    const index = Number.parseInt(indexStr, 10);
    if (!Number.isInteger(index) || index < 0) continue;

    const descriptor = fieldDescriptors[index];
    if (!descriptor) continue;

    const value = resolveProfileValue(profileKey, profile);
    if (value === null || value === undefined || value === '') continue;

    out.push(Object.freeze({ index, descriptor, key: profileKey, value }));
  }
  return out;
}

// Backwards-compatible alias for the historical singular name.
export const applyLlmMapping = applyLlmMappings;
