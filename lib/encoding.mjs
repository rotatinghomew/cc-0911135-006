// 字符编码判定与可追溯解码。
// 优先级：HTTP Content-Type charset > 文档 meta charset > 默认 utf-8。
// 解码同时构建 字符偏移 -> 字节偏移 的映射，使单元格的字符级定位能还原为原始字节定位。

const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9][a-zA-Z0-9._-]*)/i;

export function resolveEncoding(contentTypeHeader, bytes) {
  const fromHeader = /charset=([a-zA-Z0-9._-]+)/i.exec(contentTypeHeader || '')?.[1];
  if (fromHeader) return { encoding: fromHeader.toLowerCase(), source: 'header' };
  // meta 只可能出现在文档前部；按 latin1 读取不会破坏 ASCII 模式匹配。
  const head = bytes.subarray(0, 1024).toString('latin1');
  const fromMeta = META_CHARSET.exec(head)?.[1];
  if (fromMeta) return { encoding: fromMeta.toLowerCase(), source: 'meta' };
  return { encoding: 'utf-8', source: 'default' };
}

// 逐字节喂给流式 TextDecoder：多字节序列由解码器内部缓冲，
// 每产出一个字符就记录当前字节边界，得到严格对齐的 charToByte 表。
// 字符 j 对应原始字节区间 [charToByte[j], charToByte[j+1])。
export function decodeWithMap(bytes, encoding) {
  const decoder = new TextDecoder(encoding, { fatal: false });
  const charToByte = [0];
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    const part = decoder.decode(bytes.subarray(i, i + 1), { stream: true });
    for (const ch of part) {
      text += ch;
      charToByte.push(i + 1);
    }
  }
  const tail = decoder.decode();
  for (const ch of tail) {
    text += ch;
    charToByte.push(bytes.length);
  }
  if (charToByte.length !== text.length + 1) {
    throw new Error('字符-字节偏移映射构建失败，解码边界不一致');
  }
  return { text, charToByte };
}

export function toByteRange(charToByte, startOffset, endOffset) {
  return [charToByte[startOffset], charToByte[endOffset]];
}
