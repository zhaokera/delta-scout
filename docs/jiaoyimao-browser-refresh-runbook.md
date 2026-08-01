# 交易猫 Codex 浏览器刷新操作手册

本手册用于软件已经创建、并由当前 Codex 任务执行的交易猫浏览器刷新。必须在同一个 Codex 浏览器标签页操作；用户负责登录和 CAPTCHA，Codex 只读取页面可见筛选标签、商品卡片和指定详情区块。普通三平台采集请使用“刷新公开数据”，不要套用本手册。

桥接客户端默认连接 `http://127.0.0.1:4310`。服务端只监听 `127.0.0.1`，客户端也只接受明文 HTTP 的 `127.0.0.1`、`localhost` 或 `[::1]` 根地址，拒绝远程主机、HTTPS、用户名密码、路径、查询和片段。

## 绝对安全边界

Codex 永不检查、读取、记录或提交 cookies、localStorage、密码、CAPTCHA 答案、网络认证请求头，也不读取 sessionStorage 或认证会话。不得打开开发者工具寻找凭据，不得导出 Cookie/session，不得查看用户输入，不得代填或绕过验证。

claim code 只来自创建任务时的一次性响应；bridge token 只保存在 `claimJiaoyimaoBrowserJob` 返回客户端的闭包中；action permit 只在闭包内附加到匹配的下一次 load/detail outcome。三者都不得公开、复制到页面脚本、序列化、持久化或写入日志、文档和错误消息；任何情况下都不得记录 action permit。服务端数据库只保存不可逆哈希，状态查询会删除这些原值。

## 14 个服务端接口与客户端入口

| 接口 | 调用方 | 用途 |
| --- | --- | --- |
| `POST /api/sources/jiaoyimao/browser-refresh` | UI `startJiaoyimaoBrowserRefresh` | 创建任务；唯一一次返回 `claimCode` |
| `GET /api/sources/jiaoyimao/browser-refresh/current` | UI `getCurrentJiaoyimaoBrowserRefresh` | 读取脱敏任务进度；永不返回接管码或 token |
| `POST /api/sources/jiaoyimao/browser-refresh/:id/cancel` | UI 或闭包 `cancel` | 取消本轮且保留旧候选 |
| `POST /api/sources/jiaoyimao/browser-refresh/:id/keep-waiting` | UI `keepWaitingForJiaoyimaoBrowserRefresh` | 把活动任务期限延长到操作后的 24 小时 |
| `POST /api/browser-refresh/:id/claim` | `claimJiaoyimaoBrowserJob` | 一次性接管并把 bridge token 留在闭包 |
| `GET /api/browser-refresh/:id/work` | 闭包 `getWork` | 获取当前阶段、序号和服务端时间 |
| `POST /api/browser-refresh/:id/filter-proof` | 闭包 `submitFilterProof` | 提交可见筛选证明 |
| `POST /api/browser-refresh/:id/list-batches` | 闭包 `submitListBatch` | 提交非空新增商品批次 |
| `POST /api/browser-refresh/:id/load-events` | 闭包 `submitLoadEvent` | 提交每次加载动作结果，包括零新增 |
| `POST /api/browser-refresh/:id/details` | 闭包 `submitDetails` | 提交指定商品的四个可见详情区块 |
| `POST /api/browser-refresh/:id/pause` | 闭包 `pause` | 尚无 load/detail outcome 时主动暂停 |
| `POST /api/browser-refresh/:id/resume` | 闭包 `resume` | 用户处理完成后从持久化阶段继续 |
| `POST /api/browser-refresh/:id/cooldown` | 闭包 `startCooldown` | 按当前 work/state 显式进入下一档或详情冷却 |
| `POST /api/browser-refresh/:id/complete` | 闭包 `complete` | 完整性校验并原子发布或隔离 |

闭包还提供本地辅助方法 `waitUntilAllowed`。它不是第十五个接口，只根据本次 `getWork` 返回的 `nextActionAt` 和 `cooldownUntil` 等待一次，不发请求。

## 一次性接管码与恢复

- 面板仅在创建成功后显示一次 claim code；刷新页面、切换设备或重新查询 current 都无法恢复。
- 若尚未接管就丢失 claim code，取消当前任务后重新创建；不要从数据库、网络记录或浏览器存储寻找。取消不会删除旧候选。
- 若已经接管，后续只使用同一闭包客户端。页面刷新不会让 current 接口泄露 token；若闭包也丢失，取消任务并重新创建。
- 活动任务默认在创建后 24 小时过期；“我还在处理，继续等待”会从操作时刻重新给出 24 小时窗口。
- 进程重启会把未提交完成的活动任务恢复为 `paused`，保留列表、详情、序号、阶段和仍有效的授权哈希。同一闭包可调用 `resume` 继续；尚未接管且仍持有原 claim code 的任务可以接管。`committing` 中断会直接变为 `failed`，避免半发布。

