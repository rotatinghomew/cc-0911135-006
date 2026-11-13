import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

import { inspect } from '../src/client.mjs';
test('原文和清点保留合并表头及脚注', async () => withSite(async site => {
  const result = await inspect(site.url);
  assert.equal(result.tables, 1);
  const raw = await (await fetch(site.url + '/bulletin')).text();
  assert.match(raw, /rowspan="2"/); assert.match(raw, /检出限/); assert.match(raw, /&lt;0.02/);
}));
test('非法跨度和非默认字符编码可复现', async () => withSite(async site => {
  await control(site, { layout: 'badspan' });
  assert.match(await (await fetch(site.url + '/bulletin')).text(), /colspan="0"/);
  await control(site, { encoding: 'windows-1252' });
  const response = await fetch(site.url + '/bulletin');
  assert.match(new TextDecoder('windows-1252').decode(await response.arrayBuffer()), /µg\/g/);
}));
test('缺少规则版本和来源证据不可发布', () => assert.throws(() => verify({ records: [], quarantine: [] })));

test('缺表头和冲突单位保持为不同来源情景', async () => withSite(async site => {
  await control(site, { layout: 'missing' });
  const missing = await (await fetch(site.url + '/bulletin')).text();
  assert.ok(!missing.includes('<th>单位</th>'));
  await control(site, { layout: 'unit-conflict' });
  assert.match(await (await fetch(site.url + '/bulletin')).text(), /<td>毫升<\/td>/);
}));
