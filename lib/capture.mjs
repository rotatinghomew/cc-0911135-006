// 原文接收：保存实际字节、响应头、来源地址、摘要、接收时间与解码依据。
// 内容寻址：同一 sha256 的原文只保存一份并返回既有清单，绝不覆盖；
// 不同站点响应即使内容相同也各自记录接收清单（清单按接收实例编号）。
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveEncoding } from './encoding.mjs';

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function paths(baseDir, sourceHash) {
  return {
    dir: join(baseDir, 'captures', sourceHash),
    bytes: join(baseDir, 'captures', sourceHash, 'raw.bin'),
    manifest: join(baseDir, 'captures', sourceHash, 'manifest.json'),
  };
}

// 从已保存清单读取原始字节。提取流水线只能走这里，禁止重新请求站点。
export async function loadCapture(baseDir, sourceHash) {
  const location = paths(baseDir, sourceHash);
  const manifest = JSON.parse(await readFile(location.manifest, 'utf8'));
  const bytes = await readFile(location.bytes);
  if (hashBytes(bytes) !== sourceHash) {
    throw new Error(`原始字节校验失败：期望 ${sourceHash}`);
  }
  return { manifest, bytes };
}

export async function captureResponse(baseDir, { url, response, receivedAt = new Date().toISOString() }) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const sourceHash = hashBytes(buffer);
  const location = paths(baseDir, sourceHash);
  await mkdir(location.dir, { recursive: true });

  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  const contentType = headers['content-type'] || '';
  const { encoding, source: encodingSource } = resolveEncoding(contentType, buffer);

  const existingManifests = await readdir(location.dir).then(entries =>
    entries.filter(name => /^receipt-\d+\.json$/.test(name)).sort(), () => []);

  let rawAlreadySaved = false;
  try {
    await access(location.bytes);
    rawAlreadySaved = true;
  } catch {
    rawAlreadySaved = false;
  }
  if (!rawAlreadySaved) {
    await writeFile(location.bytes, buffer);
  } else {
    // 目录里已有 raw.bin：核对字节一致性后复用，防止同名哈希目录被异数据污染。
    const saved = await readFile(location.bytes);
    if (!saved.equals(buffer)) throw new Error(`哈希目录 ${sourceHash} 内存在不一致的原始字节`);
  }

  const receiptNo = existingManifests.length;
  const receipt = {
    receipt: `receipt-${receiptNo}.json`,
    sourceUrl: url,
    receivedAt,
    httpStatus: response.status,
    responseHeaders: headers,
    encoding,
    encodingSource,
    byteLength: buffer.length,
  };
  await writeFile(join(location.dir, receipt.receipt), `${JSON.stringify(receipt, null, 2)}\n`);

  const manifest = {
    sourceHash,
    rawBytes: 'raw.bin',
    encoding,
    encodingSource,
    capturedAt: receipt.receivedAt,
    receipts: [...new Set([...existingManifests, receipt.receipt])].sort(),
    firstReceipt: receiptNo === 0 ? receipt.receipt : undefined,
  };
  await writeFile(location.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { sourceHash, manifest, receipt, location: location.dir };
}