## 十步安全操作

1. 在软件的“交易猫浏览器刷新”面板确认任务显示“等待 Codex 接管”，读取本次一次性可见的 claim code 与任务 ID。确认正在当前 Codex 任务和同一浏览器标签页内操作。

2. 在浏览器控制运行时导入 `scripts/jiaoyimao-browser-bridge.mjs`。只把面板提供的任务 ID 和 claim code 传给 `claimJiaoyimaoBrowserJob`，不要打印或序列化返回的客户端。

   ```js
   const { claimJiaoyimaoBrowserJob } = await import(
     "./scripts/jiaoyimao-browser-bridge.mjs"
   );
   ```

3. 调用 `claimJiaoyimaoBrowserJob({ jobId, claimCode })` 接管任务并保留返回的闭包客户端。claim 只执行一次；失败时只报告稳定错误码和脱敏消息，不复制响应体，不自行循环重试。

4. 复用已经打开的精确筛选标签页；若没有才打开 `https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/`。目视确认三角洲行动、QQ、账号类别，以及 M7 棱镜攻势极品 S/A/B/C 和优品 S 共五个筛选，禁止改用宽泛搜索页，也不得从 cookies、localStorage 或网络请求推断筛选状态。若页面要求登录或 CAPTCHA，由用户本人在该标签页处理，Codex 不读取输入内容也不规避验证。

5. 从页面可见标签构造 filter proof 并调用 `submitFilterProof`。proof 必须包含当前精确 URL、可见游戏/平台/类别标签、五到八个 M7 筛选标签和观察时间，并且五个必需签名必须恰好覆盖极品 S/A/B/C 与优品 S；筛选不匹配时停止并报告，不能绕过服务端校验。

6. 列表阶段每轮先调用 `getWork`，再用 `waitUntilAllowed` 按服务端返回的 `nextActionAt` 或 `cooldownUntil` 等待，只执行一次加载动作。本轮有新增商品时先提交非空 `submitListBatch`，随后每次已经执行的加载动作都必须用 `submitLoadEvent` 报告 outcome，包括零新增、登录、CAPTCHA、限流或错误；在 outcome 被服务端接收前不得改用 `pause` 或直接重试。自然末页没有新增商品时不得发送空的 `submitListBatch`。普通列表动作间隔由服务端随机设为 `1,200–2,500 ms`；不要固定 sleep 或建立硬编码循环。

7. 若一次列表加载动作已经发生，并在结果中看到登录或 CAPTCHA，必须调用 `submitLoadEvent`，分别设置 `blockingState: "login"` 或 `"captcha"`；服务端会自动进入 `awaiting_user_verification`，不要再调用 `pause`。用户在同一标签页亲自处理并确认后调用 `resume`，随后重新 `getWork`。`pause({ reason: "login_required" | "captcha_required" })` 只用于尚未执行新加载动作时已经需要用户介入、因而没有 load outcome 可提交的场景；详情导航、结构变化、无进展和安全上限也只能在没有对应 outcome 的主动暂停点使用。Codex 不读取密码、验证码答案或输入内容。

8. 限流必须按阶段处理。首次列表加载返回限流时，先调用 `submitLoadEvent({ ..., blockingState: "rate_limited" })`；服务端会自动进入第一档 `cooling_down`，此时不得再调用 `startCooldown`。冷却结束后，重新 `getWork` 取得一次性 action permit 并执行该次列表重试；若仍为限流，先把带 permit 的 `submitLoadEvent` 提交成功，再调用一次 `startCooldown` 进入下一档。详情导航尚无可提交的 detail outcome 就直接遇到限流时，按当前 `getWork` 的 state/permit 调用一次 `startCooldown`。四档冷却依次是 30 秒、2 分钟、5 分钟、15 分钟；每一步都以最新 `getWork` 返回的 `state`、`nextActionAt`、`cooldownUntil` 或错误 `retryAt` 为准。收到 `invalid_transition` 时停止当前动作、重新读取 `getWork` 并报告，不得循环调用。action permit 成功用于匹配 outcome 或明确失效后立即丢弃，禁止记录。

9. 详情阶段按 `getWork` 给出的 `sourceListingId`、URL 和序号工作。等待服务端时间后只打开该详情一次，只读取 head、report、safety、description 四个可见区块并调用 `submitDetails`。若正常详情区块不存在，但页面主状态明确显示“商品已下架”“商品不存在”或“页面不存在”，把该可见主状态文本放入 `sections.head`，其余三个区块置空后提交；服务端会把该商品记为已完成核验并从新快照排除。普通空白页、超时或结构未知不能冒充下架。普通详情动作间隔为 `2,000–3,500 ms`；每次提交后重新 `getWork`，不得预取、猜测下一条或构造重试循环。

