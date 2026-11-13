import assert from 'node:assert/strict';

export function verify(value) {
  assert.match(value.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(value.ruleVersion && Array.isArray(value.records) && Array.isArray(value.quarantine));
  for (const record of value.records) {
    assert.ok(record.material && record.qualifier && record.evidence);
    if (record.qualifier === 'not-tested') assert.equal(record.value, null);
    if (record.qualifier === 'below-limit') assert.ok(Number.isFinite(record.limit));
  }
  for (const table of value.tables) if (table.status === 'blocked') assert.ok(table.reason);
}
