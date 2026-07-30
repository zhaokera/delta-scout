# 交易猫 Codex 浏览器刷新操作手册

本手册用于一次已由软件创建的交易猫浏览器刷新任务。桥接客户端默认连接
`http://127.0.0.1:4310`。它不会替 Codex 重试浏览器动作：每轮先读取服务端工作，
按服务端时间等待，执行一次动作，提交一次结果，然后把控制权交回工作循环。

安全边界：Codex 永不检查、读取、记录或提交 cookies、localStorage、密码、
CAPTCHA 答案、网络认证请求头，也不读取 sessionStorage 或认证会话。只采集页面上
普通用户可见的筛选标签、商品卡片和指定详情区块。claim code、bridge token 和
action permit 不写入日志、文档、页面脚本或持久化存储；任何情况下都不得记录 action permit。

1. 在软件的“交易猫浏览器刷新”面板确认任务显示“等待 Codex 接管”，读取面板上一次性可见的 claim code 与任务 ID。不要从开发者工具、网络记录或浏览器存储中寻找任何凭据。

2. 在 Codex 浏览器控制运行时导入 `scripts/jiaoyimao-browser-bridge.mjs`，只把面板提供的任务 ID 和 claim code 传给 `claimJiaoyimaoBrowserJob`。客户端默认使用本机 API；不要打印或序列化返回的客户端。

   ```js
   const { claimJiaoyimaoBrowserJob } = await import(
     "./scripts/jiaoyimao-browser-bridge.mjs"
   );
   ```

3. 调用 `claimJiaoyimaoBrowserJob({ jobId, claimCode })` 接管任务并保留返回的闭包客户端。claim 只执行一次；失败时向用户报告稳定错误码和消息，不复制响应体，也不自行循环重试。

4. 在浏览器中复用已经打开的精确筛选标签页；如果没有才打开 `https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/`。目视确认游戏、平台、账号类别和 M7 稀有度筛选，禁止改用宽泛搜索页，也不要从 cookies、localStorage 或网络请求推断筛选状态。

5. 从页面可见标签构造 filter proof，并调用 `submitFilterProof`。proof 必须包含当前精确 URL、可见的游戏/平台/类别标签、四到八个 M7 筛选标签和观察时间；筛选不匹配时停止采集并向用户说明，不绕过服务端校验。

6. 列表阶段每轮调用 `getWork`，用 `waitUntilAllowed` 等待服务端返回的 `nextActionAt` 或 `cooldownUntil`，只执行一次加载动作。仅当本轮观察到一个或多个新增商品时调用 `submitListBatch`；每轮都必须调用一次 `submitLoadEvent`，包括新增商品数为零的轮次。自然末页没有新增商品时，不得发送空的 `submitListBatch`。普通列表动作的服务端随机窗口是 `1,200–2,500 ms`；不要写固定 sleep，也不要建立硬编码循环。登录、CAPTCHA、限流、无进展或页面结构变化必须原样作为 outcome 报告。

7. 页面要求用户登录或完成 CAPTCHA 时，调用 `pause({ reason: "login_required" })` 或 `pause({ reason: "captcha_required" })`，立即停止浏览器动作并等待用户。Codex 不查看输入内容，不读取密码或 CAPTCHA 答案，也不代替用户处理验证。

8. 用户确认验证完成后调用 `resume`，随后重新调用 `getWork`，以服务端权威状态继续。若 outcome 仍为限流，只调用一次 `startCooldown` 并返回工作循环；四档服务端冷却为 30 秒、2 分钟、5 分钟、15 分钟。冷却结束仍以返回的 `cooldownUntil` 为准，不能按本地固定次数重试；闭包中的 `actionPermit` 只附加到匹配的 load/detail outcome，服务端成功接收或明确判定许可无效后才丢弃。

9. 详情阶段逐次读取 `getWork` 给出的 `sourceListingId`、URL 和 `nextDetailSequence`，等待权威时间后只打开该详情一次，采集 head、report、safety、description 四个可见区块并调用 `submitDetails`。普通详情动作的服务端随机窗口是 `2,000–3,500 ms`；每次提交后回到 `getWork`，不预取、不猜测下一条，也不构造重试循环。

10. `getWork` 返回 validating 且列表自然结束、必需详情全部完成后，调用一次 `complete`。在软件面板验证任务终态、扫描轮次和交易猫候选结果；若为 quarantined，保留软件显示的人工复核状态，不重复发布。完成或取消后丢弃客户端引用，不再使用旧 token。

## 时间与失败处理准则

`nextActionAt`、`cooldownUntil` 和 `retryAt` 都由服务端决定。`waitUntilAllowed`
只对当前返回的最晚时间执行一次等待，不发请求、不重试。网络失败、HTTP 错误或
页面阻塞后，先把控制权交回调用方；只有新的 `getWork` 响应才能授权下一次浏览器
动作。不得用本地计数器、递归、`while` 或定时器硬编码重试策略。
