import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite } from '../src/site.mjs';
import { captureResponse, loadCapture } from '../lib/capture.mjs';
import { loadRulePack, listRulePacks } from '../lib/rules.mjs';
import { extractFromBytes } from '../lib/extract.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}
async function captureLayout(site, baseDir, layout, encoding) {
  // 每次都显式下发完整状态，避免上一个情景的 layout/encoding 残留污染。
  await control(site, { layout: layout || 'normal', encoding: encoding || 'utf-8' });
  const response = await fetch(site.url + '/bulletin');
  const captured = await captureResponse(baseDir, { url: site.url + '/bulletin', response });
  return loadCapture(baseDir, captured.sourceHash);
}
async function run(site, baseDir, ruleVersion, layout, encoding) {
  const { manifest, bytes } = await captureLayout(site, baseDir, layout || 'normal', encoding || 'utf-8');
  const rulePack = await loadRulePack(ruleVersion);
  const result = extractFromBytes({ bytes, manifest, rulePack });
  verify(result);
  return { result, manifest, bytes };
}
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'assay-regression-'));
}
const byMaterial = result => Object.fromEntries(result.records.map(r => [r.material, r]));

test('规则包清单包含两个永久保留的版本', async () => {
  const versions = await listRulePacks();
  assert.deepEqual(versions, ['rules-1', 'rules-2']);
});

// 情景 1+2：跨两层表头、正文夹脚注、四种测量语义。
test('两层合并表头：Ni/结果与 Ni/单位 分别归属，四种语义互不混同', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const { result } = await run(site, baseDir, 'rules-1', 'normal');
    assert.equal(result.tables[0].status, 'ok');
    const records = byMaterial(result);

    // <0.02：低于检出限，绝不是 0.02 的精确测量；脚注仅作引用留存。
    const m001 = records['M-001'];
    assert.equal(m001.qualifier, 'below-limit');
    assert.equal(m001.value, null);
    assert.equal(m001.limit, 0.02);
    assert.equal(m001.unit, 'mg/kg');
    assert.equal(m001.publishable, true);
    assert.match(m001.notes[0].footnote, /检出限为 0.02/);
    assert.equal(m001.evidence.value.rawText, '<0.02');
    assert.ok(m001.evidence.value.byteRange[1] > m001.evidence.value.byteRange[0]);

    // 0 是真实测量值，与空白严格区分。
    const m002 = records['M-002'];
    assert.equal(m002.qualifier, 'measured');
    assert.equal(m002.value, 0);
    assert.equal(m002.publishable, true);

    // 空白 + 未检：保留“未检”语义，value 为 null，不进材料库。
    const m003 = records['M-003'];
    assert.equal(m003.qualifier, 'not-tested');
    assert.equal(m003.value, null);
    assert.equal(m003.state, 'not-tested');
    assert.equal(m003.publishable, false);

    // 撤回：数值保留但不发布。
    const m004 = records['M-004'];
    assert.equal(m004.qualifier, 'measured');
    assert.equal(m004.value, 0.12);
    assert.equal(m004.state, 'withdrawn');
    assert.equal(m004.publishable, false);
    assert.match(m004.publishReason, /撤回/);

    // 列归属证据：结果列与单位列来自不同网格列。
    assert.notEqual(m001.evidence.value.col, m001.evidence.unit.col);
    assert.equal(m001.evidence.unit.rawText, 'mg/kg');
    // 脚注本身进入 footnotes，且其数值从未被当作任何记录的 value。
    assert.ok(result.footnotes.some(note => /检出限/.test(note.text)));
    assert.ok(!result.records.some(r => r.value === 0.02));
  });
  await rm(baseDir, { recursive: true, force: true });
});

// 情景 3：非法跨度阻断整张表。
test('非法跨度 colspan=0：阻断整张表并保留结构错误定位', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const { result } = await run(site, baseDir, 'rules-1', 'badspan');
    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.equal(table.status, 'blocked');
    assert.equal(table.recordCount, 0);
    assert.match(table.reason, /结构/);
    const spanError = table.structuralErrors.find(e => e.code === 'invalid-span');
    assert.ok(spanError, '必须记录 invalid-span 结构错误');
    assert.match(spanError.message, /colspan="0"/);
    assert.ok(spanError.location, '结构错误必须带原文定位');
    assert.equal(result.records.length, 0);
    assert.equal(result.quarantine.length, 0);
  });
  await rm(baseDir, { recursive: true, force: true });
});

