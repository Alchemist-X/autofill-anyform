/**
 * Unit tests for the pure field-type helpers (C5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchSelectOption, toCheckboxState, matchRadioValue, toIsoDate,
} from '../content/fields.mjs';

const selectOptions = [
  { value: 'us', text: 'United States' },
  { value: 'ca', text: 'Canada' },
  { value: 'il', text: 'Illinois' },
];

test('select: match by text and by value, null when no match', () => {
  assert.equal(matchSelectOption('United States', selectOptions), 'us');
  assert.equal(matchSelectOption('ca', selectOptions), 'ca');
  assert.equal(matchSelectOption('Nowhere', selectOptions), null);
});

test('checkbox: coerce truthy/falsy values to boolean', () => {
  for (const v of ['true', 'yes', '1', 'on', true]) assert.equal(toCheckboxState(v), true, `truthy: ${v}`);
  for (const v of ['false', 'no', '0', 'off', '', false]) assert.equal(toCheckboxState(v), false, `falsy: ${v}`);
});

test('radio: choose by label and by value, null when no match', () => {
  const group = [{ value: 'm', label: 'Male' }, { value: 'f', label: 'Female' }];
  assert.equal(matchRadioValue('Female', group), 'f');
  assert.equal(matchRadioValue('m', group), 'm');
  assert.equal(matchRadioValue('x', group), null);
});

test('date: normalize to ISO YYYY-MM-DD', () => {
  assert.equal(toIsoDate('1990-05-15'), '1990-05-15');
  assert.equal(toIsoDate('May 15, 1990'), '1990-05-15');
  assert.equal(toIsoDate('05/15/1990'), '1990-05-15');
  assert.equal(toIsoDate('not a date'), null);
});
