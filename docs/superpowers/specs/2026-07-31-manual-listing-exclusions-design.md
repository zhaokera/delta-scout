# 人工淘汰与反馈原因设计

## 目标

Delta Account Scout 允许用户在人工查看平台商品后，把“不值得继续考虑”的账号标记为人工淘汰。人工淘汰必须立即让该账号退出平台均衡候选池、全局 Top 30 和全部合格视图，且后续平台刷新、应用重启和账号重新上架都不能自动清除该决定。

每次人工决定同时保存结构化原因、可选备注和发生时间，为以后分析用户偏好和调整评分模型保留可信训练素材。本阶段只记录反馈并控制候选资格，不根据少量反馈自动修改其它账号的推荐分。

## 已批准的产品规则

- 人工淘汰是可恢复的，不删除平台商品或采集证据。
- 原因由一个必选标签和一段可选备注组成。
- 原因标签固定为：
  - `price_overvalued`：价格虚高；
  - `m7_low_value`：M7 不值；
  - `red_skins_mismatch`：红皮不合适；
  - `safety_risk`：安全风险；
  - `assets_low`：资产不足；
  - `seller_concern`：卖家问题；
  - `other`：其他。
- 选择“其他”时备注必填；其它标签的备注可选。
- 备注去除首尾空白后最多 500 个字符。
- 恢复只代表重新参与原有排名，不保证重新进入 Top 30。
- 当前分数、分项分数、证据、扫描稳定性和可信历史不因人工决定而改变。
- 人工反馈只保存在本地 SQLite，不发送给交易平台。

## 方案比较

### 方案 A：独立追加式人工评审记录（采用）

在独立表中保存每次淘汰或恢复动作。候选池在读取当前快照时应用最新人工决定，平台采集仍只负责原始商品数据。

优点：

- 来源快照被整表替换时不会丢失用户决定；
- 能保留完整反馈历史，适合以后分析评分偏差；
- 不污染平台证据、物质指纹或扫描历史；
- 恢复和重复上架语义清晰。

### 方案 B：直接修改 `listings.eligibility`

下一次来源刷新会用新采集的 payload 覆盖字段，人工原因也没有独立存放位置。不采用。

### 方案 C：只保存在浏览器本地

换浏览器、清理站点数据或使用另一个标签页时容易丢失，服务端也无法用反馈分析评分。不采用。

## 数据模型

新增追加式表：

```sql
CREATE TABLE IF NOT EXISTS manual_listing_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_key TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK(source IN ('jiaoyimao', 'panzhi', 'pxb7')),
  action TEXT NOT NULL
    CHECK(action IN ('exclude', 'restore')),
  reason_code TEXT
    CHECK(reason_code IS NULL OR reason_code IN (
      'price_overvalued',
      'm7_low_value',
      'red_skins_mismatch',
      'safety_risk',
      'assets_low',
      'seller_concern',
      'other'
    )),
  note TEXT,
  created_at TEXT NOT NULL,
  CHECK(
    (action = 'exclude' AND reason_code IS NOT NULL)
    OR
    (action = 'restore' AND reason_code IS NULL AND note IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS manual_listing_reviews_latest_idx
  ON manual_listing_reviews (listing_key, id DESC);
```

当前状态由每个 `listing_key` 最大 `id` 的记录决定：

- 最新动作为 `exclude`：当前人工淘汰；
- 最新动作为 `restore` 或不存在记录：当前不受人工限制。

追加记录保留历史原因。对已经处于相同淘汰原因和备注的账号重复提交时返回当前结果而不重复写入；修改原因则追加新的 `exclude` 记录。对已恢复或从未淘汰的账号重复恢复是幂等成功。

人工记录不设置指向 `listings` 的外键。商品下架或来源快照替换时记录继续存在；同一个稳定 `listing_key` 以后重新出现时，最新人工决定重新生效。

## 领域与读取模型

新增独立领域类型 `ManualListingReview` 和 `ReviewedListing`：

```ts
type ManualReviewReason =
  | "price_overvalued"
  | "m7_low_value"
  | "red_skins_mismatch"
  | "safety_risk"
  | "assets_low"
  | "seller_concern"
  | "other";

interface ManualListingReview {
  excluded: true;
  reason: ManualReviewReason;
  note: string | null;
  reviewedAt: string;
}

type ReviewedListing = Listing & {
  manualReview: ManualListingReview | null;
};
```

采集器、分类器、评分器、物质指纹和可信观察继续只处理 `Listing`。Repository 在 API 读取边界批量加载最新人工记录，并把它们装饰到 Listing 上，避免逐账号查询。

## 候选与视图语义

`readCurrentListingSnapshot` 先取得当前来源快照和最新人工决定，再生成下列集合：

- 可参与评分视图：来源新鲜、`eligibility === "eligible"` 且未被人工淘汰；
- 平台均衡池：从上述集合中每个平台最多取 10 个；
- 全局池：从上述集合中取统一推荐分最高的 30 个。

API 视图规则：

