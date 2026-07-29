# 候选可信度、皮肤价值与刷新体验升级设计

## 目标

在不改变现有硬条件和三平台完整分页规则的前提下，让 Delta Account
Scout 更适合做最终购买筛选：

- 账号仍须同时满足 QQ 官服、价格不高于 6000 元、M7「棱镜攻势」明确为极品；
- 默认候选池继续执行用户确认的“每个平台最多 10 个，不跨平台补位”；
- 增加可切换的跨平台全局 Top 30；
- 推荐分真正体现 M7 品质、角色红皮和巨浪价值，同时把安全信息单独解释；
- 保存最近扫描历史并标记新出现、发生变化和连续稳定的账号；
- 刷新期间展示真实进度，刷新失败时继续展示上一次有效快照；
- 补齐 M7 品质、红皮数量、证据完整度和稳定性筛选；
- 在窄屏设备上用可关闭的详情抽屉替代列表底部长详情。

本设计是以下规格的增量设计；冲突时以本设计为准：

- `2026-07-28-delta-account-scout-design.md`
- `2026-07-28-full-pagination-balanced-top30-design.md`
- `2026-07-28-pxb7-public-api-collector-design.md`

现有只读边界、反验证码边界、请求限速、硬条件分类、全部分页、来源失败隔离和
SQLite 原子快照规则继续有效。

## 已确认的产品决定

用户已经确认直接按审查建议实施。本轮采用“可信度优先”的范围：

1. 默认保留均衡候选池，新增全局 Top 30 切换；
2. 完成评分、扫描历史、稳定性、刷新进度、失败回退、筛选和移动端详情；
3. 三个平台仍按来源依次扫描，来源内部仍遵守至少 2 秒间隔；
4. 暂不并行抓取不同平台，也不缓存平台详情响应。

最后一项是有意的风险控制：当前主要问题是候选可解释性和快照可靠性，而不是单纯
刷新速度。先用扫描历史量化各平台稳定性，再决定并发强度，避免在尚无观测数据时
增加平台风控和缓存陈旧风险。

## 方案比较

### 方案 A：可信度优先的完整升级（采用）

同时增加皮肤价值评分、双候选模式、扫描历史、连续稳定性、异步刷新进度和完整前端
体验，但保持当前串行、限速的采集策略。该方案直接解决“为什么推荐它”“数据是否
刚变过”“刷新失败后还能否继续比较”三个核心问题，且不扩大采集风险。

### 方案 B：全部功能与并行采集一次完成

在方案 A 上同时并行扫描三平台并增加详情缓存。刷新可能更快，但会同时改变数据
正确性、时序、风控压力和缓存一致性，回归面过大。本轮不采用。

### 方案 C：只做前端筛选和移动端优化

改动小、上线快，但推荐分仍不体现皮肤价值，数据变化和刷新失败仍无法解释。本轮
不采用。

## 推荐分

只有 `eligibility === "eligible"` 的账号参与评分。总分仍为 100 分，但调整为：

| 分项 | 上限 | 规则 |
| --- | ---: | --- |
| 安全 | 30 | 可二次实名 12；明确支持包赔 8；验号时间不超过 7 天 10、8–30 天 6、更早 2 |
| 皮肤价值 | 30 | M7 品质 S/A/B/C 分别 14/11/8/5；角色红皮每个 2.5，最多 10；有巨浪 6 |
| 价格 | 20 | 当前全部合格账号内的反向百分位，越便宜越高 |
| 资产 | 10 | 总资产百分位 6、哈夫币百分位 3；至少一项可核验再加 1 |
| 数据置信度 | 10 | 现有 0–100 置信度线性映射 |

安全分不再因“字段虽然已知但结果为否”获得完整度奖励。例如“不可二次实名”只是不
加 12 分，不能因为它是一个已知值再加安全分。证据完整度通过置信度、独立筛选和
“待核验”文案表达。

