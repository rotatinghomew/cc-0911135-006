import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRulePack, validateRulePack } from '../lib/rules.mjs';
import { extractFromBytes } from '../lib/extract.mjs';
import { verify } from '../lib/verify.mjs';
import { hashBytes } from '../lib/capture.mjs';

function manifestFor(html) {
  const bytes = Buffer.from(html, 'utf8');
  const sourceHash = hashBytes(bytes);
  return {
    manifest: { sourceHash, encoding: 'utf-8', encodingSource: 'default', receipts: ['receipt-0.json'] },
    bytes,
  };
}

// 两行表头：材料号/部位/状态用 rowspan=2 占满，Ni 用 colspan=2 拆分结果与单位。
const RULE_HTML = rows => `<!doctype html><html><meta charset="utf-8">
<table id="assays"><thead><tr><th rowspan="2">材料号</th><th rowspan="2">部位</th><th colspan="2">Ni</th><th rowspan="2">状态</th></tr>
<tr><th>结果</th><th>单位</th></tr></thead><tbody>${rows}</tbody></table></html>`;

test('无单位的低于检出限与测量值逐行隔离，未检行仍保留', async () => {
  // 单位列单元格留空：有值行隔离，空白未检行保留为 not-tested。
  const html = RULE_HTML(`
    <tr><td>M-101</td><td>籽粒</td><td>&lt;0.02<sup>1</sup></td><td></td><td>有效</td></tr>
    <tr><td>M-102</td><td>籽粒</td><td>0.3</td><td></td><td>有效</td></tr>
    <tr><td>M-103</td><td>籽粒</td><td></td><td></td><td>未检</td></tr>`);
  const { manifest, bytes } = await manifestFor(html);
  const result = extractFromBytes({ bytes, manifest, rulePack: await loadRulePack('rules-2') });
  verify(result);
  assert.equal(result.tables[0].status, 'ok');
  assert.deepEqual(result.records.map(r => [r.material, r.qualifier]), [['M-103', 'not-tested']]);
  // 有值的两行（含低于检出限）在统一的单位归属环节被隔离，不产生无单位记录。
  assert.equal(result.quarantine.length, 2);
  assert.ok(result.quarantine.every(q => /无法确定结果单位/.test(q.reason)));
  assert.deepEqual(result.quarantine.map(q => q.material).sort(), ['M-101', 'M-102']);
  assert.ok(result.quarantine.every(q => q.ruleVersion === 'rules-2'));
});

test('缺材料号的行进隔离且不影响同表其他行', async () => {
  const html = RULE_HTML(`
    <tr><td></td><td>籽粒</td><td>0.3</td><td>mg/kg</td><td>有效</td></tr>
    <tr><td>M-202</td><td>生长点</td><td>0.4</td><td>mg/kg</td><td>有效</td></tr>`);
  const { manifest, bytes } = await manifestFor(html);
  const result = extractFromBytes({ bytes, manifest, rulePack: await loadRulePack('rules-1') });
  verify(result);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].material, 'M-202');
  assert.match(result.quarantine[0].reason, /缺少材料号/);
});

test('结构空洞（正文缺 td 导致网格不完整）阻断整张表', async () => {
  const html = `<!doctype html><table id="assays"><thead><tr>
    <th rowspan="2">材料号</th><th rowspan="2">部位</th><th colspan="2">Ni</th><th rowspan="2">状态</th></tr>
    <tr><th>结果</th><th>单位</th></tr></thead>
    <tbody><tr><td>M-301</td><td>籽粒</td><td>0.3</td></tr></tbody></table>`;
  const { manifest, bytes } = await manifestFor(html);
  const result = extractFromBytes({ bytes, manifest, rulePack: await loadRulePack('rules-1') });
  assert.equal(result.tables[0].status, 'blocked');
  assert.match(result.tables[0].reason, /结构/);
  assert.ok(result.tables[0].structuralErrors.some(e => e.code === 'grid-hole'));
  assert.equal(result.records.length, 0);
});

test('规则包加载自检拒绝非法换算系数与重复单位', async () => {
  const bad = {
    ruleVersion: 'rules-bad',
    tables: [{
      id: 'x', match: { tableId: 'assays' }, element: 'Ni',
      headers: { material: { paths: [['材料号']], required: true }, value: { paths: [['Ni']], required: true } },
      unit: { target: 'mg/kg', accept: [{ unit: 'mg/kg', factor: 1 }, { unit: 'x', factor: -2 }] },
      stateMap: {}, footnotes: {},
    }],
  };
  assert.throws(() => validateRulePack(bad), /非法换算系数/);
  bad.tables[0].unit.accept = [{ unit: 'mg/kg', factor: 1 }, { unit: 'mg/kg', factor: 1 }];
  assert.throws(() => validateRulePack(bad), /单位 mg\/kg 重复/);
});
