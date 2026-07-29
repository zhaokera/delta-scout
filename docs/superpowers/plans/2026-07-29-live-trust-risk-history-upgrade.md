# Live Trust, Risk Scoring and Listing History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 自动同步外部刷新，隔离异常低量来源快照，拆分账号价值与购买安全评分，并保存展示价格、字段和在售历史。

**Architecture:** 领域层提供纯异常判断、双评分和结构化差异；Repository 在单一
SQLite 事务里做异常决策、最终快照重算和可信历史发布；Express 暴露来源异常与账号
历史；React 用后台状态监视器接管外部刷新，并在详情中呈现双评分和历史。

**Tech Stack:** TypeScript 7、React 19、Express 5、Node `node:sqlite`、Vite 8、
Vitest 4、Testing Library。

---

### Task 1: 领域层异常判断

**Files:**

- Create: `src/domain/snapshotAnomaly.ts`
- Create: `tests/domain/snapshotAnomaly.test.ts`

- [ ] 写失败测试：正常波动、50% 临界值、10 条/2 页绝对阈值、首次 suspect、
  相近低量二次确认、恢复 clear、不同低量重置确认、partial 不进入判断。
- [ ] 运行 `pnpm vitest run tests/domain/snapshotAnomaly.test.ts` 确认 RED。
- [ ] 实现纯类型、阈值常量与 `evaluateSnapshotAnomaly`。
- [ ] 运行测试确认 GREEN。

### Task 2: 价值分、安全分与风险等级

**Files:**

- Modify: `src/domain/listing.ts`
- Modify: `src/domain/score.ts`
- Modify: `src/server/storedListing.ts`
- Modify: `tests/domain/listingFactory.ts`
- Modify: `tests/domain/listing.test.ts`
- Modify: `tests/domain/score.test.ts`
- Modify: 所有使用旧 `Score` 字面量的测试

- [ ] 先把评分测试改成新契约：价值 100、安全 100、数据质量 100、55/35/10
  综合公式、三类覆盖度、四类风险、未知不加安全分。
- [ ] 运行评分与 schema 测试确认 RED。
- [ ] 修改 `ScoreSchema`、测试工厂、兼容读取与评分实现。
- [ ] 用 `rg "parts.*safety|skinValue" src tests` 清除旧契约。
- [ ] 运行领域测试和 `pnpm typecheck` 确认 GREEN。
- [ ] Commit: `feat: split value and purchase risk scoring`

### Task 3: SQLite 异常状态与可信发布

**Files:**

- Modify: `src/server/db.ts`
- Modify: `src/server/repository.ts`
- Modify: `src/server/collector/coordinator.ts`
- Modify: `tests/server/repository.test.ts`
- Modify: `tests/server/coordinator.test.ts`

- [ ] Repository 失败测试覆盖：
  - 首次 44→10 隔离并保留 44 条可信快照；
  - 第二次 9–11 条接受并清除 guard；
  - 恢复到正常量直接接受；
  - partial/blocked 不增加确认次数；
  - 扫描历史记录原始观测量及 `published=false`。
- [ ] 迁移测试覆盖旧数据库幂等新增 guard 表与 result 列。
- [ ] 运行相关测试确认 RED。
- [ ] 增加 `source_anomaly_guards` 和 `scan_source_results` 迁移。
- [ ] 将异常决策和最终快照组装放进 `commitScanRefresh` 事务；返回包含
  `state/publishedSources/suspectSources` 的提交结果，协调器与 tracker 使用实际
  终态。
- [ ] 统一对最终有效快照执行重复标记与双评分，隔离来源不丢候选分数。
- [ ] 运行 Repository、coordinator 和 typecheck 确认 GREEN。
- [ ] Commit: `feat: quarantine anomalous source snapshots`

### Task 4: 结构化观察、字段差异和下架墓碑

**Files:**

- Create: `src/domain/listingHistory.ts`
- Create: `tests/domain/listingHistory.test.ts`
- Modify: `src/server/db.ts`
- Modify: `src/server/repository.ts`
- Modify: `tests/server/repository.test.ts`

- [ ] 领域失败测试覆盖规范化快照、价格变化、数组稳定比较、多字段变化与中文显示值。
- [ ] Repository 失败测试覆盖 active 观察、新上架、字段变化、可信 success 缺失
  生成 removed、partial/anomaly/blocked 不生成 removed、removed 后重新出现。
