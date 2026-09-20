import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDomain } from '../src/domain.js';

test('样例领域标识正确', async () => {
  const raw = await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8');
  const value = parseDomain(raw);
  assert.equal(value.domain, 'inbound-visitor-handoff');
  assert.ok(value.constraints.length >= 2);
});