// 情景 4：缺少关键表头阻断整张表（两个规则版本口径一致）。
test('缺少单位表头：缺关键表头时阻断，不发布缺单位记录', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const v1 = await run(site, baseDir, 'rules-1', 'missing');
    assert.equal(v1.result.tables[0].status, 'blocked');
    assert.match(v1.result.tables[0].reason, /缺少关键表头/);
    assert.deepEqual(v1.result.tables[0].missingHeaders.map(m => m.field), ['unit']);
    assert.equal(v1.result.records.length, 0);

    const v2 = await run(site, baseDir, 'rules-2', 'missing');
    // rules-2 中单位列可选：表不再阻断，降级为逐行隔离——
    // 三个有值但无单位的行进隔离区，只有无值的未检行保留为记录。
    assert.equal(v2.result.tables[0].status, 'ok');
    assert.equal(v2.result.quarantine.length, 3);
    assert.ok(v2.result.quarantine.every(q => /无法确定结果单位/.test(q.reason)));
    assert.deepEqual(v2.result.records.map(r => r.material), ['M-003']);
    assert.equal(v2.result.records[0].qualifier, 'not-tested');
  });
  await rm(baseDir, { recursive: true, force: true });
});

// 情景 5：行单位冲突，单行隔离而非整表阻断。
test('行单位冲突：歧义行进隔离区，不默认按目标单位入库', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const { result } = await run(site, baseDir, 'rules-1', 'unit-conflict');
    assert.equal(result.tables[0].status, 'ok');
    const materials = result.records.map(r => r.material);
    assert.deepEqual(materials.sort(), ['M-002', 'M-003', 'M-004']);
    assert.equal(result.quarantine.length, 1);
    const q = result.quarantine[0];
    assert.match(q.reason, /毫升/);
    assert.match(q.reason, /冲突/);
    // 站点把第一个 mg/kg（M-001 行）替换为毫升，该行整体隔离。
    assert.equal(q.material, 'M-001');
    assert.equal(q.evidence.rawText, '毫升');
    // 隔离行没有产生任何带错误单位的记录，其余行照常发布。
    assert.ok(!result.records.some(r => r.material === 'M-001'));
  });
  await rm(baseDir, { recursive: true, force: true });
});

// 情景 6：同一表命中互斥规则，阻断且不任取第一条。
test('规则冲突：同表命中两条互斥规则时阻断并列出冲突规则', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const { manifest, bytes } = await captureLayout(site, baseDir, 'normal');
    const rulePack = await loadRulePack('./test/fixtures/rules-conflict.json');
    const result = extractFromBytes({ bytes, manifest, rulePack });
    assert.equal(result.tables[0].status, 'blocked');
    assert.match(result.tables[0].reason, /规则冲突/);
    assert.deepEqual(result.tables[0].conflictingRules.sort(), ['nickel-table-A', 'nickel-table-B']);
    assert.equal(result.records.length, 0);
  });
  await rm(baseDir, { recursive: true, force: true });
});

