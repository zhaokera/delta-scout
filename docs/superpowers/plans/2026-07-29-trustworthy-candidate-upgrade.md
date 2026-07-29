# 候选可信度、皮肤价值与刷新体验升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留三平台完整分页和默认均衡候选池的前提下，加入皮肤价值评分、全局 Top 30、扫描历史与稳定性、异步刷新进度、失败旧快照回退、完整筛选和移动端详情抽屉。

**Architecture:** 领域层负责可复用的百分位、评分、候选池、筛选、证据片段和物质指纹；Repository 用一次 SQLite 事务发布新快照、来源结果和观察历史；协调器通过回调发布无敏感信息的进度事件；Express 用内存状态机启动后台刷新；React 始终保留最后一次成功加载的数据，并按刷新终态决定重载或显示旧快照警告。

**Tech Stack:** TypeScript 7、React 19、Express 5、Node `node:sqlite`、Vite 8、Vitest 4、Testing Library。

---

## File map

**Create**

- `src/domain/percentile.ts` — 中位秩百分位。
- `src/domain/listingFingerprint.ts` — 物质字段规范化与 SHA-256。
- `src/domain/listingFilters.ts` — 高级筛选和完整度判断。
- `src/domain/evidenceExcerpt.ts` — M7 短证据片段。
- `src/server/refreshTracker.ts` — 刷新状态机。
- `src/server/storedListing.ts` — 新旧 SQLite payload 的唯一兼容解析入口。
- `src/client/components/RefreshProgress.tsx` — 进度和旧快照警告。
- `src/client/components/DetailDrawer.tsx` — 窄屏对话框。
- `src/client/components/PoolModeToggle.tsx` — 均衡/全局切换。
- `tests/domain/percentile.test.ts`
- `tests/domain/listingFingerprint.test.ts`
- `tests/domain/listingFilters.test.ts`
- `tests/domain/evidenceExcerpt.test.ts`
- `tests/server/refreshTracker.test.ts`
- `tests/server/storedListing.test.ts`
- `scripts/verify-acceptance.mjs` — 对运行中本地 API 做只读候选契约断言。

**Modify**

- `src/domain/listing.ts` — 新分数结构和稳定性字段。
- `src/domain/score.ts` — 新权重和百分位评分。
- `src/domain/candidatePool.ts` — 全局 Top 30。
- `src/server/db.ts` — 历史表、索引、旧库基线和中断恢复。
- `src/server/repository.ts` — 扫描生命周期、稳定性和历史查询。
- `src/server/collector/coordinator.ts` — runId、进度回调、轮次终态。
- `src/server/app.ts` — mode/history/progress API 和后台刷新。
- `src/server/index.ts` — tracker 注入。
- `src/client/api.ts` — 新 API 类型和调用。
- `src/client/App.tsx` — mode、轮询、失败保留旧数据和抽屉。
- `src/client/components/FilterBar.tsx` — 新筛选与皮肤排序。
- `src/client/components/ListingTable.tsx` — mode 文案、稳定徽标。
- `src/client/components/ListingDetail.tsx` — 新分数、证据片段、关闭入口。
- `src/client/components/SourceStrip.tsx` — 紧凑来源诊断。
- `src/client/styles.css` — 进度、mode、筛选、徽标、移动抽屉。
- `tests/domain/listing.test.ts`
- `tests/domain/listingFactory.ts`
- `tests/domain/score.test.ts`
- `tests/domain/candidatePool.test.ts`
- `tests/server/repository.test.ts`
- `tests/server/coordinator.test.ts`
- `tests/server/api.test.ts`
- `tests/client/App.test.tsx`
- `tests/client/ListingTable.test.tsx`
- `README.md`

### Task 1: 新评分模型与稳健百分位

**Files:**

- Create: `src/domain/percentile.ts`
- Create: `tests/domain/percentile.test.ts`
- Modify: `src/domain/listing.ts`
- Modify: `src/domain/score.ts`
- Modify: `src/server/collector/coordinator.ts`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `tests/domain/score.test.ts`
- Modify: `tests/domain/listing.test.ts`
- Modify: `tests/domain/listingFactory.ts`
- Modify: `tests/domain/candidatePool.test.ts`
- Modify: `tests/server/api.test.ts`
- Modify: `tests/server/coordinator.test.ts`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: 写百分位失败测试**

覆盖 `[10, 20, 20, 40] -> [0, 0.5, 0.5, 1]`、单值 `0.5`、null 不入样本、相同值相同分位。

