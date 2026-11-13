GET /bulletin 返回 HTML。Content-Type charset 优先于 meta，演练编码为 utf-8 和 windows-1252。原文接收应保存实际字节、响应头、来源地址、摘要和接收时间。POST /_control 可选 layout：normal、badspan、missing、unit-conflict，以及 encoding。非法跨度 0 在该业务协议中不允许，不能依靠浏览器自动修复后忽略。

data/rules.json 是既有规则描述的初版，目标字段为 material、part、element、value、unit、qualifier、state；规则可以扩展但版本必须保留。<0.02 应为低于检出限，不是 0.02 的精确测量；空白、零和撤回不能混同。

records.json 包含 sourceHash、ruleVersion、records、quarantine 和 tables；每条 records 有 material、qualifier、evidence（表/行/列和原文定位），表级失败的 tables 项有 status=blocked 及 reason。规则新版本输出应独立命名，旧版仍可读取。
