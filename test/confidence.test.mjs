/**
 * Unit tests for matcher confidence (C4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchField, CONFIDENCE_THRESHOLD } from '../content/match.mjs';

const profile = { email: 'jane@example.com', fullName: 'Jane Smith', company: 'Acme Corp' };

const d = (label, name = '') => ({
  label, labelText: label, name, id: name, placeholder: '', ariaLabel: '', autocomplete: '', type: 'text',
});

test('clear field returns HIGH confidence', () => {
  const r = matchField(d('Email', 'email'), profile);
  assert.equal(typeof r.confidence, 'number');
  assert.ok(r.confidence > CONFIDENCE_THRESHOLD, `expected high confidence, got ${r.confidence}`);
});

test('unknown descriptor returns null / LOW confidence', () => {
  const r = matchField(d('xyzzy', 'xyzzy'), profile);
  assert.ok(r.key === null || r.confidence <= CONFIDENCE_THRESHOLD);
});

test('autocomplete attribute yields confidence 1.0', () => {
  const r = matchField(
    { label: '', labelText: '', name: '', id: '', placeholder: '', ariaLabel: '', autocomplete: 'email', type: 'text' },
    profile,
  );
  assert.equal(r.key, 'email');
  assert.equal(r.confidence, 1.0);
});
