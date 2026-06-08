/**
 * Unit tests for the pure matcher (content/match.mjs).
 * Covers the mis-fill bug (C2) and word-boundary/specificity (C3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchField, CONFIDENCE_THRESHOLD } from '../content/match.mjs';

const profile = {
  firstName: 'Jane',
  lastName: 'Smith',
  fullName: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1-555-0101',
  city: 'Springfield',
  postalCode: '62704',
  company: 'Acme Corp',
  jobTitle: 'Engineer',
};

const d = (label, name = '') => ({
  label, labelText: label, name, id: name, placeholder: '', ariaLabel: '', autocomplete: '', type: 'text',
});

test('maps clear fields to the right key', () => {
  assert.equal(matchField(d('Email', 'email'), profile).key, 'email');
  assert.equal(matchField(d('Phone', 'phone'), profile).key, 'phone');
  assert.equal(matchField(d('City', 'city'), profile).key, 'city');
  assert.equal(matchField(d('ZIP/Postal Code', 'zip'), profile).key, 'postalCode');
});

test('Company Name maps to company, never to a name field (specificity)', () => {
  const r = matchField(d('Company Name', 'company_name'), profile);
  assert.equal(r.key, 'company');
  assert.notEqual(r.key, 'fullName');
  assert.notEqual(r.key, 'firstName');
});

test('Job Title and Title map to jobTitle, not a name field', () => {
  assert.equal(matchField(d('Job Title', 'job_title'), profile).key, 'jobTitle');
  assert.equal(matchField(d('Title', 'title'), profile).key, 'jobTitle');
});

test('Cardholder Name does not greedily map to fullName/firstName', () => {
  const r = matchField(d('Cardholder Name', 'cc_name'), profile);
  assert.notEqual(r.key, 'fullName');
  assert.notEqual(r.key, 'firstName');
  // null or low confidence — never a confident wrong fill.
  assert.ok(r.key === null || r.confidence <= CONFIDENCE_THRESHOLD);
});

test('Username does not map to fullName', () => {
  const r = matchField(d('Username', 'username'), profile);
  assert.notEqual(r.key, 'fullName');
});

test('genuine full-name fields still match fullName', () => {
  assert.equal(matchField(d('Full Name', 'full_name'), profile).key, 'fullName');
  assert.equal(matchField(d('Your Name', 'your_name'), profile).key, 'fullName');
});
