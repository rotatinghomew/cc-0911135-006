// 原文接收 CLI：npm run capture -- http://127.0.0.1:端口/bulletin [--var var]
// 只负责接收与留痕，不做任何表格解析。
import { resolve } from 'node:path';
import { captureResponse } from '../lib/capture.mjs';

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
if (!url) throw new Error('用法：npm run capture -- <公告URL> [--var <目录>]');
const baseDir = resolve(args[args.indexOf('--var') + 1] || 'var');

const response = await fetch(url);
const result = await captureResponse(baseDir, { url, response });
console.log(JSON.stringify({
  sourceHash: result.sourceHash,
  savedAt: result.location,
  receipt: result.receipt,
  encoding: result.receipt.encoding,
  encodingSource: result.receipt.encodingSource,
  byteLength: result.receipt.byteLength,
}, null, 2));
