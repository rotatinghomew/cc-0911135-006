# assay-table-extractor

检测公告原文查看与表格清点工具，保留多层表头及结果状态样例。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

GET /bulletin 返回 HTML。Content-Type charset 优先于 meta，演练编码为 utf-8 和 windows-1252。原文接收应保存实际字节、响应头、来源地址、摘要和接收时间。POST /_control 可选 layout：normal、badspan、missing、unit-conflict，以及 encoding。非法跨度 0 在该业务协议中不允许，不能依靠浏览器自动修复后忽略。

data/rules.json 是既有规则描述的初版，目标字段为 material、part、element、value、unit、qualifier、state；规则可以扩展但版本必须保留。<0.02 应为低于检出限，不是 0.02 的精确测量；空白、零和撤回不能混同。

records.json 包含 sourceHash、ruleVersion、records、quarantine 和 tables；每条 records 有 material、qualifier、evidence（表/行/列和原文定位），表级失败的 tables 项有 status=blocked 及 reason。规则新版本输出应独立命名，旧版仍可读取。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有客户端只进行单次协议查看；尚不提供自动采集与持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- records.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