价格、总资产和哈夫币改用稳定的秩百分位，不再使用最小值—最大值归一化。对每个
指标只收集非空有限值，按升序排列为下标 `0..n-1`；相同值取其所有下标的平均值，
百分位为 `平均下标 / (n - 1)`。因此最低值为 0、最高值为 1，并列值取得完全相同的
中位秩。`n === 1` 时固定为 0.5，缺失值没有百分位且该分项得 0。价格分使用
`(1 - percentile) * 20`，资产分使用正向百分位。单个极端价格或极端资产不会像
最小值—最大值归一化那样按绝对距离压扁其它账号的分差。排序继续使用推荐总分、
置信度、价格、抓取时间和 URL 作为确定性并列规则。

如果一个 `eligible` 账号意外出现 `m7PrismQuality === null`，M7 品质项得 0，并在
评分原因中显示“极品品质待核验”；不能擅自按 C 级计分。该记录仍遵循既有分类结果，
但会被“关键字段完整”筛选排除并在详情中突出复核提示。

`Score.parts` 改为：

```ts
{
  safety: number;      // 0..30
  skinValue: number;   // 0..30
  price: number;       // 0..20
  assets: number;      // 0..10
  confidence: number;  // 0..10
}
```

每个分项都产生中文原因；皮肤原因必须明确列出 M7 品质、已识别红皮数量和巨浪
状态。稳定性不直接进入推荐分，避免新上架的真实好账号被永久压低；它以徽标、筛选
和变更提示单独影响人工决策。

## 候选池模式

新增纯函数：

```ts
selectGlobalCandidatePool(listings, limit = 30)
```

它从全部合格且已评分账号中去重并取统一推荐顺序前 30。现有
`selectBalancedCandidatePool(listings, 10)` 保持：

- 每个平台最多 10 个；
- 平台不足 10 个时显示真实数量；
- 不用其它平台第 11 个以后补位；
- 合并后仍按统一推荐顺序排序。

API 增加 `mode`：

- `view=pool&status=eligible&mode=balanced`：默认均衡候选池；
- `view=pool&status=eligible&mode=global`：跨平台全局 Top 30；
- `mode` 省略时为 `balanced`；
- `mode` 只能和 `view=pool&status=eligible` 组合；
- 非法组合返回 HTTP 400 和 `invalid_listing_view`。

参数先按既有默认规则解析 `view/status`，再校验 `mode`。因此
`?mode=global`、`?status=eligible&mode=global` 都会解析为 pool + eligible，
属于合法请求；`?view=all&mode=global`、`?status=rejected&mode=global` 非法。

`GET /api/sources` 同样接受可选 `mode=balanced|global`，省略时为 balanced。每个
来源状态同时返回 `balancedCandidateCount`、`globalCandidateCount`，兼容字段
`candidateCount` 则根据本次 `mode` 返回对应数量。非法 mode 返回 HTTP 400
`invalid_pool_mode`。两个数量都从当前新鲜合格列表实时派生，不写入
`source_status`。

前端在“推荐候选”页显示“均衡 / 全局”分段切换。切换会重新读取服务端结果，不在
浏览器中从已截断候选池推算，并用同一 mode 重新读取 `/api/sources`，所以来源卡的
贡献数和当前候选池一致。其它状态页不显示此切换；离开候选页时保留用户最后选择的
mode，但只在返回候选页后重新生效。

## 扫描历史和稳定性

### 数据表

SQLite 幂等增加三张表：

```text
scan_runs
  id INTEGER PRIMARY KEY AUTOINCREMENT
  started_at, finished_at, state, error

scan_source_results
  PRIMARY KEY (run_id, source)
  run_id REFERENCES scan_runs(id) ON DELETE CASCADE
  source, state, pages_scanned, observed_item_count,
  eligible_count, balanced_candidate_count, global_candidate_count,
  stop_reason, error

listing_observations
  PRIMARY KEY (run_id, listing_key)
  run_id REFERENCES scan_runs(id) ON DELETE CASCADE
  listing_key, source, observed_at, eligibility, material_hash,
  stability, consecutive_unchanged_scans
```

每次刷新开始先创建 `scan_runs` 行；每个来源完成后保留结果；统一评分、重复标记和
稳定性计算完成后，在现有原子提交事务里一起写入新快照、来源结果和观察记录，并把
扫描标记为 `success` 或 `partial`。全局异常必须把扫描标记为 `failed`，但不能覆盖
上一份 `listings` 快照。

