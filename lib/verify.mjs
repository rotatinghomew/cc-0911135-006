import assert from 'node:assert/strict';

// 发布结果的业务不变量校验。被 tools/extract 与 npm run verify 共同使用。
export function verify(value) {
  assert.match(value.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(value.ruleVersion && Array.isArray(value.records) && Array.isArray(value.quarantine));
  assert.ok(Array.isArray(value.tables), 'tables 必须为数组');
  assert.ok(value.encoding?.name, '必须保留解码依据');

  for (const record of value.records) {
    assert.ok(record.material && record.qualifier && record.evidence, '记录缺少 material/qualifier/evidence');
    assert.ok(record.ruleVersion === value.ruleVersion, '记录规则版本必须与发布结果一致');
    if (record.qualifier === 'not-tested') assert.equal(record.value, null);
    if (record.qualifier === 'below-limit') {
      assert.ok(Number.isFinite(record.limit), '低于检出限记录必须带有限值');
      assert.equal(record.value, null, '低于检出限不是精确测量，value 必须为 null');
    }
    if (record.qualifier === 'measured') assert.ok(Number.isFinite(record.value), '测量记录必须有数值');
    if (record.qualifier === 'empty') assert.fail('空白语义不得进入 records，应进入 quarantine');
    assert.ok(record.evidence.value?.byteRange?.length === 2, '结果证据必须带原始字节定位');
    if (record.unit) assert.ok(record.conversion?.chain?.length >= 1, '带单位的记录必须保留单位转换链');
    assert.equal(typeof record.publishable, 'boolean');
    if (!record.publishable) assert.ok(record.publishReason, '不可发布记录必须说明原因');
  }
  for (const item of value.quarantine) {
    assert.ok(item.reason && item.evidence, '隔离项必须说明原因并保留单元格证据');
    assert.ok(item.ruleVersion === value.ruleVersion || item.ruleId, '隔离项必须可追溯到规则');
  }
  for (const table of value.tables) {
    if (table.status === 'blocked') {
      assert.ok(table.reason, '阻断表必须给出 reason');
      assert.equal(table.recordCount, 0, '阻断表不得产出记录');
    }
  }
}
