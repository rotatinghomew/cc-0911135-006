// 表格结构解析：把 HTML 表格按 rowspan/colspan 展开为矩形网格。
// 不依赖浏览器容错：跨度 0、网格重叠/空洞等结构问题一律作为表级错误返回，
// 由上层决定阻断整张表，而不是悄悄修正后继续。
import { parse } from 'parse5';

const ROW_GROUPS = new Set(['thead', 'tbody', 'tfoot']);

function attr(node, name) {
  return node.attrs?.find(a => a.name === name)?.value ?? null;
}

export function normalizeSpace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function textOf(node) {
  let text = '';
  for (const descendant of walk(node)) {
    if (descendant.nodeName === '#text') text += descendant.value;
  }
  return text;
}

function* walk(node) {
  for (const child of node.childNodes || []) {
    yield child;
    yield* walk(child);
  }
}

// 单元格可见文本：sup 内的数字作为脚注引用记录；sup 本身的文本不进入结果文本。
function cellText(cell) {
  const noteRefs = [];
  let text = '';
  function visit(node, insideSup) {
    if (node.nodeName === '#text') {
      if (insideSup) {
        const n = node.value.trim();
        if (/^\d+$/.test(n)) noteRefs.push(Number(n));
      } else {
        text += node.value;
      }
      return;
    }
    const sup = insideSup || node.tagName === 'sup';
    for (const child of node.childNodes || []) visit(child, sup);
  }
  for (const child of cell.childNodes || []) visit(child, false);
  return { text: normalizeSpace(text), noteRefs: [...new Set(noteRefs)] };
}

function span(cell, name) {
  const raw = attr(cell, name);
  if (raw === null) return 1;
  if (!/^\d+$/.test(raw.trim())) return { invalid: true, raw };
  const value = Number(raw);
  // 业务协议明确：跨度 0 非法，不能交给浏览器自动修复。
  if (value === 0) return { invalid: true, raw };
  return value;
}

export function parseDocument(html) {
  return parse(html, { sourceCodeLocationInfo: true });
}

// 返回 { tables, footnotes }。每个 table 自带 status：
//   ok —— 网格完整；blocked —— 结构不可信，errors 给出定位。
export function extractTables(document) {
  const tables = [];
  const footnotes = [];
  let tableOrder = 0;

  for (const node of walk(document)) {
    if (node.nodeName === '#text' || !('tagName' in node)) continue;
    if (node.tagName === 'p' && /^note/i.test(attr(node, 'id') || '')) {
      footnotes.push({
        id: attr(node, 'id'),
        text: normalizeSpace(textOf(node)),
        location: node.sourceCodeLocation ? {
          startOffset: node.sourceCodeLocation.startOffset,
          endOffset: node.sourceCodeLocation.endOffset,
        } : null,
      });
    }
    if (node.tagName !== 'table') continue;
    tableOrder += 1;
    const table = {
      tableIndex: tableOrder - 1,
      id: attr(node, 'id'),
      status: 'ok',
      errors: [],
      headerRows: [],
      bodyRows: [],
      columnCount: 0,
      columnPaths: [],
      location: node.sourceCodeLocation ? {
        startOffset: node.sourceCodeLocation.startOffset,
        endOffset: node.sourceCodeLocation.endOffset,
      } : null,
    };
    buildGrid(node, table);
    if (table.errors.length > 0) table.status = 'blocked';
    tables.push(table);
  }
  return { tables, footnotes };
}