`scan_source_results` 对 `(run_id, source)` 唯一，`listing_observations` 对
`(run_id, listing_key)` 唯一，并为 `(listing_key, run_id DESC)` 和
`(source, run_id DESC)` 建索引。`state`、`source` 和计数列使用数据库 CHECK 约束；
计数非负。只保留最近 50 次扫描及其来源结果和观察记录，提交成功后删除更老
`scan_runs`，子表通过级联删除，防止本地数据库无限增长。

### 物质变化指纹

`material_hash` 只包含会影响购买判断的规范化字段：

- 价格、硬条件分类和 M7 状态/品质；
- 红皮名称与数量、巨浪状态/品质；
- 总资产、哈夫币；
- 二次实名、包赔、验号时间、封禁备注；
- 证据置信度和解析警告。

标题空白、证据顺序或抓取时间变化不单独触发“账号变化”。数组先去重排序，数字使用
已解析值，再对稳定 JSON 计算 SHA-256。

`Listing` 增加兼容旧快照的默认字段：

```ts
scanStability: "unknown" | "new" | "changed" | "stable";
consecutiveUnchangedScans: number;
```

只有 `source state === "success"` 的完整来源扫描才能建立或推进连续稳定性。
`partial` 扫描仍保存观察记录用于审计，但本轮该来源的所有 Listing 标为
`unknown / 0`，不推进、不重置之前的连续序列；`blocked` 和 `failed` 不写观察
记录。

完整扫描的规则：

- 查找该来源紧邻的上一次完整成功扫描，而不是任意 partial 扫描；
- 如果没有任何历史成功扫描且当前数据库没有该来源旧快照：`new / 1`；
- 如果没有历史表记录，但迁移前数据库存在状态为 success 的该来源旧快照，把旧
  快照视为一次兼容基线：同指纹为 `stable / 2`，不同为 `changed / 1`；
- 如果上一次完整成功扫描没有该 listing key，本轮再次出现时为 `new / 1`，此前
  更早的连续次数不继承；
- 如果上次完整成功扫描存在该 key 但指纹不同：`changed / 1`；
- 如果指纹相同：连续次数为上次次数加 1；次数达到 2 时为 `stable`；
- 某来源本轮 blocked/failed 并保留旧快照时，不制造观察、不改变旧 Listing
  payload 内已有稳定性字段。

这相当于用两个独立扫描周期做二次核验。新出现或变化账号仍可进入候选池，但界面
明确提示“首次发现”或“本轮有变化”；只有连续两次一致才显示“连续稳定”。购买前
仍必须回原平台人工验号。

API 增加：

```text
GET /api/scan-history?limit=10
```

`limit` 范围 1–50，默认 10；无效值返回 HTTP 400 `invalid_history_limit`。响应：

```ts
{
  runs: Array<{
    id: number;
    startedAt: string;
    finishedAt: string | null;
    state: "running" | "success" | "partial" | "failed";
    error: string | null;
    sources: Array<{
      source: SourceId;
      state: SourceState;
      pagesScanned: number;
      observedItemCount: number;
      eligibleCount: number;
      balancedCandidateCount: number;
      globalCandidateCount: number;
      stopReason: string | null;
      error: string | null;
    }>;
  }>;
}
```

`observedItemCount` 是本轮实际取得的商品数；blocked/failed 为 0，即使当前
`source_status.itemCount` 仍保留旧快照数量也不能写入历史。两个候选数都只统计
本轮新鲜来源在当轮统一评分后进入对应候选池的数量，失败来源均为 0。历史 API
不返回完整商品正文。

整轮状态映射固定为：

- 三个来源全部 `success`：`success`；
- 至少一个来源产生 fresh 数据（`success` 或 `partial`），且任一来源不是
  `success`：`partial`；
- 三个来源均为 `blocked` 或 `failed`，没有 fresh 数据可发布：`failed`；
- 统一评分、稳定性计算或 SQLite 提交抛错：`failed`，当前 listings 快照不变。

## 异步刷新与进度

