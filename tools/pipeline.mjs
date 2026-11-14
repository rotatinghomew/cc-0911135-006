// 端到端流水线 CLI：接收原文并立即用指定规则版本发布。
// npm run pipeline -- http://127.0.0.1:端口/bulletin [--rule rules-N] [--var 目录]
// 适用于演练；生产采集与规则重放也可分两步使用 capture / extract。
import { resolve, join } from 'node:path';
import { captureResponse, loadCapture } from '../lib/capture.mjs';
import { loadRulePack } from '../lib/rules.mjs';
import { extractFromBytes } from '../lib/extract.mjs';
import { verify } from '../lib/verify.mjs';
import { writeFile, access, mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = args.find(a => !a.startsWith('--'));
if (!url) throw new Error('用法：npm run pipeline -- <公告URL> [--rule rules-N] [--var 目录]');
const baseDir = resolve(option('var', 'var'));
const ruleVersion = option('rule', 'rules-1');

const response = await fetch(url);
const captured = await captureResponse(baseDir, { url, response });
const { manifest, bytes } = await loadCapture(baseDir, captured.sourceHash);
const rulePack = await loadRulePack(ruleVersion);
const result = extractFromBytes({ bytes, manifest, rulePack });
verify(result);

const out = join(baseDir, 'results', `${captured.sourceHash}.${rulePack.ruleVersion}.records.json`);
await mkdir(join(baseDir, 'results'), { recursive: true });
try {
  await access(out);
  console.error(`结果文件已存在，本次仅完成接收与内存校验，未覆盖：${out}`);
} catch {
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify({
  sourceHash: captured.sourceHash,
  ruleVersion: rulePack.ruleVersion,
  out,
  records: result.records.length,
  publishable: result.records.filter(r => r.publishable).length,
  quarantined: result.quarantine.length,
  blockedTables: result.tables.filter(t => t.status === 'blocked').length,
}, null, 2));
