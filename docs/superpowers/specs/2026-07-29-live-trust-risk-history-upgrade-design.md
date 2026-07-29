# 自动同步、异常保护、双评分与账号历史设计

## 目标

在现有三平台完整分页、固定硬条件、均衡候选池与全局 Top 30 的基础上，完成四项
可信度升级：

1. 页面能自动发现由其它标签页或直接调用后台 API 启动的刷新，并在新快照发布后
   自动同步；
2. 来源商品数或分页数异常骤降时保留上一次可信快照，只有连续完整扫描确认后才发布
   低量结果；
3. 将账号价值和购买安全拆成两个独立分数，同时保留可解释的综合推荐排序；
4. 保存并展示价格历史、关键字段变化和在售状态。

本设计是 `2026-07-29-trustworthy-candidate-upgrade-design.md` 的增量设计；冲突时以
本设计为准。既有只读采集、反验证码边界、来源内限速、三平台失败隔离、QQ 官服、
价格不高于 6000 元和 M7「棱镜攻势」极品硬条件保持不变。

## 采用方案

### 页面同步：服务端状态为真相源，浏览器消息只做加速

前端新增一个独立于“当前页面是否点击刷新”的轻量状态监视器：

- 页面可见时每 5 秒读取一次 `/api/refresh-status`；
- 窗口重新获得焦点或页面从隐藏变为可见时立即读取；
- 当前域内使用 `BroadcastChannel` 广播“开始刷新”和“刷新结束”，其它标签收到后
  立即读取状态；不支持该 API 时自然退化为 5 秒轮询；
- 发现新的 `runId` 正在运行时，接入现有每秒进度轮询；
- 发现 `runId` 或 `lastSnapshotAt` 更新且任务已结束时，重新读取来源与候选列表；
- 自动重载保留当前候选视图、均衡/全局模式、筛选条件和仍然存在的选中账号；
- 页面隐藏时停止周期请求，避免无意义后台流量。

`/api/refresh-status` 始终是权威状态。`BroadcastChannel` 不携带候选数据，不作为
发布证明，因此直接调用 API、其它浏览器窗口或消息丢失仍会被状态监视器发现。

### 异常骤降：一次隔离、二次确认

只对采集器报告 `state === "success"` 的完整来源扫描执行异常判断。验证码阻塞、
请求失败和 partial 扫描既不能触发低量发布，也不能作为确认轮次。

每个来源以最近一次已接受完整扫描的 `item_count` 和 `pages_scanned` 为可信基线。
满足任一条件即判为异常骤降：

- `currentItems < baselineItems * 0.5` 且绝对减少至少 10 条；
- `currentPages < baselinePages * 0.5` 且绝对减少至少 2 页。

第一次异常完整扫描：

- 本轮来源写入扫描历史，但标记 `partial / anomaly_guard`；
- `source_status` 记录基线、观测量、首次发现时间和确认次数 1；
- `listings` 继续使用该来源上一次可信快照；
- 不推进稳定轮次、不写价格变化、不把缺失商品标记为下架；
- 页面显示“数据骤降待确认：观测 N 条，仍使用可信快照 M 条”。

下一次完整扫描有三种结果：

1. 数量恢复、不再满足骤降条件：清除异常状态并正常发布；
2. 仍满足骤降条件，且商品数和页数分别处于上次异常观测值的 ±20% 容差内
   （最小容差分别为 3 条和 1 页）：视为连续确认，发布低量快照并清除异常状态；
3. 仍骤降但不在相近区间：用新观测替换待确认值，确认次数仍为 1，继续保留可信
   快照。

没有有效基线或基线过小时直接接受完整扫描。阈值先作为领域常量实现并由单元测试
锁定，避免散落在协调器和 SQL 中。

SQLite 新增 `source_anomaly_guards`：

```text
source PRIMARY KEY
state = clear | suspect
baseline_item_count, baseline_pages_scanned
observed_item_count, observed_pages_scanned
confirmation_count
first_detected_at, last_detected_at
reason
```

`scan_source_results` 新增 `anomaly_state` 与 `published`，使扫描历史能区分“抓取
成功但被保护规则隔离”和真正发布。迁移前历史默认 `anomaly_state=none`、
`published=1`。

### 双评分与综合排序

只有 `eligibility === "eligible"` 的账号参与评分。分数结构改为：

```ts
{
  total: number;       // 0..100 综合推荐分
  value: number;       // 0..100 账号价值
  safety: number;      // 0..100 购买安全
  dataQuality: number; // 0..100 数据完整度/置信度
  riskLevel: "low" | "medium" | "high" | "unknown";
  coverage: {
    knownSafetySignals: number;
    totalSafetySignals: 3;
  };
  parts: {
    m7: number;             // 0..35
    redSkins: number;       // 0..20
    julang: number;         // 0..15
    price: number;          // 0..20
    assets: number;         // 0..10
    secondRealName: number; // 0..40
    recovery: number;       // 0..35
    verification: number;   // 0..25
  };
  valueReasons: string[];
  safetyReasons: string[];
  reasons: string[];
}
```

价值分：

| 分项 | 上限 | 规则 |
| --- | ---: | --- |
| M7 品质 | 35 | S/A/B/C 分别 35/29/23/17；未知为 0 |
| 角色红皮 | 20 | 每个已识别角色 4 分，最多 5 个 |
| 巨浪 | 15 | owned 15；absent/unknown 0 |
| 价格 | 20 | 合格账号内反向中位秩百分位 |
| 资产 | 10 | 沿用总资产 6、哈夫币 3、存在可核验资产 1 |

