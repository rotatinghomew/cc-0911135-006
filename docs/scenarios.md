# 业务演练与回归结论

回归测试 `test/extraction.test.mjs` 全部通过本地演练服务；下表的“入库/隔离/阻断”结论可由 `npm test` 复现。

| 情景 | 触发方式 | 规则版本 | 结论 | 依据 |
|---|---|---|---|---|
| 两层合并表头 | normal | rules-1 | 4 条记录，2 条可入库 | Ni/结果（列2）与 Ni/单位（列3）按表头路径分别归属；证据列号不同 |
| 低于检出限 | normal，M-001 `<0.02` | rules-1 | 入库，publishable=true | qualifier=below-limit、value=null、limit=0.02；脚注全文留存但 0.02 不成为任何记录的 value |
| 数值零 | normal，M-002 `0` | rules-1 | 入库 | qualifier=measured、value=0，与空白严格区分 |
| 空白+未检 | normal，M-003 空白/未检 | rules-1 | 记录保留但不入库 | qualifier=not-tested、value=null、publishReason 说明未检无值 |
| 撤回 | normal，M-004 `0.12`/撤回 | rules-1 | 数值保留、不入库 | state=withdrawn、publishable=false |
| 非法跨度 | layout=badspan（colspan=0） | rules-1 | **整表阻断**，0 记录 | structuralErrors 含 invalid-span 与 grid-hole，带字符定位；不做浏览器式修复 |
| 缺关键表头 | layout=missing（单位→备注） | rules-1 | **整表阻断** | missingHeaders=[unit]，不发布缺单位记录 |
| 缺单位列降级 | layout=missing | rules-2 | 表不阻断：1 记录 + 3 隔离 | 单位列在 v2 可选；有值无单位的三行逐行隔离，未检行保留 |
| 行单位冲突 | layout=unit-conflict（mg/kg→毫升） | rules-1 | 1 行隔离，3 行正常 | 隔离原因注明“毫升”冲突且无换算定义，不默认按 mg/kg 入库 |
| 规则冲突 | test/fixtures/rules-conflict.json 双规则同表 | rules-test-conflict | **整表阻断** | conflictingRules 列出两条规则 id，不取第一条 |
| 离线规则重放 | 接收后关闭源站，rules-1 与 rules-2 分别重放 | 两版 | 两个独立结果文件 | extract 全程只读 var/captures；同哈希、同字节，记录各自带 ruleVersion；重复运行默认拒绝覆盖（退出码 2） |
| 字符解码 | encoding=windows-1252，紧凑表 `Ni (µg/g)` | rules-2 | 1 条记录入库 | encodingSource=header；µ 正确解码；内嵌单位 µg/g 经系数 1 换算为 mg/kg，chain 完整；byteRange 指向 0xB5 原始字节 |
| 字节防篡改 | 改写 raw.bin 后再加载 | 任意 | 拒绝处理 | loadCapture 重新计算 sha256 不匹配即抛错，提取层拿不到被篡改输入 |

## 人工复核入口

- 整表阻断：打开结果文件 `tables[].reason` 与 `structuralErrors`/`missingHeaders`/`conflictingRules`，
  按定位回到 `raw.bin` 的字节区间核对原文。
- 单行隔离：`quarantine[].reason` 说明歧义类型，`evidence` 给出具体单元格；修正数据或订正规则后，
  以新规则版本对同一 sourceHash 重放，旧结果保留不动。