```ts
expect(buildMidrankPercentiles([10, 20, 20, 40])).toEqual(
  new Map([[10, 0], [20, 0.5], [40, 1]])
);
expect(buildMidrankPercentiles([7])).toEqual(new Map([[7, 0.5]]));
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run tests/domain/percentile.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现中位秩百分位**

```ts
export function buildMidrankPercentiles(
  values: Array<number | null>
): Map<number, number> {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  const result = new Map<number, number>();
  if (sorted.length === 1) return new Map([[sorted[0], 0.5]]);
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[start]) end += 1;
    result.set(sorted[start], ((start + end) / 2) / (sorted.length - 1));
    start = end + 1;
  }
  return result;
}
```

- [ ] **Step 4: 运行百分位测试确认 GREEN**

Run: `pnpm vitest run tests/domain/percentile.test.ts`

Expected: PASS。

- [ ] **Step 5: 先修改评分测试为新契约并确认 RED**

测试：

- 安全 30、皮肤 30、价格 20、资产 10、置信度 10；
- S/A/B/C 分别贡献 14/11/8/5；
- 红皮最多计 4 个、每个 2.5；
- 巨浪 owned 加 6，unknown/absent 不加；
- `m7PrismQuality=null` 不获得 M7 品质分；
- `secondRealNameAvailable=false` 和 `recoveryCoverage=false` 不因字段已知加安全分；
- 极端资产只影响排名，不按绝对距离压扁中间项；
- `score.reasons` 明确列出 M7 品质、已识别红皮数量和巨浪状态；
- null 品质原因包含“极品品质待核验”。

Run: `pnpm vitest run tests/domain/score.test.ts tests/domain/listing.test.ts`

Expected: FAIL，旧 ScoreSchema 和旧权重不匹配。

- [ ] **Step 6: 修改 schema、fixture 和评分实现**

`ScoreSchema.parts` 改为：

```ts
parts: z.object({
  safety: z.number().min(0).max(30),
  skinValue: z.number().min(0).max(30),
  price: z.number().min(0).max(20),
  assets: z.number().min(0).max(10),
  confidence: z.number().min(0).max(10)
})
```

`ListingSchema` 增加：

```ts
scanStability: z.enum(["unknown", "new", "changed", "stable"])
  .default("unknown"),
consecutiveUnchangedScans: z.number().int().nonnegative().default(0)
```

在 `tests/domain/listingFactory.ts` 导出唯一测试分数构造器：

```ts
export function makeScore(total: number, parts: Partial<Score["parts"]> = {}): Score {
  return {
    total,
    parts: {
      safety: 0, skinValue: 0, price: 0, assets: 0, confidence: 0, ...parts
    },
    reasons: []
  };
}
```

Task 1 同步替换 `rg 'parts:\\s*\\{' tests` 找到的所有旧 Score 字面量，包括
candidatePool、API、coordinator 和 App 测试，不能把它们留到后续 Task，否则本
Task 的 typecheck 会失败。

由于 Zod default 只帮助解析输入，不会让 TypeScript 输出字段变成可选，
`buildListing` 的生产对象和 `makeListing` 测试 fixture 都必须显式加入：

```ts
scanStability: "unknown",
consecutiveUnchangedScans: 0
```

`scoreOne` 使用：

```ts
const qualityPoints = { S: 14, A: 11, B: 8, C: 5 } as const;
const safety =
  (listing.secondRealNameAvailable === true ? 12 : 0) +
  (listing.recoveryCoverage === true ? 8 : 0) +
  verificationAgePoints(listing.verificationAt, now);
const skinValue =
  (listing.m7PrismQuality ? qualityPoints[listing.m7PrismQuality] : 0) +
  Math.min(listing.redSkins.length, 4) * 2.5 +
  (listing.julangStatus === "owned" ? 6 : 0);
```

价格使用反向分位乘 20；资产使用总资产分位乘 6、哈夫币分位乘 3、任一已知加 1；
置信度乘 10。保留现有确定性 comparator。

- [ ] **Step 7: 在详情中突出 null 品质复核提示**

当 `m7PrismStatus === "peak" && m7PrismQuality === null`，在 M7 证据块增加
`role="alert"` 文案“极品品质待核验”，不只依赖分数原因。补充 ListingDetail 的
渲染测试。

- [ ] **Step 8: 运行领域和相关组件测试、类型检查**

Run:

```bash
pnpm vitest run tests/domain/percentile.test.ts tests/domain/score.test.ts \
  tests/domain/listing.test.ts tests/client/App.test.tsx
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/domain/percentile.ts src/domain/listing.ts src/domain/score.ts \
  src/server/collector/coordinator.ts src/client/components/ListingDetail.tsx \
  tests/domain/percentile.test.ts tests/domain/score.test.ts \
  tests/domain/listing.test.ts tests/domain/listingFactory.ts \
  tests/domain/candidatePool.test.ts tests/server/api.test.ts \
  tests/server/coordinator.test.ts tests/client/App.test.tsx
