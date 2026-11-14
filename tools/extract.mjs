// 离线提取 CLI：npm run extract -- <sourceHash> [--rule rules-1] [--var var] [--out 文件] [--force]
// 只读取 var/captures/<hash> 下已保存的字节，全程不发起网络请求。
import { resolve, join, dirname } from 'node:path';
import { access, writeFile, mkdir } from 'node:fs/promises';
import { loadCapture } from '../lib/capture.mjs';
import { loadRulePack } from '../lib/rules.mjs';
import { extractFromBytes } from '../lib/extract.mjs';
import { verify } from '../lib/verify.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const sourceHash = args.find(a => !a.startsWith('--'));
if (!sourceHash) throw new Error('用法：npm run extract -- <sourceHash> [--rule rules-N] [--var 目录] [--out 文件] [--force]');
const baseDir = resolve(option('var', 'var'));
const ruleVersion = option('rule', 'rules-1');
const force = args.includes('--force');

const { manifest, bytes } = await loadCapture(baseDir, sourceHash);
const rulePack = await loadRulePack(ruleVersion);
const result = extractFromBytes({ bytes, manifest, rulePack });
verify(result); // 发布前自检，不通过直接非零退出，不写文件。

const out = resolve(option('out', join(baseDir, 'results', `${sourceHash}.${rulePack.ruleVersion}.records.json`)));
await mkdir(dirname(out), { recursive: true });
try {
  await access(out);
  if (!force) {
    console.error(`拒绝覆盖既有发布结果：${out}\n规则订正应产生独立文件；如确需重写请显式加 --force。`);
    process.exit(2);
  }
} catch {
  // 文件不存在，正常写入。
}
await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
const publishable = result.records.filter(r => r.publishable).length;
console.log(JSON.stringify({
  out,
  sourceHash: result.sourceHash,
  ruleVersion: result.ruleVersion,
  tables: result.tables.map(t => ({ tableId: t.tableId, status: t.status,
    records: t.recordCount ?? 0, quarantine: t.quarantineCount ?? 0, ...(t.reason ? { reason: t.reason } : {}) })),
  records: result.records.length,
  publishable,
  quarantined: result.quarantine.length,
}, null, 2));
