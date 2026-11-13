import { parse } from 'parse5';
function countTables(node) {
  return (node.tagName === 'table' ? 1 : 0) + (node.childNodes || []).reduce((total, child) => total + countTables(child), 0);
}
export async function inspect(base) {
  const response = await fetch(base + '/bulletin');
  const bytes = await response.arrayBuffer();
  const encoding = /charset=([^;]+)/i.exec(response.headers.get('content-type'))?.[1] || 'utf-8';
  const html = new TextDecoder(encoding).decode(bytes);
  return { status: response.status, encoding, bytes: bytes.byteLength, tables: countTables(parse(html)) };
}
