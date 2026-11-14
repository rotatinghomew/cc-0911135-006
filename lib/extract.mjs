// 规则应用与结果发布。
// 设计原则：
//  1. 纯函数式输入——只接收已保存字节与规则包，不发起任何网络请求；
//  2. 结构不可信（非法跨度/网格空洞）或缺关键表头时阻断整张表，不产出任何记录；
//  3. 同一表命中多条互斥规则时阻断，绝不自行取第一条；
//  4. 单行歧义（单位冲突、数值不可解析等）进入 quarantine，不影响同表其他行；
//  5. 每个结果都带单元格来源、字符/字节定位、规则版本与完整转换链。
import { decodeWithMap, toByteRange } from './encoding.mjs';
import { parseDocument, extractTables, normalizeSpace } from './grid.mjs';
import { matchColumn, embeddedUnit, validateRulePack } from './rules.mjs';

const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const BELOW_LIMIT = /^<\s*(.+)$/;

function parseValueCell(rawText) {
  const text = normalizeSpace(rawText);
  if (text === '') return { qualifier: 'empty' };
  const below = BELOW_LIMIT.exec(text);
  if (below) {
    const limit = Number(below[1].trim());
    if (!Number.isFinite(limit)) return { qualifier: 'unparseable', rawText: text };
    return { qualifier: 'below-limit', limit, rawText: text };
  }
  if (NUMERIC.test(text)) return { qualifier: 'measured', value: Number(text), rawText: text };
  return { qualifier: 'unparseable', rawText: text };
}

function evidenceFor(table, cell, charToByte, extra = {}) {
  if (!cell?.location) return { tableIndex: table.tableIndex, tableId: table.id, ...extra };
  const [byteStart, byteEnd] = toByteRange(charToByte, cell.location.startOffset, cell.location.endOffset);
  return {
    tableIndex: table.tableIndex,
    tableId: table.id,
    row: cell.row,
    col: cell.col,
    charRange: [cell.location.startOffset, cell.location.endOffset],
    byteRange: [byteStart, byteEnd],
    rawText: cell.text,
    noteRefs: cell.noteRefs,
    ...extra,
  };
}

function resolveColumns(rule, table) {
  const columns = {};
  const missing = [];
  for (const [field, spec] of Object.entries(rule.headers)) {
    const hit = matchColumn(table.columnPaths, spec.paths);
    if (hit) columns[field] = hit.column;
    else if (spec.required) missing.push({ field, expectedPaths: spec.paths });
  }
  return { columns, missing };
}

function cellAt(row, column) {
  return row.cells.find(cell => cell.covers.some(p => p.col === column && p.row === row.rowIndex)) || null;
}

function buildConversion(rule, sourceUnit) {
  const target = rule.unit.target;
  const accepted = rule.unit.accept.find(c => c.unit === sourceUnit);
  if (!accepted) return null;
  const chain = [{ from: sourceUnit, to: target, factor: accepted.factor,
    rule: `accept:${sourceUnit}` }];
  return { target, factor: accepted.factor, chain };
}

function applyFactor(number, factor) {
  if (factor === 1) return number;
  // 保留足够精度但消除浮点尾差（如 0.30000000000000004）。
  return Number((number * factor).toPrecision(12));
}

function mapState(rule, rawState) {
  const mapped = rule.stateMap?.[rawState];
  return mapped ?? null;
}