10. `getWork` 返回 validating、列表已自然结束且 `detailCompletedCount === detailRequiredCount` 后，只调用一次 `complete`。检查终态：`success` 表示仅交易猫正式数据被原子替换且三平台已重新评分；`quarantined` 表示新结果未发布、继续使用旧可信快照。完成或取消后丢弃客户端引用，不再使用旧 token。

## 权威时间、批次与动作规则

`nextActionAt`、`cooldownUntil` 和 `retryAt` 都由服务端决定。`waitUntilAllowed` 只对当前响应中最晚的时间执行一次等待，不发请求、不重试。网络失败、HTTP 错误或页面阻塞后先把控制权交回调用方；只有新的 `getWork` 响应才能授权下一次浏览器动作。不得用本地计数器、递归、`while` 或定时器硬编码重试策略。

- list batch 必须包含 1–25 个新增商品；重复提交完全相同的序号和 payload 可幂等重放，改动 payload 会被拒绝。
- detail batch 必须包含 1–5 个服务端要求的商品；不能发送空 batch，也不能提交未列出的详情。
- 零新增不是空 list batch：应跳过 `submitListBatch`，但仍提交一次 `submitLoadEvent`，让服务端判断自然末页、加载中、登录、CAPTCHA、限流或错误。
- 已执行列表加载后，`submitLoadEvent` 是唯一 outcome 通道：`login`/`captcha` 会自动转为 `awaiting_user_verification`，首次 `rate_limited` 会自动转为第一档 `cooling_down`，`error` 会自动转为 `paused`；这些情况下不要追加一次 `pause` 或 `startCooldown`。
- `pause` 只表示“本轮尚未执行新动作，因此没有 outcome 可提交”的主动暂停；不能拿它替代已经发生的 list load event。
- action permit 有 60 秒有效期，只授权匹配的一次 load/detail outcome；不要在页面、日志、错误或状态 API 中展示。

## 暂停、失败与终态

| 状态或事件 | 正确处理 | 正式候选 |
| --- | --- | --- |
| `awaiting_user_verification` | 已提交 login/captcha load outcome，或在动作前主动 pause；用户处理后 `resume`、再 `getWork` | 保留 |
| `paused` | 检查 reason；确认环境后 `resume`，或选择取消 | 保留 |
| `cooling_down` | 等最新服务端时间；首次 load 限流已自动进入，不能重复 `startCooldown` | 保留 |
| `cancelled` | 丢弃闭包，不再请求旧 job | 保留 |
| `failed` | 报告脱敏原因；重新创建前先确认无活动任务 | 保留 |
| `expired` | 原凭据已清除；创建新任务 | 保留 |
| `quarantined` | 不重复 complete；等待人工复核或下一次完整扫描确认 | 继续旧快照 |
| `success` | 核对 single-source 历史和 UI；不再使用旧客户端 | 发布新交易猫快照 |

## 自动化证据清单

| 完成条件 | 实现证据 | 测试证据 |
| --- | --- | --- |
| 14 个路由、严格 JSON/大小限制、脱敏响应 | `src/server/app.ts`、`src/client/api.ts` | `tests/server/api.test.ts`、`tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx` |
| loopback-only 与凭据仅在闭包 | `scripts/jiaoyimao-browser-bridge.mjs`、`src/server/index.ts` | `tests/scripts/jiaoyimao-browser-bridge.test.ts` |
| 状态机、时间窗、permit、暂停恢复 | `src/server/browserRefresh/service.ts` | `tests/server/browserRefreshService.test.ts` |
| 持久化、24 小时过期、重启恢复和清理 | `src/server/browserRefresh/repository.ts`、`src/server/db.ts` | `tests/server/browserRefreshRepository.test.ts`、`tests/server/browserRefreshService.test.ts` |
| 旧数据库无损迁移，旧 scan 默认 `all_sources/null` | `src/server/db.ts` | `tests/server/browserRefreshRepository.test.ts` |
| single-source 只替换交易猫并重评分三平台 | `src/server/repository.ts` | `tests/server/repository.test.ts`、`tests/server/api.test.ts` |
| 隔离不覆盖旧快照，取消/失败保留候选 | `src/server/repository.ts`、`src/client/useJiaoyimaoBrowserRefresh.ts` | `tests/server/api.test.ts`、`tests/client/App.test.tsx` |
| 多标签页同步、冲突互斥、终态重载 | `src/client/useJiaoyimaoBrowserRefresh.ts`、`src/server/refreshAdmission.ts` | `tests/client/App.test.tsx`、`tests/server/refreshAdmission.test.ts` |

自动化复核命令：

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
rg -n "browser_refresh|single_source|refresh_conflict|quarantined" \
  src tests README.md docs/jiaoyimao-browser-refresh-runbook.md
```

这些证据不代替真实平台验收。真实登录、CAPTCHA、页面结构和商品内容仍需在单独的浏览器验收任务中由用户参与确认。