git commit -m "feat: score candidate skin value robustly"
```

### Task 2: 双候选池与 API mode

**Files:**

- Modify: `src/domain/candidatePool.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api.ts`
- Modify: `tests/domain/candidatePool.test.ts`
- Modify: `tests/server/api.test.ts`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: 写全局池失败测试**

构造交易猫 35 条高分、其它平台低分，断言全局池只取真实前 30；过滤 rejected、
unscored 和重复 key。

Run: `pnpm vitest run tests/domain/candidatePool.test.ts`

Expected: FAIL，`selectGlobalCandidatePool` 不存在。

- [ ] **Step 2: 实现全局池**

```ts
export function selectGlobalCandidatePool(
  listings: Listing[],
  limit = 30
): Listing[] {
  const seen = new Set<string>();
  return listings
    .filter((item) => item.eligibility === "eligible" && item.score !== null)
    .sort(compareRecommendations)
    .filter((item) => !seen.has(item.key) && seen.add(item.key))
    .slice(0, limit);
}
```

Run: `pnpm vitest run tests/domain/candidatePool.test.ts`

Expected: PASS。

- [ ] **Step 3: 写 API mode 失败测试**

覆盖：

- `?mode=global`、`?status=eligible&mode=global` 返回全局 Top 30；
- 默认仍为 balanced；
- `view=all&mode=global`、`status=rejected&mode=global` 返回
  `invalid_listing_view`；
- `view=all&mode=balanced`、`status=rejected&mode=balanced` 同样非法；
- `mode=surprise` 返回 `invalid_listing_view`；
- `/api/sources?mode=global` 的 `candidateCount` 与 global 一致，同时返回两个计数；
- 非法 source mode 返回 `invalid_pool_mode`。

Run: `pnpm vitest run tests/server/api.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现参数解析和来源派生计数**

增加：

```ts
const PoolModeSchema = z.enum(["balanced", "global"]);
type PoolMode = z.infer<typeof PoolModeSchema>;
```

`readCurrentListingSnapshot` 同时计算 `balancedPool`、`globalPool`；
`derivedSourceStatuses(snapshot, mode)` 返回：

```ts
{
  candidateCount: mode === "balanced" ? balancedCount : globalCount,
  balancedCandidateCount: balancedCount,
  globalCandidateCount: globalCount
}
```

参数先解析默认 view/status，再校验 mode。

- [ ] **Step 5: 更新客户端 API 类型并测试 URL**

```ts
export type PoolMode = "balanced" | "global";
getSources(mode?: PoolMode): Promise<SourceStatusView[]>;
getListings(view: ListingView, mode?: PoolMode): Promise<Listing[]>;
```

两个实现参数都默认 `"balanced"`，所以 Task 2 的现有 App 和测试调用继续可编译；
Task 7 再让 App 显式传当前 mode。只有 pool URL 带 mode；其它视图忽略本地保存的
mode，不把非法组合发给服务端。

Run:

```bash
pnpm vitest run tests/server/api.test.ts tests/client/App.test.tsx
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/domain/candidatePool.ts src/server/app.ts src/client/api.ts \
  tests/domain/candidatePool.test.ts tests/server/api.test.ts tests/client/App.test.tsx
git commit -m "feat: add global top thirty candidate mode"
```

### Task 3: 物质指纹、旧分数兼容与扫描历史数据库

**Files:**

- Create: `src/domain/listingFingerprint.ts`
- Create: `src/server/storedListing.ts`
- Create: `tests/domain/listingFingerprint.test.ts`
- Create: `tests/server/storedListing.test.ts`
- Modify: `src/server/db.ts`
- Modify: `src/server/repository.ts`
- Modify: `tests/server/repository.test.ts`

- [ ] **Step 1: 写指纹失败测试**

断言数组顺序、重复值、标题空白、capturedAt 和 score 不改变指纹；价格、M7 品质、
红皮、巨浪、安全字段、资产、置信度或 warning 改变指纹。

Run: `pnpm vitest run tests/domain/listingFingerprint.test.ts`

Expected: FAIL。

- [ ] **Step 2: 实现稳定 JSON 和 SHA-256**

```ts
export function listingMaterialHash(listing: Listing): string {
  const material = {
    priceCny: listing.priceCny,
    eligibility: listing.eligibility,
    m7PrismStatus: listing.m7PrismStatus,
    m7PrismQuality: listing.m7PrismQuality,
    redSkins: [...new Set(listing.redSkins)].sort(),
    redSkinCount: listing.redSkinCount,
    julangStatus: listing.julangStatus,
    julangQuality: listing.julangQuality,
    totalAssetsM: listing.totalAssetsM,
    hafCoins: listing.hafCoins,
    secondRealNameAvailable: listing.secondRealNameAvailable,
    recoveryCoverage: listing.recoveryCoverage,
    verificationAt: listing.verificationAt,
    banNotes: [...new Set(listing.banNotes)].sort(),
    confidence: listing.confidence,
    parseWarnings: [...new Set(listing.parseWarnings)].sort()
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
```

Run: `pnpm vitest run tests/domain/listingFingerprint.test.ts`

Expected: PASS。

- [ ] **Step 3: 写旧 payload 兼容解析 RED 测试**

测试 `parseStoredListing(payload)` 对以下旧数据统一规范化：

- 缺少 M7 品质 => null；
- 缺少稳定字段 => unknown/0；
- 旧 score parts => score=null；
- 其它核心字段损坏仍抛错。