`POST /api/refresh` 改为启动后台刷新并立即返回 HTTP 202：

```json
{ "runId": 42, "state": "running" }
```

正在刷新时再次调用继续返回 409 `refresh_in_progress`。新增：

```text
GET /api/refresh-status
```

返回当前或最近一轮状态：

```ts
{
  runId: number | null;
  state: "idle" | "running" | "success" | "partial" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  source: SourceId | null;
  phase: "discover" | "list" | "detail" | "score" | "commit" | null;
  page: number;
  summaries: number;
  details: number;
  message: string | null;
  error: string | null;
  lastSnapshotAt: string | null;
}
```

`POST` 先在数据库同步创建 `scan_runs(state=running)` 并取得真实自增 `runId`，
再把同一 ID 交给内存 tracker 和协调器；创建失败时返回 500 且不进入 running。
后台 Promise 必须安装成功和失败处理器。协调器完成原子提交后，数据库和 tracker
使用同一个整轮状态进入 `success` 或 `partial`；任何未提交异常先把数据库 run 标为
`failed`，再把 tracker 标为 failed。

状态机只允许：

```text
idle -> running -> success | partial | failed
```

一次运行达到终态后不能再回到 running。下一次 POST 创建新的 runId。服务启动时把
数据库里遗留的 `running` 扫描标记为 `failed / 进程中断`；内存 tracker 从数据库
最近一轮终态初始化。`lastSnapshotAt` 取当前 `listings.capturedAt` 的最大值；没有
任何有效快照时为 null。

协调器通过可选进度回调发布来源开始、列表页完成、详情完成、统一评分、提交和结束
事件。它不写 Cookie、Token、原文或 URL 到进度信息。

前端首次加载先读取 `/api/refresh-status`；如果已有内存任务为 running，立即恢复
轮询，同时正常加载并展示当前快照。用户启动刷新后每秒轮询状态，显示当前平台、
阶段、页数、商品数和详情数。达到 `success` 后重新读取来源和列表并清除刷新警告；
达到 `partial` 后同样重新读取，但显示“部分来源未完整刷新”和来源错误；达到
`failed` 后不替换当前前端数据，显示旧快照警告。若 POST 或轮询传输失败：

- 保留当前 `listings` 和已选详情；
- 在页面顶部显示“刷新失败，正在展示上次有效快照”；
- 显示上次成功时间和可重试按钮；
- 不再执行 `setListings([])` 或清空选择。

轮询连续失败时不把服务端任务误判为 failed；前三次继续每秒重试，之后显示“无法
读取刷新进度，任务可能仍在后台运行”，并以 5 秒间隔继续轮询，直到取得服务端终态
或组件卸载。初次启动且从未加载过数据时才使用空状态。

## 前端筛选与证据

高级筛选增加：

- M7 品质：不限、S、A、B、C；
- 最少已识别角色红皮：不限、1、2、3、4；
- 证据完整度：不限、关键字段完整、有未知字段；
- 稳定性：不限、连续稳定、首次发现、本轮有变化；
- 巨浪增加“待核验”选项。

关键字段完整定义为：价格、M7 品质、二次实名、包赔和验号时间均非空或非 unknown。
红皮数量使用 `redSkinCount`；未命名红皮不冒充已识别数量。筛选逻辑从 `App.tsx`
提取为纯函数，覆盖单元测试。

排序增加“皮肤价值高优先”，直接读取 `score.parts.skinValue`。

M7 证据不再默认渲染整段长文本。新增纯函数从首条 M7 证据中截取命中
“M7 / 棱镜攻势 / 极品 / S-A-B-C”的上下文，目标长度不超过 180 个中文字符，并在
界面使用 `<mark>` 标出关键词。全部原文仍保留在折叠的“查看原始描述与全部证据”
中。截取不能改变证据内容，也不能把分开的词拼成新的证明。

列表卡和详情页显示稳定性徽标与连续次数。`new` 和 `changed` 使用警示色，
`stable` 使用低饱和绿色，`unknown` 使用中性色。

## 响应式详情与视觉约束

现有工业情报台风格继续保留，不做无关重设计。