- `view=pool&status=eligible`：排除人工淘汰后生成候选池；
- `view=all&status=eligible`：只返回未被人工淘汰的硬条件合格账号；
- `view=all&status=needs_verification`：保持现有分类语义；
- `view=all&status=rejected`：返回硬条件淘汰账号，加上当前人工淘汰账号；按 `listing.key` 去重。

人工淘汰账号的原始 `eligibility` 保持不变，界面通过 `manualReview` 区分“人工淘汰”和“硬条件淘汰”。来源卡的 `eligibleCount`、均衡候选数和全局候选数使用应用人工决定后的集合，因此与实际列表一致。商品总数仍表示来源快照实际商品数。

当 Top 30 中的账号被淘汰时，请求下一份候选池会自然让下一名补位；不为不足 30 条的来源伪造或复制账号。

## API

### 人工淘汰

```http
PUT /api/listings/:key/manual-exclusion
Content-Type: application/json

{
  "reason": "price_overvalued",
  "note": "同价位安全条件明显更好"
}
```

成功返回当前 `ReviewedListing`。约束：

- `key` 必须对应当前快照中的账号；
- 只有 `eligibility === "eligible"` 的账号可人工淘汰；
- `reason` 必须是固定枚举；
- `note` 为空字符串时规范化为 `null`；
- `reason === "other"` 时规范化后的 `note` 不能为空。

### 恢复参与排名

```http
DELETE /api/listings/:key/manual-exclusion
```

成功返回当前 `ReviewedListing`，其中 `manualReview === null`。恢复接口幂等；当前商品不存在时返回 404。

稳定错误：

- `invalid_manual_review`：请求字段、原因或备注无效；
- `listing_not_found`：当前快照不存在该账号；
- `listing_not_eligible`：账号本来就不满足硬条件，不能重复标记成人工淘汰；
- `manual_review_failed`：本地持久化失败。

写入和当前状态读取在一个数据库事务中完成。API 不接受客户端时间或来源字段，避免伪造评审归属。

## 前端交互

### 淘汰

账号详情底部新增“人工淘汰”按钮。列表行不提供快捷淘汰，降低误点概率。

点击后打开可访问的模态框：

- 单选必选原因标签；
- 最多 500 字的补充说明；
- “其他”未填写说明时阻止提交并显示就地错误；
- 取消和关闭不产生写入；
- 提交期间禁用重复提交。

成功后：

1. 关闭模态框和详情抽屉；
2. 重新读取当前来源状态和当前视图；
3. 当前账号退出候选/合格列表，下一名自动补位；
4. 页面显示“已人工淘汰，可在已淘汰中恢复”；
5. 通过现有 `BroadcastChannel` 通知其它候选台标签重新读取数据。

失败时保留当前账号、表单内容和选择状态，显示安全的本地错误，不做乐观移除。

### 已淘汰与恢复

“已淘汰”列表中的人工记录展示“人工淘汰”标签和原因标签。详情新增人工评审区，显示原因、备注和时间，并提供“恢复参与排名”按钮。

恢复成功后重新读取当前视图；账号从“已淘汰”消失，并按原有分数重新参与全部合格视图和两个候选池。恢复失败时保留详情和错误。

桌面侧栏和移动端详情抽屉复用同一个 `ListingDetail` 行为，模态框由 App 统一管理，避免两个表面产生不同状态。

## 并发与刷新

- 人工评审写入不需要等待平台刷新结束，因为它只追加独立记录。
- 刷新提交替换 `listings` 时不得删除 `manual_listing_reviews`。
- 多标签页同时操作时，以数据库最新 `id` 为准；每个成功动作广播重新加载。
- 如果账号在表单打开期间被刷新下架，提交返回 `listing_not_found`，界面保留原因并提示重新选择。
- 如果另一个标签已经提交相同原因，重复提交幂等返回同一状态。

## 非目标

本阶段不实现：

- 根据单条或少量反馈自动调整评分权重；
- 自动把一个平台的淘汰传播到疑似重复账号或其它平台；
- 云同步、多人账号或远程反馈上传；
- 删除人工评审历史；
- 自动联系卖家、下单或更改平台商品。

## 测试与验收

### 自动化

- 数据库启动幂等创建评审表和索引；
- 淘汰、修改原因、幂等重复、恢复和重启后状态；
- 来源快照替换后评审仍存在，账号重新出现仍被排除；
- 均衡池、全局池、全部合格和已淘汰视图语义；
- 淘汰 Top 30 账号后下一名补位；
- 原因枚举、500 字限制、“其他”备注必填、404 和非 eligible 冲突；
- 客户端表单校验、成功重载、失败保留、人工标签和恢复；
- 桌面详情与移动抽屉共享行为；
- 多标签广播重新加载。

### 浏览器验收

使用临时 SQLite 数据库启动独立验收实例，不污染真实反馈：

1. 打开均衡池并记录一个候选；
2. 选择原因和备注后人工淘汰；
3. 验证候选立即消失、下一名补位、来源计数更新；
4. 在“已淘汰”中查看原因、备注和时间；
5. 重启验收实例，验证淘汰仍存在；
6. 恢复参与排名，验证账号重新进入合格集合；
7. 验证全局 Top 30 同样遵守人工决定；
8. 运行数据库完整性检查。

最终门禁为：

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```