Run: `pnpm vitest run tests/server/storedListing.test.ts`

Expected: FAIL。

- [ ] **Step 4: 先实现唯一兼容解析入口**

`src/server/storedListing.ts` 导出 `parseStoredListing`，Repository 读取和
`createDatabase` 基线迁移都只能调用该函数，禁止各自解析 raw JSON。这样基线
hash 和后续读取使用相同的 M7/null/stability 默认值。

Run: `pnpm vitest run tests/server/storedListing.test.ts`

Expected: PASS。

- [ ] **Step 5: 写数据库迁移、历史和稳定性 RED 测试**

覆盖：

- 四表/索引幂等创建（三张历史表加现有表）；
- 旧 success 快照产生一条隐藏 baseline，partial 来源不产生；
- baseline 重开数据库不重复；
- 遗留 running run 被标为 failed/进程中断；
- 旧 score parts 没有 skinValue 时读取为 `score=null`；
- 正常历史只保留 50 轮，baseline 保留；
- `getScanHistory(limit)` 排除 baseline，返回双候选计数；
- `getRefreshSnapshot().latestRun` 排除 baseline，隐藏基线不能 hydrate tracker；
- 空成功快照仍返回非空 `lastSnapshotAt`；
- success 同 hash 从 1 变 stable/2；
- success 改 hash => changed/1；
- 上一次完整 success 缺席、本轮重现 => new/1；
- partial observation => unknown/0，既不推进也不重置 success 链；
- baseline 同/异 hash => stable/2 或 changed/1；
- blocked/failed 来源保留旧 payload 的 stability 和次数；
- 三来源均 blocked/failed 的 finalize 事务写三条 observed=0 的 source results，
  更新三个 `source_status`，标 run failed，但不替换 listings。

Run: `pnpm vitest run tests/server/repository.test.ts`

Expected: FAIL。

- [ ] **Step 6: 实现幂等 schema 与旧库基线**

在 `createDatabase` 创建带完整 CHECK、PK、FK 和索引的：

```sql
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('running','success','partial','failed')),
  error TEXT,
  is_baseline INTEGER NOT NULL DEFAULT 0 CHECK(is_baseline IN (0,1))
);
CREATE TABLE IF NOT EXISTS scan_source_results (
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('jiaoyimao','panzhi','pxb7')),
  state TEXT NOT NULL CHECK(state IN ('success','partial','blocked','failed')),
  pages_scanned INTEGER NOT NULL CHECK(pages_scanned >= 0),
  observed_item_count INTEGER NOT NULL CHECK(observed_item_count >= 0),
  eligible_count INTEGER NOT NULL CHECK(eligible_count >= 0),
  balanced_candidate_count INTEGER NOT NULL CHECK(balanced_candidate_count >= 0),
  global_candidate_count INTEGER NOT NULL CHECK(global_candidate_count >= 0),
  stop_reason TEXT,
  error TEXT,
  PRIMARY KEY(run_id, source),
  FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS listing_observations (
  run_id INTEGER NOT NULL,
  listing_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('jiaoyimao','panzhi','pxb7')),
  observed_at TEXT NOT NULL,
  eligibility TEXT NOT NULL
    CHECK(eligibility IN ('eligible','needs_verification','rejected')),
  material_hash TEXT NOT NULL,
  stability TEXT NOT NULL CHECK(stability IN ('unknown','new','changed','stable')),
  consecutive_unchanged_scans INTEGER NOT NULL
    CHECK(consecutive_unchanged_scans >= 0),
  PRIMARY KEY(run_id, listing_key),
  FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS listing_observations_listing_run_idx
  ON listing_observations (listing_key, run_id DESC);
CREATE INDEX IF NOT EXISTS listing_observations_source_run_idx
  ON listing_observations (source, run_id DESC);
```

迁移末尾用一个事务，并只使用 Step 4 已通过测试的 `parseStoredListing` 后再计算 hash：

1. 将遗留 running 标 failed；
2. 若没有 run 且存在旧 success listing，插入隐藏 baseline 和 hash；
3. 不修改当前 listings。

- [ ] **Step 7: 增加扫描生命周期 Repository API**

```ts
startScan(startedAt: Date): number;
failScan(runId: number, error: string, finishedAt: Date): void;
finalizeFailedScan(runId: number, statusUpdates: SourceRefreshStatusUpdate[],
  error: string, finishedAt: Date): void;
commitScanRefresh(runId: number, listings: Listing[],
  statusUpdates: SourceRefreshStatusUpdate[], finishedAt: Date): ScanState;
getScanHistory(limit: number): ScanHistoryRun[];
getRefreshSnapshot(): { latestRun: ScanRun | null; lastSnapshotAt: string | null };
```

新增 `commitScanRefresh`，现有两参数 `commitRefresh` 暂时保留给尚未切换的协调器，
因此本 Task 提交仍可编译。`commitScanRefresh` 在现有事务内：