// 对单张表应用规则包，返回 { status, ruleId, records, quarantine, reason/errors, columns }。
function applyToTable(rulePack, table, footnotes, charToByte) {
  const candidates = rulePack.tables.filter(rule => rule.match.tableId === table.id
    || rule.match.tableId === `table-index:${table.tableIndex}`);

  if (candidates.length > 1) {
    return {
      status: 'blocked',
      reason: `规则冲突：表 ${table.id ?? `#${table.tableIndex}`} 同时命中互斥规则 ${candidates.map(r => r.id).join('、')}，不得任取第一条`,
      ruleIds: candidates.map(r => r.id),
      records: [], quarantine: [],
    };
  }
  if (candidates.length === 0) {
    return {
      status: 'blocked',
      reason: `没有规则适用于表 ${table.id ?? `#${table.tableIndex}`}（规则版本 ${rulePack.ruleVersion}）`,
      records: [], quarantine: [],
    };
  }
  const rule = candidates[0];

  if (table.status === 'blocked') {
    return {
      status: 'blocked', ruleId: rule.id,
      reason: '表格结构解析失败，合并单元格无法可信展开',
      structuralErrors: table.errors,
      records: [], quarantine: [],
    };
  }

  const { columns, missing } = resolveColumns(rule, table);
  if (missing.length > 0) {
    return {
      status: 'blocked', ruleId: rule.id,
      reason: `缺少关键表头：${missing.map(m => `${m.field}（期望 ${m.expectedPaths.map(p => p.join('/')).join(' 或 ')}）`).join('；')}`,
      missingHeaders: missing,
      records: [], quarantine: [],
    };
  }

  const records = [];
  const quarantine = [];
  const valueHeaderText = table.columnPaths[columns.value]?.join('/') || null;
  const headerUnit = embeddedUnit(valueHeaderText, rule.headerEmbeddedUnit?.pattern);

  for (const row of table.bodyRows) {
    const rowLabel = `表 ${table.id ?? `#${table.tableIndex}`} 第 ${row.rowIndex} 行`;
    const materialCell = cellAt(row, columns.material);
    const valueCell = cellAt(row, columns.value);
    const unitCell = columns.unit === undefined ? null : cellAt(row, columns.unit);
    const stateCell = columns.state === undefined ? null : cellAt(row, columns.state);
    const partCell = columns.part === undefined ? null : cellAt(row, columns.part);

    const material = materialCell?.text || '';
    if (!material) {
      quarantine.push({ reason: `${rowLabel} 缺少材料号，无法归属`, ruleId: rule.id,
        evidence: evidenceFor(table, materialCell, charToByte, { row: row.rowIndex }) });
      continue;
    }
    if (!valueCell) {
      quarantine.push({ reason: `${rowLabel} 缺少结果单元格`, ruleId: rule.id, material,
        evidence: evidenceFor(table, null, charToByte, { row: row.rowIndex }) });
      continue;
    }

    const parsed = parseValueCell(valueCell.text);
    const part = partCell?.text || null;
    const rawStateText = stateCell?.text ?? null;
    const state = rawStateText === null
      ? (rule.headers.state?.default ?? null)
      : mapState(rule, rawStateText);
    if (rawStateText !== null && state === null) {
      quarantine.push({ reason: `${rowLabel} 状态 "${rawStateText}" 不在规则状态映射表内`,
        ruleId: rule.id, material, evidence: evidenceFor(table, stateCell, charToByte) });
      continue;
    }

    const base = {
      material,
      part,
      element: rule.element,
      sourceUnit: null,
      unit: null,
      value: null,
      limit: null,
      qualifier: parsed.qualifier,
      state,
      rawState: rawStateText,
      ruleId: rule.id,
      ruleVersion: rulePack.ruleVersion,
      evidence: {
        material: evidenceFor(table, materialCell, charToByte),
        value: evidenceFor(table, valueCell, charToByte),
        ...(unitCell ? { unit: evidenceFor(table, unitCell, charToByte) } : {}),
        ...(stateCell ? { state: evidenceFor(table, stateCell, charToByte) } : {}),
        ...(partCell ? { part: evidenceFor(table, partCell, charToByte) } : {}),
      },
      notes: valueCell.noteRefs.map(ref => ({
        ref,
        footnote: footnotes.find(note => note.id === `note${ref}`)?.text ?? null,
      })),
      conversion: null,
      publishable: false,
      publishReason: null,
    };

    // 单位归属：独立单位列优先，其次表头内嵌单位；都没有则按规则策略隔离。
    // 单位归属先于语义分支，使“未检”等无值记录同样保留单位与转换链证据。
    const sourceUnit = normalizeSpace(unitCell?.text || '') || headerUnit;
    const conversion = sourceUnit ? buildConversion(rule, sourceUnit) : null;
    if (sourceUnit && !conversion) {
      quarantine.push({
        reason: `${rowLabel} 单位 "${sourceUnit}" 与规则 ${rulePack.ruleVersion} 的目标单位 ${rule.unit.target} 冲突，且无换算定义，不得默认按目标单位入库`,
        ruleId: rule.id, material, evidence: base.evidence.unit ?? base.evidence.value,
      });
      continue;
    }
    if (!sourceUnit) {
      // 未检行没有结果值，单位缺失不改变其语义，仅记录无转换链；其余情形隔离。
      if (parsed.qualifier !== 'empty') {
        quarantine.push({ reason: `${rowLabel} 无法确定结果单位（单位列缺失且表头无内嵌单位）`,
          ruleId: rule.id, material, evidence: base.evidence.value });
        continue;
      }
    } else {
      base.sourceUnit = sourceUnit;
      base.unit = conversion.target;
      base.conversion = {
        target: conversion.target,
        factor: conversion.factor,
        chain: conversion.chain,
        source: unitCell?.text ? 'unit-column' : 'header-embedded',
      };
    }

    // 空结果不等于零：结合状态区分“未检”与“结果缺失”。
    if (parsed.qualifier === 'empty') {
      if (state === 'not-tested') {
        records.push(finalize({ ...base, qualifier: 'not-tested', value: null,
          publishable: false, publishReason: '未检项目没有检测值，不进入材料库' }));
        continue;
      }
      quarantine.push({ reason: `${rowLabel} 结果单元格为空白且状态并非“未检”，空白不得按零处理`,
        ruleId: rule.id, material, evidence: base.evidence.value });
      continue;
    }
    if (parsed.qualifier === 'unparseable') {
      quarantine.push({ reason: `${rowLabel} 结果 "${parsed.rawText}" 无法解析为数值或检出限表达式`,
        ruleId: rule.id, material, evidence: base.evidence.value });
      continue;
    }

    if (parsed.qualifier === 'below-limit') {
      // 检出限来自单元格表达式；脚注只做核验，绝不作为检测值读取。
      const convertedLimit = applyFactor(parsed.limit, conversion.factor);
      base.limit = convertedLimit;
      base.value = null;
      base.publishable = true;
      base.publishReason = '低于检出限记录，保留原始语义与检出限';
      if (rule.footnotes?.verifyBelowLimit) {
        const verification = verifyFootnotes(base.notes, parsed.limit, sourceUnit);
        base.footnoteCheck = verification;
        if (!verification.passed) {
          quarantine.push({ reason: `${rowLabel} 低于检出限但脚注核验未通过：${verification.detail}`,
            ruleId: rule.id, material, evidence: base.evidence.value, notes: base.notes });
          continue;
        }
      }
    } else {
      base.value = applyFactor(parsed.value, conversion.factor);
      if (state === 'withdrawn') {
        base.publishable = false;
        base.publishReason = '撤回记录：数值保留原始语义但不发布到材料库';
      } else if (state === 'valid') {
        base.publishable = true;
        base.publishReason = null;
      } else {
        base.publishable = false;
        base.publishReason = `状态 ${state} 不具备发布条件`;
      }
    }
    records.push(finalize(base));
  }

  return {
    status: 'ok', ruleId: rule.id, columns,
    headerEmbeddedUnit: headerUnit,
    records, quarantine,
  };
}