安全分：

| 分项 | 上限 | 规则 |
| --- | ---: | --- |
| 二次实名 | 40 | true 40；false/unknown 0 |
| 找回保障 | 35 | true 35；false/unknown 0 |
| 验号时间 | 25 | 7 天内 25；8–30 天 15；更早 5；未知 0 |

未知字段得 0，不能因为平台没有提供字段而被当成安全。覆盖度分别按二次实名、包赔、
验号时间三个信号是否已知计算。

风险等级不等同于安全分：

- `high`：明确不可二次实名、明确无包赔，或存在封禁备注；
- `unknown`：三个信号全部未知；
- `medium`：至少一个信号未知、验号超过 30 天，或安全分低于 75；
- `low`：二次实名和包赔均明确为真、验号不超过 30 天且没有封禁备注。

综合推荐分：

```text
round(value * 0.55 + safety * 0.35 + dataQuality * 0.10)
```

排序仍按综合分、数据完整度、价格、抓取时间和 URL 做确定性并列。详情页同时显示
价值分、安全分、数据完整度、风险等级、覆盖度和各分项原因；列表行至少显示综合分、
价值分和风险标签，避免一个总分掩盖安全缺口。

### 结构化历史、变化与在售状态

现有 `listing_observations` 扩展为可信历史载体：

```text
snapshot_json TEXT
changes_json TEXT NOT NULL DEFAULT '[]'
availability TEXT NOT NULL DEFAULT 'active'
trusted INTEGER NOT NULL DEFAULT 0
```

`snapshot_json` 只保存会影响购买决定的结构化字段，不保存完整页面或大段原始证据：

- 价格、eligibility、M7 状态/品质；
- 红皮名称/数量、巨浪状态/品质；
- 总资产、哈夫币；
- 二次实名、包赔、验号时间、封禁备注；
- 置信度和解析警告。

每次被接受的完整来源扫描：

- 当前存在的商品写 `availability=active, trusted=1`；
- 与该来源上一次可信观察比较，生成字段级 `changes_json`；
- 上一次存在、本次缺失的商品写一条 `availability=removed` 墓碑观察；
- 新商品记录 `availability: null -> active`；
- 重新出现的商品记录 `removed -> active`；
- anomaly、partial、blocked、failed 均不能生成下架墓碑。

历史继续跟随最近 50 次正常扫描的保留策略，避免数据库无限增长。旧观察迁移后
`snapshot_json` 为空时仍可用于稳定性，但不伪造价格历史。

新增 API：

```text
GET /api/listings/:key/history?limit=20
```

返回：

- 当前 `availability` 和 `lastSeenAt`；
- 按时间倒序的可信观察；
- 每次价格、字段快照和变化列表；
- 被移除的商品即使不在当前 `listings` 中也能查询历史。

详情页增加：

- “在售 / 已下架 / 状态待确认”；
- 最近价格与相邻轮次涨跌；
- 最近 20 次价格时间线；
- 字段变化卡片，明确显示旧值和新值；
- 没有两次可信观察时显示“等待下一轮可信扫描”，不伪造趋势。

## 数据发布事务

`commitScanRefresh` 继续是唯一发布事务。事务内按顺序：

1. 读取可信基线和待确认异常状态；
2. 计算各来源发布/隔离决定；
3. 对被隔离来源保留旧 Listing，对接受来源使用新 Listing；
4. 对最终快照统一重复标记和双评分；
5. 写 `listings`、`source_status`、异常状态和 `scan_source_results`；
6. 只为已接受完整来源写可信观察、变化和下架墓碑；
7. 完成 `scan_runs` 并裁剪历史。

任何一步失败都回滚，上一份可信候选快照保持可读。协调器负责采集和进度，不负责
决定某个低量快照是否可信，避免同一规则分散在采集层和持久化层。

## API 与前端兼容

- `ScoreSchema` 对旧 payload 不兼容；`parseStoredListing` 遇到旧分数结构时清空
  `score`，启动后的派生重算会写入新结构；
- 来源 API 增加 `anomaly` 对象，原字段继续保留；
- 列表和详情历史请求失败时仍显示当前候选，只在历史区显示局部错误；
- 自动同步不能清空旧数据，任何网络失败都保留当前页面快照；
- 选中账号在新快照中消失时关闭详情并给出“该账号已不在最新在售快照”的提示。

## 验证

完成标准：

1. 单元测试证明异常阈值、首次隔离、相近低量二次确认、恢复清除和 partial 不确认；
2. Repository 测试证明隔离时旧快照不变、接受后发布、只有可信 success 生成下架；
3. 评分测试证明价值/安全独立、未知不当作安全、综合公式和风险等级；
4. API 测试证明历史、异常状态和已下架历史可查询；
5. React 测试证明后台新 run 自动接管、新快照自动加载、筛选保持，以及历史/变化
   展示；
6. 全量 `pnpm test`、`pnpm typecheck`、`pnpm build` 通过；
7. 对三平台执行一次真实刷新，检查异常保护、候选排名与历史写入；
8. 在 Codex 浏览器中检查桌面页面、自动同步、详情双评分与历史区域；
9. 提交并推送到 `origin/master`。