1. 为 success 来源计算与上次 success/baseline 的稳定性；
2. partial 新数据标 unknown/0，失败来源保留旧 payload 稳定性；
3. 更新 listings 和 source_status；
4. 写 source results、observations 和 run 终态；
5. 删除第 51 条以后非 baseline run。

`finalizeFailedScan` 在单独事务中只更新 run、source results 和 source_status，不执行
`DELETE FROM listings`；每个失败来源的 pages/items/eligible/balanced/global 均为
0，错误和 blocked/failed state 来自本轮 outcome。`failScan` 只用于尚未取得完整
outcomes 的全局异常。

- [ ] **Step 8: 运行 Repository 测试和类型检查**

Run:

```bash
pnpm vitest run tests/domain/listingFingerprint.test.ts \
  tests/server/storedListing.test.ts tests/server/repository.test.ts
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/domain/listingFingerprint.ts src/server/storedListing.ts \
  src/server/db.ts src/server/repository.ts \
  tests/domain/listingFingerprint.test.ts tests/server/storedListing.test.ts \
  tests/server/repository.test.ts
git commit -m "feat: persist candidate scan history"
```

### Task 4: 协调器进度与轮次终态

**Files:**

- Modify: `src/server/collector/coordinator.ts`
- Modify: `src/server/repository.ts`
- Modify: `tests/server/coordinator.test.ts`

- [ ] **Step 1: 写协调器失败测试**

覆盖事件 `type` 顺序：

```text
source_start -> list_page -> detail_progress -> source_complete
-> score -> commit -> complete
```

并断言：

- 三来源 success => success；
- 任一 partial/failed 且至少一个 fresh => partial；
- 无 fresh => failed；
- commit 抛错调用 `failScan` 且不报告 success；
- progress 不包含 Cookie、Token、URL 或证据正文。

Run: `pnpm vitest run tests/server/coordinator.test.ts`

Expected: FAIL。

- [ ] **Step 2: 增加进度类型与 callback**

```ts
export type RefreshProgressEvent =
  | { type: "source_start"; phase: "discover"; source: SourceId;
      page: 0; summaries: 0; details: 0; message: string }
  | { type: "list_page"; phase: "list"; source: SourceId;
      page: number; summaries: number; details: number; message: string }
  | { type: "detail_progress"; phase: "detail"; source: SourceId;
      page: number; summaries: number; details: number; message: string }
  | { type: "source_complete"; phase: "list"; source: SourceId;
      page: number; summaries: number; details: number; sourceState: SourceState;
      message: string }
  | { type: "score" | "commit"; phase: "score" | "commit"; source: null;
      page: number; summaries: number; details: number; message: string }
  | { type: "complete"; phase: null; source: null;
      page: number; summaries: number; details: number; roundState: ScanState;
      message: string };
```

用 overload 保持 Task 4 的现有 Express `RefreshCoordinator` 结构类型可编译：

```ts
refreshAll(): Promise<void>;
refreshAll(runId: number,
  onProgress?: (event: RefreshProgressEvent) => void): Promise<ScanState>;
```

- 有 runId：调用 `commitScanRefresh` 并返回 round state；
- 无 runId：调用旧 `commitRefresh`，完成后不返回值；
- Task 5 的新 POST 总是提供 runId，之后生产路径不再走兼容分支。

每页解析完成和每个详情完成后发布计数；字符串只用固定中文消息。

- [ ] **Step 3: 将 runId 传给原子提交**

有 runId 且无 fresh 时不发布新 listings，调用
`finalizeFailedScan(runId, outcomes.map(statusUpdate), ...)`，持久化三个来源本轮
blocked/failed 状态后返回 failed；有 fresh 时仍清除失败来源旧分数和重复标记，
随后 `commitScanRefresh(runId, ...)` 返回 round state。无 runId 的兼容分支保持
现有快照行为，仅供 Task 5 前的测试/旧调用。

- [ ] **Step 4: 运行协调器、回归测试和类型检查**

Run:

```bash
pnpm vitest run tests/server/coordinator.test.ts tests/server/adapters.test.ts \
  tests/server/pxb7-collection.test.ts
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/collector/coordinator.ts src/server/repository.ts \
  tests/server/coordinator.test.ts
git commit -m "feat: report collector refresh progress"
```

### Task 5: 刷新状态机、异步 API 与历史 API

**Files:**

