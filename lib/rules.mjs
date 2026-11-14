// 版本化规则的加载与自检。规则是纯数据，所有版本永久保留；
// 加载时校验结构与换算系数，防止把错误规则投入发布流程。
import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

export async function loadRulePack(pathOrVersion) {
  let filename;
  if (pathOrVersion.endsWith('.json')) {
    filename = pathOrVersion;
  } else {
    filename = new URL(`../data/rules/${pathOrVersion}.json`, import.meta.url).pathname;
  }
  const pack = JSON.parse(await readFile(filename, 'utf8'));
  validateRulePack(pack, filename);
  return pack;
}

export async function listRulePacks() {
  const dir = new URL('../data/rules/', import.meta.url).pathname;
  const entries = await readdir(dir).catch(() => []);
  return entries.filter(name => name.endsWith('.json')).map(name => basename(name, '.json')).sort();
}

export function validateRulePack(pack, source = '规则包') {
  if (!pack || typeof pack !== 'object') throw new Error(`${source} 不是对象`);
  if (!/^rules-[a-z0-9-]+$/i.test(pack.ruleVersion || '')) {
    throw new Error(`${source} 缺少合规的 ruleVersion（应为 rules-<版本标识>）`);
  }
  if (!Array.isArray(pack.tables) || pack.tables.length === 0) {
    throw new Error(`${pack.ruleVersion} 至少需要一条表格规则`);
  }
  const ids = new Set();
  for (const rule of pack.tables) {
    if (!rule.id || ids.has(rule.id)) throw new Error(`${pack.ruleVersion} 规则 id 缺失或重复：${rule.id}`);
    ids.add(rule.id);
    if (!rule.match?.tableId) throw new Error(`${pack.ruleVersion}/${rule.id} 缺少 match.tableId`);
    if (!rule.headers?.material?.required || !rule.headers?.value?.required) {
      throw new Error(`${pack.ruleVersion}/${rule.id} 的 material/value 必须为必填列`);
    }
    for (const [field, spec] of Object.entries(rule.headers)) {
      if (!Array.isArray(spec.paths) || spec.paths.length === 0) {
        throw new Error(`${pack.ruleVersion}/${rule.id} 字段 ${field} 缺少 paths`);
      }
      for (const path of spec.paths) {
        if (!Array.isArray(path) || path.some(part => typeof part !== 'string' || !part)) {
          throw new Error(`${pack.ruleVersion}/${rule.id} 字段 ${field} 的路径必须是非空字符串数组`);
        }
      }
    }
    const unit = rule.unit;
    if (!unit?.target || !Array.isArray(unit.accept) || unit.accept.length === 0) {
      throw new Error(`${pack.ruleVersion}/${rule.id} 缺少目标单位与接受单位表`);
    }
    for (const conversion of unit.accept) {
      if (!conversion.unit || !Number.isFinite(conversion.factor) || conversion.factor <= 0) {
        throw new Error(`${pack.ruleVersion}/${rule.id} 存在非法换算系数`);
      }
    }
    const seenUnits = new Set();
    for (const conversion of unit.accept) {
      if (seenUnits.has(conversion.unit)) {
        throw new Error(`${pack.ruleVersion}/${rule.id} 单位 ${conversion.unit} 重复定义`);
      }
      seenUnits.add(conversion.unit);
    }
    if (!unit.accept.some(c => c.unit === unit.target && c.factor === 1)) {
      throw new Error(`${pack.ruleVersion}/${rule.id} 目标单位 ${unit.target} 必须以系数 1 出现在接受单位表中`);
    }
  }
}

// 表头路径匹配：规则路径与列的表头层级完全相等才算命中。
export function matchColumn(columnPaths, rulePaths) {
  for (const path of rulePaths) {
    const index = columnPaths.findIndex(columns =>
      columns.length === path.length && columns.every((part, i) => part === path[i]));
    if (index >= 0) return { column: index, matchedPath: path };
  }
  return null;
}

// 从表头文本中提取括号内的内嵌单位，例如 "Ni (µg/g)" -> "µg/g"。
export function embeddedUnit(headerText, pattern) {
  if (!pattern) return null;
  const match = new RegExp(pattern, 'u').exec(headerText || '');
  return match ? match[1].trim() : null;
}
