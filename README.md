# assay-table-extractor

检测公告的原文接收、表格结构解析、版本化规则提取与结果发布流水线。
不再把单张页面当作永久模板：版式知识全部沉淀在带版本的规则包里，结构不可信时阻断发布。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。

```bash
npm run build       # 全部模块语法检查
npm test            # 协议、结构解析与八类回归情景
npm run demo        # 在临时本地服务上真实请求并打印清点结果
npm start           # 启动演练源站（只监听本机，PORT 可指定端口）
npm run probe -- http://127.0.0.1:端口   # 既有查看命令：清点表格数与编码
```

采集与发布命令（默认工作目录 `var/`，已在 .gitignore 中忽略）：

```bash
# 1) 接收原文：保存原始字节、响应头、来源、sha256、接收时间与解码依据
npm run capture -- http://127.0.0.1:端口/bulletin [--var var]

# 2) 离线提取：只读取已保存字节，不请求站点；按规则版本独立命名结果
npm run extract -- <sourceHash> --rule rules-1 [--var var] [--out 文件] [--force]

# 或一步完成（内部仍是“先接收留痕、后离线提取”两个阶段）
npm run pipeline -- http://127.0.0.1:端口/bulletin --rule rules-2

# 结果不变量校验（既有命令，保留）
npm run verify -- var/results/<sourceHash>.rules-1.records.json
```

`extract` 默认拒绝覆盖既有结果文件（退出码 2）；规则订正应产生 `<hash>.<新版本>.records.json` 独立文件，确需重写须显式 `--force`。

## 流水线与模块边界

| 阶段 | 模块 | 职责 | 不允许做的事 |
|---|---|---|---|
| 原文接收 | `lib/capture.mjs` | sha256 内容寻址保存 `raw.bin`、manifest、每次接收的 receipt（URL、状态码、响应头、时间、编码判定） | 不解析表格；同哈希异字节直接报错 |
| 字符解码 | `lib/encoding.mjs` | header charset > meta charset > utf-8；构建字符偏移到字节偏移的映射 | 不丢弃原始字节 |
| 结构解析 | `lib/grid.mjs` | parse5 定位 + rowspan/colspan 展开为矩形网格，生成每列表头路径 | 跨度 0、网格重叠/空洞不做浏览器式修复，转为表级错误 |
| 规则应用 | `lib/extract.mjs` + `lib/rules.mjs` | 表头映射、字段归属、语义判定、单位换算、证据与转换链 | 不发起网络请求；命中互斥规则不取第一条 |
| 发布 | `tools/extract.mjs` | 不变量校验后写 `records.json` | 校验不过或文件已存在时不写盘 |

`src/client.mjs` 的 `inspect` 查看能力与 `probe`、`demo`、`start` 命令保持不变。

## 版本化规则

规则包位于 `data/rules/`，文件名即版本（`rules-1.json`、`rules-2.json`），永久保留、只增不改。
每条表格规则显式声明适用范围：

- `match.tableId`：表格定位（按 DOM id；测试支持 `table-index:n`）；
- `headers.<field>.paths`：表头层级路径（如 `["Ni","结果"]`），`required` 决定缺失时阻断还是降级；
- `unit.accept`：接受单位与换算系数表，目标单位必须以系数 1 在表内；系数非法或单位重复在加载时即拒绝；
- `stateMap`：页面原文状态到标准状态的映射；
- `footnotes.verifyBelowLimit`：是否强制核验“低于检出限”单元格的脚注。

版本差异（规则订正不改写旧版结果）：

- `rules-1`：仅 `id=assays` 两层表头；单位列必填且只接受 mg/kg；脚注只留存。
- `rules-2`（supersedes rules-1）：新增 Accession 紧凑表头、表头括号内嵌单位、µg/g→mg/kg（系数 1）、状态列缺省按有效、低于检出限强制脚注核验；单位列缺失从整表阻断降级为逐行隔离。

同一张表命中同一规则包内多条规则时，整表 `blocked`，结果中列出 `conflictingRules`，不任取第一条。

## 阻断与隔离口径

- **整表阻断（tables[].status=blocked，零记录）**：非法跨度/网格结构错误；规则要求的关键表头无法解析；同一表命中互斥规则；没有任何规则适用。
- **单行隔离（quarantine）**：单位冲突且无换算定义、单位无法归属、数值无法解析、空白结果但状态不是“未检”、未知状态、脚注核验失败、材料号缺失。每条隔离项带原因与单元格证据。
- **测量语义四分离**：`<0.02` → `below-limit`（value=null、limit=0.02，脚注只核验不作为检测值）；`0` → 数值零；空白+未检 → `not-tested`（value=null）；撤回 → 数值保留但 `publishable=false`。

## 追溯模型

每条记录的 `evidence` 给出表索引/表 id、网格行列、字符区间与**原始字节区间**、单元格原文和脚注引用；
`conversion.chain` 记录每一步换算的来源单位、目标单位、系数与规则条目；
顶层结果保留 `sourceHash`、`ruleVersion`、解码依据（encoding + 判定来源）、脚注全文与每张表的处置结论。
重提取只经过 `loadCapture` 读取保存字节，哈希不匹配即拒绝，整个过程无网络调用。

## 数据与演练边界

GET /bulletin 返回 HTML，POST /_control 可切换 layout（normal、badspan、missing、unit-conflict）与 encoding（utf-8、windows-1252）。
非法跨度 0 在业务协议中不允许。完整字段见 `docs/protocol.md`，回归情景与发布结论见 `docs/scenarios.md`。
业务编号均为合成值，服务无外网依赖；`/_audit` 与 `/_control` 仅用于演练，不属于业务采集入口。