// 情景 7：离线重提取——站点停止后只凭保存字节换规则重放，两版结果独立保留。
test('离线重放：停止源站后换规则版本重提取，旧结果不被覆盖', async () => {
  const baseDir = await tempDir();
  const site = await createSite();
  let sourceHash;
  try {
    const response = await fetch(site.url + '/bulletin');
    const captured = await captureResponse(baseDir, { url: site.url + '/bulletin', response });
    sourceHash = captured.sourceHash;
    assert.equal(captured.receipt.encoding, 'utf-8');
    assert.equal(captured.receipt.encodingSource, 'header');
  } finally {
    await site.close();
  }

  // 源站已关闭：loadCapture/extractFromBytes 不含任何网络调用。
  const { manifest, bytes } = await loadCapture(baseDir, sourceHash);
  const pack1 = await loadRulePack('rules-1');
  const pack2 = await loadRulePack('rules-2');
  const result1 = extractFromBytes({ bytes, manifest, rulePack: pack1 });
  const result2 = extractFromBytes({ bytes, manifest, rulePack: pack2 });
  verify(result1); verify(result2);

  assert.equal(result1.sourceHash, sourceHash);
  assert.equal(result1.ruleVersion, 'rules-1');
  assert.equal(result2.ruleVersion, 'rules-2');
  assert.notEqual(result1.ruleVersion, result2.ruleVersion);
  // 同一原文、不同规则版本：各自独立可读取，记录都带各自规则版本。
  assert.ok(result2.records.every(r => r.ruleVersion === 'rules-2'));
  assert.ok(result1.records.every(r => r.ruleVersion === 'rules-1'));
  // 两版对 normal 版式语义一致，但转换链/规则证据不同。
  assert.equal(result1.records.length, result2.records.length);
  const r1 = byMaterial(result1)['M-001'];
  const r2 = byMaterial(result2)['M-001'];
  assert.equal(r1.limit, r2.limit);
  assert.equal(r1.conversion.chain[0].from, 'mg/kg');
  assert.equal(r2.footnoteCheck.passed, true);
  assert.equal(r1.footnoteCheck, undefined);
});

// 情景 8：windows-1252 解码、紧凑表头、表头内嵌单位与 µg/g 换算。
test('字符解码与紧凑表头：µ 正确解码，rules-2 展开内嵌单位并保留换算链', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const { result, manifest } = await run(site, baseDir, 'rules-2', 'normal', 'windows-1252');
    assert.equal(manifest.encoding, 'windows-1252');
    assert.equal(manifest.encodingSource, 'header');
    assert.equal(result.encoding.name, 'windows-1252');
    assert.equal(result.tables[0].status, 'ok');
    const record = result.records.find(r => r.material === 'M-008');
    assert.ok(record, '紧凑表记录应可入库');
    assert.equal(record.value, 0.5);
    assert.equal(record.sourceUnit, 'µg/g');
    assert.equal(record.unit, 'mg/kg');
    assert.equal(record.conversion.source, 'header-embedded');
    assert.deepEqual(record.conversion.chain, [{ from: 'µg/g', to: 'mg/kg', factor: 1, rule: 'accept:µg/g' }]);
    assert.equal(record.evidence.value.rawText, '0.5');
    // 字节定位基于原始 windows-1252 字节，而非解码后的 JS 字符位置。
    const rawBytes = await readFile(join(baseDir, 'captures', result.sourceHash, 'raw.bin'));
    const slice = rawBytes.subarray(record.evidence.value.byteRange[0], record.evidence.value.byteRange[1]).toString('latin1');
    assert.match(slice, /0\.5/);
    // µ 在 windows-1252 中是单字节 0xB5，证据字节范围必须能还原。
    const headerBytes = rawBytes.toString('latin1');
    assert.ok(headerBytes.includes('\xb5g/g'));

    // 同一份原文用 rules-1 重放：紧凑表头不满足关键表头，整表阻断，而非静默成功。
    const { manifest: m2, bytes } = await loadCapture(baseDir, result.sourceHash);
    const v1 = extractFromBytes({ bytes, manifest: m2, rulePack: await loadRulePack('rules-1') });
    assert.equal(v1.tables[0].status, 'blocked');
    assert.match(v1.tables[0].reason, /缺少关键表头/);
  });
  await rm(baseDir, { recursive: true, force: true });
});

test('原始字节 sha256 与证据定位可追溯，篡改字节即拒绝加载', async () => {
  const baseDir = await tempDir();
  await withSite(async site => {
    const { manifest } = await captureLayout(site, baseDir, 'normal');
    const loaded = await loadCapture(baseDir, manifest.sourceHash);
    assert.equal(loaded.manifest.sourceHash, manifest.sourceHash);
    const tampered = Buffer.from(loaded.bytes);
    tampered[10] ^= 0xff;
    // 用篡改字节替换保存的原文：loadCapture 的哈希校验直接拒绝，提取层永远拿不到被篡改的输入。
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(baseDir, 'captures', manifest.sourceHash, 'raw.bin'), tampered);
    await assert.rejects(() => loadCapture(baseDir, manifest.sourceHash), /校验失败/);
  });
  await rm(baseDir, { recursive: true, force: true });
});