- Create: `src/server/refreshTracker.ts`
- Create: `tests/server/refreshTracker.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Modify: `src/client/api.ts`
- Modify: `tests/server/api.test.ts`
- Modify: `tests/server/health.test.ts`

- [ ] **Step 1: 写 RefreshTracker RED 测试**

覆盖 idle 初始化、从 Repository 最新终态 hydrate、同 runId running 更新、终态不可
回退、下一 runId 可开始、进度字段默认值和 lastSnapshotAt。

Run: `pnpm vitest run tests/server/refreshTracker.test.ts`

Expected: FAIL。

- [ ] **Step 2: 实现状态机**

```ts
export class RefreshTracker {
  start(runId: number, startedAt: Date, lastSnapshotAt: string | null): void;
  update(runId: number, event: RefreshProgressEvent): void;
  finish(runId: number, state: "success"|"partial"|"failed",
    finishedAt: Date, error?: string): void;
  snapshot(): RefreshStatusView;
}
```

忽略旧 runId 的事件；terminal 后忽略同 runId 更新。

- [ ] **Step 3: 写后台 API RED 测试**

使用 deferred coordinator 断言：

- POST 立即 202，不等待 deferred；
- runId 来自 Repository；
- 第二次 POST 409；
- GET status 返回 running 和进度；
- resolve partial 后终态 partial；
- reject 后 DB 和 tracker 均 failed，且没有 unhandled rejection；
- history limit 校验和响应 schema；
- sources 的 mode 校验仍正确。

Run: `pnpm vitest run tests/server/api.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现后台启动与路由**

`createApp` 依赖增加 tracker；POST 伪代码：

```ts
const runId = repository.startScan(new Date());
tracker.start(
  runId,
  new Date(),
  repository.getRefreshSnapshot().lastSnapshotAt
);
void coordinator.refreshAll(runId, (event) => tracker.update(runId, event))
  .then((state) => tracker.finish(runId, state, new Date()))
  .catch((error) => {
    repository.failScan(runId, safeMessage(error), new Date());
    tracker.finish(runId, "failed", new Date(), safeMessage(error));
  });
response.status(202).json({ runId, state: "running" });
```

增加 GET `/api/refresh-status`、`/api/scan-history`。`index.ts` 用 repository 最新状态
构造 tracker。

- [ ] **Step 5: 更新 HTTP client**

```ts
startRefresh?(): Promise<{ runId: number; state: "running" }>;
getRefreshStatus?(): Promise<RefreshStatusView>;
getScanHistory?(limit?: number): Promise<ScanHistoryResponse>;
```

`httpScoutApi` 实现全部新方法，但 `ScoutApi` 暂时保留旧 `refresh()` 并把新方法声明
为可选，保证 Task 5 时现有 App 和所有测试 mock 仍可编译。旧 `refresh()` 作为窄化
兼容 wrapper：调用 startRefresh 后轮询至终态；Task 7 切换 App 后删除 wrapper，
并把新方法改为 required。

- [ ] **Step 6: 运行服务端测试和类型检查**

Run:

```bash
pnpm vitest run tests/server/refreshTracker.test.ts tests/server/api.test.ts \
  tests/server/health.test.ts tests/client/App.test.tsx
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/refreshTracker.ts src/server/app.ts src/server/index.ts \
  src/client/api.ts tests/server/refreshTracker.test.ts tests/server/api.test.ts \
  tests/server/health.test.ts
git commit -m "feat: run refreshes asynchronously"
```

### Task 6: 筛选规则与 M7 短证据

**Files:**

- Create: `src/domain/listingFilters.ts`
- Create: `src/domain/evidenceExcerpt.ts`
- Create: `tests/domain/listingFilters.test.ts`
- Create: `tests/domain/evidenceExcerpt.test.ts`
- Modify: `src/client/components/FilterBar.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: 写筛选 RED 测试**

定义：

```ts
interface ListingFilters {
  source: SourceId | "all";
  secondRealName: boolean;
  recoveryCoverage: boolean;
  redSkin: string;
  julang: "all" | "owned" | "absent" | "unknown";
  m7Quality: "all" | "S" | "A" | "B" | "C";
  minRedSkinCount: 0 | 1 | 2 | 3 | 4;
  evidenceCompleteness: "all" | "complete" | "unknown";
  stability: "all" | "stable" | "new" | "changed";
}
```

测试关键字段完整定义、未命名红皮不满足数量、大小写/空白红皮搜索和所有枚举组合。

Run: `pnpm vitest run tests/domain/listingFilters.test.ts`

Expected: FAIL。

- [ ] **Step 2: 实现纯筛选函数并确认 GREEN**

```ts
export function hasCompleteKeyEvidence(listing: Listing): boolean {
  return listing.priceCny !== null &&
    listing.m7PrismQuality !== null &&
    listing.secondRealNameAvailable !== null &&
    listing.recoveryCoverage !== null &&
    listing.verificationAt !== null;
}
export function matchesListingFilters(listing: Listing, filters: ListingFilters): boolean;
```

Run: `pnpm vitest run tests/domain/listingFilters.test.ts`

Expected: PASS。

- [ ] **Step 3: 写证据片段 RED 测试**

覆盖 180 字上限、前后省略号、关键词片段、原文不改写、没有命中时安全截断、中文和
大小写 M7，并加入反例 `SKIN ABC`：其中单独的 S/A/B/C 不能被当作 M7 品质或改变
截取中心。

```ts
type EvidenceExcerpt = {
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
  segments: Array<{ text: string; highlighted: boolean }>;
};
```

Run: `pnpm vitest run tests/domain/evidenceExcerpt.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现纯片段函数**

先在原文中找 `M7|棱镜攻势|极品`，以及带品质上下文的等级表达，例如：