- [ ] 运行测试确认 RED。
- [ ] 扩展 `listing_observations` 幂等迁移字段。
- [ ] 实现 `buildListingHistorySnapshot`、`diffListingSnapshots` 和事务写入。
- [ ] 实现 `getListingHistory(key, limit)`，包含当前在售状态和已下架查询。
- [ ] 运行领域与 Repository 测试确认 GREEN。
- [ ] Commit: `feat: persist listing price and field history`

### Task 5: API 契约

**Files:**

- Modify: `src/server/repository.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api.ts`
- Modify: `tests/server/api.test.ts`

- [ ] API 失败测试覆盖来源 anomaly 对象、历史 limit 校验、当前账号历史、已下架
  账号历史和未知 key 404。
- [ ] 运行 `pnpm vitest run tests/server/api.test.ts` 确认 RED。
- [ ] 增加 `/api/listings/:key/history` 并扩展来源响应。
- [ ] 增加客户端 `ListingHistoryView` 与 `getListingHistory`。
- [ ] 运行 API 测试和 typecheck 确认 GREEN。
- [ ] Commit: `feat: expose trust guards and listing history`

### Task 6: 外部刷新自动同步

**Files:**

- Modify: `src/client/App.tsx`
- Modify: `src/client/api.ts`
- Modify: `tests/client/App.test.tsx`

- [ ] React 失败测试覆盖：
  - 初始空闲后后台出现新 running run，页面自动进入刷新态；
  - 外部 run 结束后自动重载 sources/listings；
  - 相同 `runId/lastSnapshotAt` 不重复重载；
  - visibility/focus 立即检查；
  - BroadcastChannel 消息触发检查；
  - 自动重载保留 view、pool mode、filters 和仍存在的选择。
- [ ] 运行 App 测试确认 RED。
- [ ] 实现独立 5 秒可见状态监视器、焦点/visibility 监听、可选
  `BroadcastChannel` 与去重 refs。
- [ ] 让主动刷新和外部刷新共用同一终态加载路径。
- [ ] 运行 App 测试和 typecheck 确认 GREEN。
- [ ] Commit: `feat: auto-sync external refresh runs`

### Task 7: 双评分、异常与历史界面

**Files:**

- Modify: `src/client/App.tsx`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `src/client/components/DetailDrawer.tsx`
- Modify: `src/client/components/SourceStrip.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client/ListingDetail.test.tsx`
- Modify: `tests/client/ListingTable.test.tsx`
- Modify: `tests/client/App.test.tsx`

- [ ] 组件失败测试覆盖价值分、安全分、风险等级、覆盖度、在售状态、涨跌、价格
  时间线、字段变化、历史局部加载错误和来源异常提示。
- [ ] 运行组件测试确认 RED。
- [ ] App 在选择候选时并行加载详情和历史，单项失败互不清空。
- [ ] 实现桌面与窄屏历史区、风险标签、变化卡和异常来源说明。
- [ ] 校验键盘/抽屉可访问性与窄屏布局。
- [ ] 运行客户端测试和 typecheck 确认 GREEN。
- [ ] Commit: `feat: show risk and listing change history`

### Task 8: 文档、全量验证与真实扫描

**Files:**

- Modify: `README.md`
- Modify: `scripts/verify-acceptance.mjs`

- [ ] 更新 README：自动同步、异常保护、双评分和历史 API/界面。
- [ ] 扩展验收脚本，断言分数新契约、来源异常字段与历史响应。
- [ ] 运行 `pnpm test`。
- [ ] 运行 `pnpm typecheck`。
- [ ] 运行 `pnpm build`。
- [ ] 重启 `screen` 中的 4311/4310 服务，确认使用当前 worktree 和验收数据库。
- [ ] 触发三平台真实刷新，记录每个平台页数、观测量、候选数、异常状态。
- [ ] 运行 `node scripts/verify-acceptance.mjs`。
- [ ] 在 Codex 浏览器检查来源卡、排名、双评分、价格历史和变化。
- [ ] 用后台 API 再启动一次刷新，验证已打开页面能自动接管并更新。

### Task 9: 完成审计、提交和推送

- [ ] 逐项对照设计文档的 9 条完成标准收集证据。
- [ ] `git diff --check`、`git status --short`。
- [ ] 提交剩余文档或验收调整。
- [ ] `git push origin master`。
- [ ] 确认 `git status --short --branch` 为
  `master...origin/master` 且无未提交变更。
