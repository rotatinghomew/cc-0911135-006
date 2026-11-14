# 协议与数据格式

## 源端演练接口

GET /bulletin 返回 HTML。Content-Type charset 优先于 meta，演练编码为 utf-8 和 windows-1252。
POST /_control 可选 layout：normal、badspan、missing、unit-conflict，以及 encoding。
非法跨度 0 在该业务协议中不允许，不能依靠浏览器自动修复后忽略。
`/_audit` 查看源端请求证据；`/_control` 仅用于演练，不属于业务采集入口。

## 接收留痕（var/captures/<sha256>/）

- `raw.bin`：响应体原始字节，文件名即内容 sha256；加载时重新哈希，不一致即拒绝。
- `manifest.json`：sourceHash、rawBytes、encoding、encodingSource（header/meta/default）、capturedAt、receipts 列表。
- `receipt-N.json`：每次接收的来源 URL、接收时间、HTTP 状态码、完整响应头与字节长度。
  同一原文被接收多次只追加 receipt，不覆盖字节；同哈希目录出现异字节直接报错。

## 规则包（data/rules/rules-N.json，永久保留）

目标字段：material、part、element、value、unit、qualifier、state。
规则加载即自检：ruleVersion 形态、必填列、换算系数为正数、单位不重复、目标单位系数为 1。
`<0.02` 必须解释为低于检出限（value=null、limit=0.02），不是 0.02 的精确测量；空白、零和撤回不得混同。

## 发布结果 records.json

顶层字段：sourceHash、ruleVersion、capturedAt、receipt、encoding{name,source}、tables、records、quarantine、footnotes。

- records 每条含 material、part、element、value、limit、qualifier、state、rawState、sourceUnit、unit、
  conversion（target/factor/chain/source）、publishable、publishReason、ruleVersion、ruleId、notes、evidence。
- qualifier 取值：measured | below-limit | not-tested；空白语义只能出现在 quarantine，不进入 records。
- evidence 按字段分别记录来源单元格：tableIndex、tableId、row、col、charRange、byteRange、rawText、noteRefs。
- quarantine 每条含 reason、ruleId、material（可归属时）、evidence；表级失败的 tables 项含 status=blocked、
  reason 及 structuralErrors/missingHeaders/conflictingRules 之一，且 recordCount=0。
- 规则新版本输出独立命名（`<sourceHash>.<ruleVersion>.records.json`），旧版文件仍可读取，默认拒绝覆盖。

## 阻断与隔离决策

1. 结构解析（grid.mjs）产出 invalid-span / grid-overlap / grid-hole 任一错误：表 blocked。
2. 规则包内多条规则命中同一表：blocked 并列出 conflictingRules；零规则适用：blocked。
3. 规则 required 表头无法按层级路径命中：blocked 并列出 missingHeaders。
4. 其余歧义只隔离单行：单位冲突/缺失、不可解析数值、空白非未检、未知状态、材料号缺失、脚注核验失败。