```regex
(?:M7|极品|品质)[\s·|:/-]{0,6}([SABC])(?:级|档|品质)?
```

不使用裸 `[SABC]`。以合法命中中心截取最多 180 字符，再按原文索引切分高亮
segment；不得拼接不连续证据。

Run: `pnpm vitest run tests/domain/evidenceExcerpt.test.ts`

Expected: PASS。

- [ ] **Step 5: 扩展 FilterBar 和 ListingDetail**

增加四个 select、巨浪 unknown、`skinValue` 排序选项；详情用 segment 渲染 `<mark>`
并显示五部分新分数。

Run: `pnpm vitest run tests/client/App.test.tsx tests/domain/listingFilters.test.ts tests/domain/evidenceExcerpt.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/domain/listingFilters.ts src/domain/evidenceExcerpt.ts \
  src/client/components/FilterBar.tsx src/client/components/ListingDetail.tsx \
  tests/domain/listingFilters.test.ts tests/domain/evidenceExcerpt.test.ts \
  tests/client/App.test.tsx
git commit -m "feat: add evidence-aware candidate filters"
```

### Task 7: 前端候选模式、刷新进度和旧快照回退

**Files:**

- Create: `src/client/components/PoolModeToggle.tsx`
- Create: `src/client/components/RefreshProgress.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/api.ts`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `src/client/components/SourceStrip.tsx`
- Modify: `tests/client/App.test.tsx`
- Modify: `tests/client/ListingTable.test.tsx`

- [ ] **Step 1: 写 mode 与 progress RED 测试**

使用 fake timers/deferred API 覆盖：

- 默认同时用 balanced 请求 sources/listings；
- 切 global 重新请求两者且列表标题为“全局 Top 30”；
- 启动时 status=running 自动恢复轮询；
- POST 后显示来源/阶段/页数/商品/详情；
- success 重载并清 warning；
- partial 重载并显示部分异常；
- failed 停止轮询且保留列表和 selected detail；
- status 传输连续失败后改 5 秒轮询并保留旧数据。

Run: `pnpm vitest run tests/client/App.test.tsx`

Expected: FAIL。

- [ ] **Step 2: 实现 PoolModeToggle 和 RefreshProgress**

Mode 用带 `aria-pressed` 的两个按钮。Progress 对 running 使用 `role=status`，对
partial/failed/transport 使用 `role=alert`，展示 `lastSnapshotAt`。

- [ ] **Step 3: 重构 App 加入单一轮询生命周期**

先把 `ScoutApi.startRefresh/getRefreshStatus/getScanHistory` 改为 required，删除
Task 5 的兼容 `refresh()`，同步更新所有 App 测试 mock。

使用一个 `pollTimerRef` 和一个 `pollSequenceRef`，视图请求仍用现有 sequence 防止
竞态。刷新错误路径禁止调用：

```ts
setListings([]);
setSelected(null);
```

只有主动切视图时可以清选择；普通 reload 失败保留已有列表。

`load(view, mode, { preserveOnError: true })` 读取同一 mode 的 sources/listings。
component unmount 必须清 timer。

- [ ] **Step 4: 列表与来源文案**

`ListingTable` 按 mode 显示：

- balanced：`每平台最多 10 · 跨平台统一评分 Top 30`
- global：`不设平台配额 · 跨平台总榜 Top 30`

列表行显示稳定徽标和次数；SourceStrip 使用服务器当前 mode 的 candidateCount。

- [ ] **Step 5: 运行前端测试和类型检查**

Run:

```bash
pnpm vitest run tests/client/App.test.tsx tests/client/ListingTable.test.tsx
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/client/App.tsx src/client/components/PoolModeToggle.tsx \
  src/client/components/RefreshProgress.tsx src/client/components/ListingTable.tsx \
  src/client/components/SourceStrip.tsx src/client/api.ts tests/client/App.test.tsx \
  tests/client/ListingTable.test.tsx
git commit -m "feat: preserve candidates during live refresh"
```

### Task 8: 移动端详情抽屉和响应式精修

**Files:**