function buildGrid(tableNode, table) {
  const errors = table.errors;
  const rows = [];

  // 一次遍历同时收集 DOM 行节点与所属分区，避免二次查找和可变计数器。
  (function collect(node, section) {
    if (node.nodeName === '#text') return;
    if (node.tagName && ROW_GROUPS.has(node.tagName)) section = node.tagName;
    if (node.tagName === 'tr') {
      rows.push({
        section: section === 'thead' || section === 'tfoot' ? section : 'tbody',
        cellNodes: node.childNodes.filter(n => n.tagName === 'th' || n.tagName === 'td'),
      });
    }
    for (const child of node.childNodes || []) collect(child, section);
  })(tableNode, null);

  if (rows.length === 0) {
    errors.push({ code: 'empty-table', message: '表格不含任何行', location: table.location });
    return;
  }

  // 占用矩阵：每个网格位置记录归属单元格锚点；重复写入即结构冲突。
  const occupancy = new Map();
  const at = (r, c) => occupancy.get(`${r}:${c}`);
  const anchors = [];

  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cellNode of row.cellNodes) {
      while (at(rowIndex, column)) column += 1;
      const rowspan = span(cellNode, 'rowspan');
      const colspan = span(cellNode, 'colspan');
      const loc = cellNode.sourceCodeLocation;
      if (typeof rowspan !== 'number' || typeof colspan !== 'number') {
        const bad = typeof rowspan !== 'number'
          ? { attr: 'rowspan', value: rowspan.raw }
          : { attr: 'colspan', value: colspan.raw };
        errors.push({
          code: 'invalid-span',
          message: `非法跨度 ${bad.attr}="${bad.value}"（跨度必须为正整数）`,
          location: loc ? { startOffset: loc.startOffset, endOffset: loc.endOffset } : null,
          row: rowIndex,
        });
        continue; // 跳过该单元格，不写入网格，避免污染后续归属
      }
      const { text, noteRefs } = cellText(cellNode);
      const anchor = {
        text, noteRefs,
        isHeader: cellNode.tagName === 'th',
        section: row.section,
        row: rowIndex, col: column, rowspan, colspan,
        covers: [],
        location: loc ? { startOffset: loc.startOffset, endOffset: loc.endOffset } : null,
      };
      for (let r = rowIndex; r < rowIndex + rowspan; r++) {
        for (let c = column; c < column + colspan; c++) {
          if (at(r, c)) {
            errors.push({
              code: 'grid-overlap',
              message: `网格位置 (${r},${c}) 被多个单元格占用`,
              location: anchor.location, row: r, col: c,
            });
            continue;
          }
          occupancy.set(`${r}:${c}`, anchor);
          anchor.covers.push({ row: r, col: c });
        }
      }
      anchors.push(anchor);
      column += colspan;
    }
  });

  let columnCount = 0;
  for (const key of occupancy.keys()) {
    const c = Number(key.split(':')[1]);
    if (c + 1 > columnCount) columnCount = c + 1;
  }
  table.columnCount = columnCount;

  // 头部行：thead 内全部行；无 thead 时，仅当首行全部为 th 才取首行。
  const theadRowCount = rows.filter(r => r.section === 'thead').length;
  const isHeaderRow = (index) => {
    if (theadRowCount > 0) return rows[index].section === 'thead';
    return index === 0 && rows[0].cellNodes.every(n => n.tagName === 'th');
  };

  for (let r = 0; r < rows.length; r++) {
    const rowAnchors = anchors.filter(a => a.row === r);
    if (isHeaderRow(r)) {
      table.headerRows.push({ rowIndex: r, cells: rowAnchors });
    } else {
      table.bodyRows.push({ rowIndex: r, section: rows[r].section, cells: rowAnchors });
    }
    for (let c = 0; c < columnCount; c++) {
      if (!at(r, c)) {
        errors.push({
          code: 'grid-hole',
          message: `网格位置 (${r},${c}) 无单元格覆盖`,
          row: r, col: c,
        });
      }
    }
  }

  // 每一列的表头路径：覆盖该列的每个表头单元格文本，按表头行顺序排列。
  table.columnPaths = Array.from({ length: columnCount }, (_, col) => {
    const parts = [];
    for (const headerRow of table.headerRows) {
      for (const cell of headerRow.cells) {
        if (cell.covers.some(p => p.col === col) && !parts.includes(cell.text)) {
          parts.push(cell.text);
        }
      }
    }
    return parts.filter(Boolean);
  });
}
