# 盼之标签复用与运行代号实施计划

目标：正常自动刷新复用已加载的盼之目录页，异常恢复才硬刷新；新执行能可靠取消页面中的旧 runner。

## 1. 固化后台标签生命周期

文件：

- `tests/extension/panzhiBackground.test.ts`
- `extensions/panzhi-auto-refresh/src/background.ts`

步骤：

1. 把“新领取会刷新复用标签”的测试改成“新领取不刷新也不导航”。
2. 补充恢复非验证码租约会刷新一次、验证码租约不刷新测试。
3. 先运行后台测试确认新领取测试失败。
4. 移除新领取时设置 `tabResetJobId` 的逻辑，保留恢复路径设置。
5. 重跑后台测试。

## 2. 建立 v3 运行代号协议

文件：

- `extensions/panzhi-auto-refresh/src/contracts.ts`
- `extensions/panzhi-auto-refresh/src/background.ts`
- `tests/extension/panzhiBackground.test.ts`

步骤：

1. 测试后台发送 `panzhi-run-v3`、模式和唯一 `runId`。
2. 给后台依赖增加 `createRunId()`，生产适配器使用 `crypto.randomUUID()`。
3. 更新结果解析以严格接受 `superseded`。
4. 运行后台单测和类型检查。

## 3. 让内容桥按代际取代旧 runner

文件：

- `extensions/panzhi-auto-refresh/src/content.ts`
- `tests/extension/panzhiContent.test.ts`

步骤：

1. 添加同 runId 返回同 Promise、不同 runId 启动新 runner 并让旧代失效的测试。
2. 把执行状态放入 `window.__panzhiAutoRefreshContentBridge`，注入新 listener 时保留共享代际状态。
3. 仅接受含非空 runId 的 `panzhi-run-v3`；保留 v2 验证检查协议。
4. 重跑内容桥测试。

## 4. 页面 runner 在安全边界检查取消

文件：

- `extensions/panzhi-auto-refresh/src/contracts.ts`
- `extensions/panzhi-auto-refresh/src/pageRunner.ts`
- `tests/extension/panzhiPageRunner.test.ts`

步骤：

1. 添加等待期间失效后返回 `superseded` 且不执行后续点击/加载的测试。
2. 增加 `isCurrentRun()` 依赖和统一的取消结果。
3. 在阶段、阻塞检查、延时前后、动作前后、采集循环和快照前检查。
4. 重跑 runner 测试。

## 5. 构建、回归与实机验收

文件：

- `extensions/panzhi-auto-refresh/README.md`
- `docs/panzhi-browser-snapshot-runbook.md`

步骤：

1. 更新运行方式和恢复语义文档。
2. 运行扩展相关测试、`pnpm typecheck`、`pnpm build:panzhi-extension`。
3. 运行 `pnpm vitest run --exclude '.worktrees/**'`。
4. 用户重新加载扩展后触发快速刷新，确认不重载标签、出现商品列表并提交快照。
5. 验证验证码暂停/自动继续和 Service Worker 重启恢复；若安装包仍旧，再移除扩展并从同一构建目录重新安装。