- Create: `src/client/components/DetailDrawer.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: 写抽屉 RED 测试**

在 jsdom 使用 `matchMedia` stub 模拟 900px，断言点击候选产生：

```html
<div role="dialog" aria-modal="true" aria-labelledby="candidate-detail-title">
```

测试关闭按钮、Escape、焦点返回原列表按钮、body overflow 恢复、桌面仍用
complementary aside、移动未选择不渲染空 dialog。

Run: `pnpm vitest run tests/client/App.test.tsx`

Expected: FAIL。

- [ ] **Step 2: 实现 DetailDrawer**

组件保存 `document.activeElement`，mount 时聚焦关闭按钮并设置
`document.body.style.overflow = "hidden"`；keydown Escape 调用 onClose；cleanup
恢复 overflow 和焦点。`ListingDetail` 接受可选 `onClose`，标题 id 固定。

- [ ] **Step 3: App 按媒体查询选择详情容器**

新增 `useMediaQuery("(max-width: 1100px)")` 小 hook；桌面渲染原详情，移动端只有
selected 时渲染 drawer。改变到桌面时关闭 drawer 状态但保留 selected。

- [ ] **Step 4: 样式精修**

增加：

- `.detail-drawer__backdrop`、`.detail-drawer` 和 280ms 进入动画；
- mode、progress、stability、mark 的工业情报台样式；
- <=1100px 抽屉固定覆盖；<=720px 从底部进入、最大高度 90dvh；
- mission brief 与 source strip 使用可横向浏览的紧凑布局；
- 辅助文字最小 12px、`:focus-visible` 清晰边框；
- `@media (prefers-reduced-motion: reduce)` 关闭动画。

- [ ] **Step 5: 运行前端测试**

Run: `pnpm vitest run tests/client/App.test.tsx tests/client/ListingTable.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/client/components/DetailDrawer.tsx src/client/App.tsx \
  src/client/components/ListingDetail.tsx src/client/styles.css \
  tests/client/App.test.tsx
git commit -m "feat: add responsive candidate detail drawer"
```

### Task 9: 全量验证、真实扫描与文档

**Files:**

- Create: `scripts/verify-acceptance.mjs`
- Modify: `README.md`
- Modify as required by failures: touched production/test files only

- [ ] **Step 1: 更新 README**

写明：

- 新 30/30/20/10/10 推荐分；
- balanced/global 区别；
- 扫描历史只保留 50 次，稳定须连续两次完整扫描；
- 异步刷新、partial/failed 的旧快照行为；
- 真实扫描仍串行限速，不绕过 CAPTCHA。

- [ ] **Step 2: 运行全部测试**

Run: `pnpm test`

Expected: 所有测试 PASS，0 failed。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`

Expected: exit 0，无 TypeScript error。

- [ ] **Step 4: 生产构建**

Run: `pnpm build`

Expected: exit 0，生成 `dist/` 与 `dist-server/`。

- [ ] **Step 5: 用独立 SQLite 启动验收服务**

```bash
SCOUT_DATABASE_PATH=data/trustworthy-upgrade-acceptance.sqlite \
PORT=4410 pnpm tsx src/server/index.ts
```

在另一个终端用 API 验证：

```bash
curl -fsS -X POST http://127.0.0.1:4410/api/refresh
curl -fsS http://127.0.0.1:4410/api/refresh-status
curl -fsS 'http://127.0.0.1:4410/api/listings?mode=balanced'
curl -fsS 'http://127.0.0.1:4410/api/listings?mode=global'
curl -fsS 'http://127.0.0.1:4410/api/scan-history?limit=2'
```

轮询至终态；若某平台 CAPTCHA/结构变化，确认状态为 blocked/partial，绝不绕过。

- [ ] **Step 6: 写入并运行自动验收脚本**

创建 `scripts/verify-acceptance.mjs`，从 `process.argv[2]` 读取 base URL（默认
`http://127.0.0.1:4410`），分别读取 balanced/global、两种 mode 的 sources、
history 和 `/api/refresh-status`，使用 `node:assert/strict` 断言：

- 每个候选 QQ、官服、价格 <=6000、M7 status=peak；
- balanced 每来源 <=10；
- global 总数 <=30；
- 两池无重复 key；
- source candidateCount 与当前 mode 贡献一致；
- history 有本轮，状态和 progress 终态一致。

Run:

```bash
node scripts/verify-acceptance.mjs http://127.0.0.1:4410
```

Expected: 输出两个池的数量、各来源贡献和 `acceptance ok`，exit 0。脚本只 GET，
不触发刷新或任何平台操作。

- [ ] **Step 7: 第二轮扫描验证稳定性**

再次 POST refresh 并轮询。只对“该账号两轮均存在、物质字段未变、并且该来源两轮
`scan_source_results.state` 都是 success”的账号确认 `scanStability=stable`、
`consecutiveUnchangedScans>=2`。任一轮来源为 partial 时该来源账号必须是
unknown/0，不作为失败；如果平台库存变化，变化账号应为 changed/new，不强求所有
候选稳定。

- [ ] **Step 8: 启动前端并在 Codex 浏览器验收**

使用独立端口或更新现有本地服务，检查：

- balanced/global 切换；
- 进度和旧快照提示；
- M7 短证据高亮；
- 全部新筛选；
- 1440px 桌面详情和 390px 移动抽屉；
- 无横向溢出、Escape/关闭/焦点恢复。

- [ ] **Step 9: 最终全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build && git diff --check`

Expected: 全部 exit 0。

- [ ] **Step 10: 提交文档和验收修正**

```bash
git add README.md scripts/verify-acceptance.mjs <only-files-changed-by-acceptance>
git commit -m "docs: explain trustworthy candidate scans"
```

- [ ] **Step 11: 检查交付范围**

Run:

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
```

Expected: 工作树干净，只包含本规格改动；验收 SQLite 位于 gitignore 的 `data/`。