function verifyFootnotes(notes, cellLimit, sourceUnit) {
  if (notes.length === 0) return { passed: false, detail: '单元格带检出限表达式但没有脚注引用' };
  for (const note of notes) {
    if (!note.footnote) return { passed: false, detail: `脚注 ${note.ref} 在正文中找不到对应内容` };
    const numbers = note.footnote.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (!numbers.includes(cellLimit)) {
      return { passed: false, detail: `脚注 ${note.ref} 中的数值 ${numbers.join('、') || '（无）'} 与单元格检出限 ${cellLimit} 不一致` };
    }
    if (!note.footnote.includes(sourceUnit)) {
      return { passed: false, detail: `脚注 ${note.ref} 未声明单位 ${sourceUnit}` };
    }
  }
  return { passed: true, detail: `脚注检出限 ${cellLimit} ${sourceUnit} 与单元格表达式一致；脚注数值不作为检测值` };
}

function finalize(record) {
  // 字段顺序固定，便于人工审阅与版本 diff。
  return {
    material: record.material,
    part: record.part,
    element: record.element,
    value: record.value,
    limit: record.limit,
    qualifier: record.qualifier,
    state: record.state,
    rawState: record.rawState,
    sourceUnit: record.sourceUnit,
    unit: record.unit,
    conversion: record.conversion,
    publishable: record.publishable,
    publishReason: record.publishReason,
    ruleVersion: record.ruleVersion,
    ruleId: record.ruleId,
    notes: record.notes,
    ...(record.footnoteCheck ? { footnoteCheck: record.footnoteCheck } : {}),
    evidence: record.evidence,
  };
}

// 离线提取主入口：输入捕获清单与原始字节，全程不访问网络。
export function extractFromBytes({ bytes, manifest, rulePack, receiptName }) {
  validateRulePack(rulePack);
  const chosenReceipt = receiptName ?? manifest.receipts?.[0];
  if (!chosenReceipt) throw new Error('捕获清单缺少接收记录，无法确定解码依据');
  const encoding = manifest.encoding;
  if (!encoding) throw new Error('捕获清单缺少编码判定结果，无法离线解码');
  const { text, charToByte } = decodeWithMap(bytes, encoding);
  const document = parseDocument(text);
  const { tables, footnotes } = extractTables(document);

  const tableResults = [];
  const records = [];
  const quarantine = [];

  for (const table of tables) {
    const result = applyToTable(rulePack, table, footnotes, charToByte);
    tableResults.push({
      tableIndex: table.tableIndex,
      tableId: table.id,
      status: result.status,
      ruleVersion: rulePack.ruleVersion,
      ruleId: result.ruleId ?? null,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.ruleIds ? { conflictingRules: result.ruleIds } : {}),
      ...(result.missingHeaders ? { missingHeaders: result.missingHeaders } : {}),
      ...(result.structuralErrors ? { structuralErrors: table.errors } : {}),
      recordCount: result.records.length,
      quarantineCount: result.quarantine.length,
      ...(result.columns ? { columns: result.columns } : {}),
      ...(result.headerEmbeddedUnit ? { headerEmbeddedUnit: result.headerEmbeddedUnit } : {}),
    });
    records.push(...result.records);
    quarantine.push(...result.quarantine.map(item => ({ ruleVersion: rulePack.ruleVersion, ...item })));
  }

  return {
    sourceHash: manifest.sourceHash,
    ruleVersion: rulePack.ruleVersion,
    capturedAt: manifest.capturedAt ?? null,
    receipt: chosenReceipt,
    encoding: { name: encoding, source: manifest.encodingSource ?? null },
    tables: tableResults,
    records,
    quarantine,
    footnotes,
  };
}