- 大于 1100px：保留左侧列表、右侧粘性详情；
- 不大于 1100px：点击候选后打开固定覆盖层和右侧/底部详情抽屉；
- 抽屉包含明确关闭按钮，支持 Escape，关闭后焦点返回触发候选；
- 打开时锁定背景滚动，抽屉本身可滚动，并使用 `role="dialog"`、
  `aria-modal="true"` 和标题关联；
- 固定任务条件和来源诊断在手机上变为紧凑摘要，详细内容可以展开；
- 正文和辅助文字不小于 12px，交互元素保留清晰的键盘焦点。

桌面端仍可在未选择候选时显示空详情面板；移动端未选择时不渲染空抽屉。

## 模块边界

新增或拆分以下模块，避免继续扩大 `App.tsx` 和协调器职责：

```text
src/domain/percentile.ts
  稳定秩百分位计算

src/domain/listingFingerprint.ts
  购买相关字段规范化与 SHA-256 指纹

src/domain/listingFilters.ts
  前端/领域可复用的纯筛选规则

src/domain/evidenceExcerpt.ts
  M7 短证据片段和关键词片段

src/server/refreshTracker.ts
  内存刷新状态机和进度快照

src/client/components/RefreshProgress.tsx
  刷新进度与旧快照警告

src/client/components/DetailDrawer.tsx
  窄屏详情对话框、焦点和滚动管理

src/client/components/PoolModeToggle.tsx
  均衡/全局候选切换
```

数据库迁移和历史查询仍放在 `db.ts` / `repository.ts`；协调器只发布领域进度事件，
不依赖 Express；`app.ts` 只校验 HTTP 参数和启动后台任务；React 组件不自行计算
全局候选池。

## 错误处理与兼容

- 旧 `listings.payload` 缺少稳定性字段时由 Zod 默认成 `unknown / 0`；
- 旧分数结构不能再通过新 `ScoreSchema`，启动读取时对旧 payload 清空 `score`，
  下次成功刷新重新评分，而不是导致应用无法启动；
- 新建历史表和索引必须幂等；
- 后台刷新 Promise 必须总有 rejection handler，不能产生未处理拒绝；
- 进程重启时内存中的 `running` 不延续；数据库中未结束的旧扫描标记为 `failed`
  并记录“进程中断”，当前商品快照保持不变；
- 单来源 partial/blocked/failed 继续遵循旧快照保留规则，只有当轮新鲜来源进入统一
  评分和候选池；
- 历史和刷新 API 只返回本地采集元数据，不暴露会话或请求秘密。

## 测试与验收

所有行为按测试先行实现。至少覆盖：

1. 评分权重、S/A/B/C、红皮上限、巨浪、安全否定值不加分；
2. 百分位对极端值稳定、单值中性、缺失为零、并列确定；
3. 均衡池不补位、全局池取真实 Top 30、API 非法 mode 返回 400；
4. 指纹字段规范化、物质变化检测、连续两轮稳定、来源失败不增加次数；
5. 历史表幂等迁移、50 轮保留、失败不覆盖当前快照；
6. 后台刷新 202、并发刷新 409、进度终态、Promise 失败被记录；
7. React 刷新失败保留旧候选和选择，进度轮询停止并显示旧快照警告；
8. 新筛选、皮肤排序、M7 证据截取和关键词标记；
9. 移动详情抽屉的打开、关闭、Escape、焦点恢复和无障碍属性；
10. 现有三平台分页、分类、去重和原子提交回归测试全部通过。

完成实现后执行：

```bash
pnpm test
pnpm typecheck
pnpm build
```

再使用独立临时 SQLite 启动服务，触发三平台真实刷新并确认：

- 每个平台到自然末页或给出明确 partial/blocked 原因；
- 均衡池和全局池均没有硬条件违规和重复 key；
- 刷新时能看到实时页数/商品数，失败时旧数据不消失；
- 第二轮扫描后未变化账号显示连续稳定；
- 桌面详情、窄屏抽屉和全部新增筛选均可操作。

真实刷新只做公开只读访问；如果平台要求验证码，不绕过，按 blocked 展示。
