/**
 * Unit tests for the pure LLM-apply logic (C6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLlmMappings } from '../content/apply-llm.mjs';

const profile = {
  firstName: 'Jane',
  email: 'jane@example.com',
  company: 'Acme Corp',
  customFields: { Username: 'janesmith42' },
};

const fieldDescriptors = [
  { label: 'Work Email', name: 'work_email', id: 'we', type: 'email' },
  { label: 'Nickname', name: 'nick', id: 'nk', type: 'text' },
  { label: 'Employer', name: 'emp', id: 'em', type: 'text' },
  { label: 'Login Handle', name: 'handle', id: 'lh', type: 'text' },
];

test('resolves mappings to per-field values and skips null mappings', () => {
  const mappings = { 0: 'email', 1: null, 2: 'company', 3: '__custom__Username' };
  const out = applyLlmMappings(mappings, fieldDescriptors, profile);
  const byIndex = Object.fromEntries(out.map(x => [x.index, x.value]));

  assert.equal(byIndex[0], 'jane@example.com');
  assert.equal(byIndex[2], 'Acme Corp');
  assert.equal(byIndex[3], 'janesmith42');
  assert.equal(byIndex[1], undefined, 'null mapping must be skipped');
});

test('skips empty profile values', () => {
  const out = applyLlmMappings({ 0: 'phone' }, fieldDescriptors, { phone: '' });
  assert.equal(out.length, 0);
});

test('throws on invalid arguments', () => {
  assert.throws(() => applyLlmMappings(null, fieldDescriptors, profile));
  assert.throws(() => applyLlmMappings({}, 'not-array', profile));
  assert.throws(() => applyLlmMappings({}, fieldDescriptors, null));
});
