# 三角洲账号候选台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本地 Web 应用，从交易猫、盼之代售和螃蟹账号的公开页面采集《三角洲行动》账号，筛出 QQ 官服、M7“棱镜攻势”极品且价格不超过 6000 元的候选，并展示红皮、巨浪、资产、安全信息与可解释评分。

**Architecture:** 单仓库 TypeScript 应用；React + Vite 提供候选台，Express 提供本地 API，Node `node:sqlite` 保存快照。三个来源实现同一适配器接口，采集协调器负责限速和失败隔离；解析、过滤、置信度和评分均为无副作用函数并用离线 HTML 夹具测试。

**Tech Stack:** Node.js 24、pnpm、TypeScript、React、Vite、Express、Cheerio、Zod、`node:sqlite`、Vitest、Testing Library、Supertest。

---

## 文件结构

```text
package.json                         # scripts 与依赖
tsconfig.json                        # 通用 TypeScript 配置
tsconfig.server.json                 # 服务端配置
vite.config.ts                       # Vite、Vitest 与 /api 代理
index.html                           # 前端入口
src/client/main.tsx                  # React 挂载
src/client/App.tsx                   # 页面状态与布局
src/client/api.ts                    # 本地 API 客户端
src/client/styles.css                # 工业化“战术终端”视觉
src/client/components/SourceStrip.tsx
src/client/components/ListingTable.tsx
src/client/components/ListingDetail.tsx
src/client/components/FilterBar.tsx
src/domain/listing.ts                # 标准化类型与 schema
src/domain/evidence.ts               # M7、红皮、巨浪证据解析
src/domain/classify.ts               # eligible/needs_verification/rejected
src/domain/confidence.ts             # 0–100 置信度
src/domain/score.ts                  # 可解释推荐分
src/domain/duplicates.ts             # 跨平台可能重复提示
src/domain/url.ts                    # URL 规范化与键生成
src/server/app.ts                    # Express app factory
src/server/index.ts                  # 启动服务与静态资源
src/server/db.ts                     # SQLite 初始化与事务
src/server/repository.ts             # listing/source status 持久化
src/server/collector/types.ts        # 适配器和 fetcher 合同
src/server/collector/fetcher.ts      # 受限 HTTP 获取、超时、重试
src/server/collector/coordinator.ts  # 三来源调度与失败隔离
src/server/collector/sources.ts      # 三个平台配置注册表
src/server/collector/adapters/*.ts   # 三个平台解析器
tests/domain/*.test.ts               # 纯函数测试
tests/server/*.test.ts               # API、存储、协调器测试
tests/client/*.test.tsx              # UI 行为测试
tests/fixtures/*.html                # 三来源最小离线 DOM 夹具
README.md                            # 运行、边界与验证说明
```

### Task 1: 项目骨架与健康检查

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Test: `tests/server/health.test.ts`
- Test: `tests/client/App.test.tsx`

- [ ] **Step 1: 创建项目配置并安装依赖**

Run:

```bash
pnpm add react react-dom express cheerio zod
pnpm add -D typescript vite @vitejs/plugin-react vitest jsdom tsx concurrently supertest @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/node @types/express @types/react @types/react-dom @types/supertest
```

配置 scripts：`dev` 同时启动 Vite 与 Express，`test` 运行 Vitest，`typecheck` 运行前后端 TypeScript，`build` 构建前端和服务端。

- [ ] **Step 2: 写健康接口失败测试**

```ts
import request from "supertest";
import { createApp } from "../../src/server/app";

it("returns local service health", async () => {
  const response = await request(createApp()).get("/api/health");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true, service: "delta-account-scout" });
});
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `pnpm vitest run tests/server/health.test.ts`

Expected: FAIL，`src/server/app` 不存在。

- [ ] **Step 4: 实现最小 Express app 与启动入口**

`createApp()` 返回 Express 实例并实现 `/api/health`；`index.ts` 监听 `127.0.0.1`，端口来自 `PORT`，默认 `4310`。

- [ ] **Step 5: 运行健康测试确认 GREEN**

Run: `pnpm vitest run tests/server/health.test.ts`

Expected: 1 test passed。

- [ ] **Step 6: 写并运行前端骨架失败测试**

断言页面出现“账号候选台”和固定硬条件“QQ 官服 / 棱镜攻势极品 / ¥6,000以内”；先运行并确认因 `App` 不存在或内容缺失而失败。

- [ ] **Step 7: 实现最小 React 挂载和页面骨架**

只实现标题、硬条件栏和空状态，不提前实现候选业务。

- [ ] **Step 8: 运行 Task 1 测试与类型检查**

Run: `pnpm vitest run tests/server/health.test.ts tests/client/App.test.tsx && pnpm typecheck`

Expected: 全部通过，无 TypeScript 错误。

- [ ] **Step 9: 提交**

```bash
git add package.json pnpm-lock.yaml tsconfig*.json vite.config.ts index.html src tests
git commit -m "feat: scaffold delta account scout"
```

### Task 2: 标准化模型与严格证据解析

**Files:**
- Create: `src/domain/listing.ts`
- Create: `src/domain/evidence.ts`
- Test: `tests/domain/evidence.test.ts`

- [ ] **Step 1: 写 M7 证据解析失败测试**

覆盖以下输入和结果：

```ts
expect(parseM7(["M7 棱镜攻势 极品"]).status).toBe("peak");
expect(parseM7(["M7 棱镜攻势 优品"]).status).toBe("premium");
expect(parseM7(["M7 棱镜攻势", "另一件皮肤 极品"]).status).toBe("unknown");
expect(parseM7(["M7 未拥有棱镜攻势 极品"]).status).toBe("conflicting");
expect(parseM7(["M7 棱镜攻势 极品 优品"]).status).toBe("conflicting");
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run tests/domain/evidence.test.ts`

Expected: FAIL，解析函数不存在。

- [ ] **Step 3: 实现 M7 同记录解析**

先按结构化字段、换行和列表项切为 `EvidenceRecord[]`；禁止跨记录组合“棱镜攻势”和“极品”。返回状态、命中记录和 warning。每条保存证据限制为 2000 个 Unicode 字符并记录是否被截断。

- [ ] **Step 4: 运行 M7 测试确认 GREEN**

Run: `pnpm vitest run tests/domain/evidence.test.ts`

- [ ] **Step 5: 写红皮与巨浪失败测试**

覆盖“威龙 红皮”“有红皮但无角色名”“普通皮肤不算红皮”“巨浪 极品”“无巨浪”“未拥有巨浪”。

- [ ] **Step 6: 实现最小红皮和巨浪解析**

只有角色名和 `红皮`/`红色品质` 同记录才输出角色名；否定巨浪优先于正向精确词。所有结果携带原文证据。

- [ ] **Step 7: 定义 `Listing`、枚举和 Zod schema**

实现设计说明中的完整字段；未知值必须显式表示，禁止以空字符串冒充已知。

- [ ] **Step 8: 运行领域测试和类型检查**

Run: `pnpm vitest run tests/domain/evidence.test.ts && pnpm typecheck`

- [ ] **Step 9: 提交**

```bash
git add src/domain tests/domain
git commit -m "feat: parse account evidence safely"
```

### Task 3: 分类、置信度、评分和 URL 键

**Files:**
- Create: `src/domain/classify.ts`
- Create: `src/domain/confidence.ts`
- Create: `src/domain/score.ts`
- Create: `src/domain/duplicates.ts`
- Create: `src/domain/url.ts`
- Test: `tests/domain/classify.test.ts`
- Test: `tests/domain/confidence.test.ts`
- Test: `tests/domain/score.test.ts`
- Test: `tests/domain/duplicates.test.ts`
- Test: `tests/domain/url.test.ts`

- [ ] **Step 1: 写分类失败测试**

测试：只有 `loginPlatform = QQ` 且 `service = 官服`、5999、peak 才为 `eligible`；微信、明确非官服、6001、premium/absent 为 `rejected`；QQ 已知但 `service` 未知为 `needs_verification`；已知价格超限同时 M7 未知仍为 `rejected`。

- [ ] **Step 2: 运行分类测试确认 RED**

Run: `pnpm vitest run tests/domain/classify.test.ts`

- [ ] **Step 3: 实现 `classifyListing` 并确认 GREEN**

严格按“任何已知失败优先 rejected；QQ 与官服两个字段及其它硬条件全部通过才 eligible；其余 needs_verification”。

- [ ] **Step 4: 写置信度失败测试并实现**

逐项测试 35/15/15/15/10/10 的累加，确保无证据不计分且结果限制为 0–100 整数。

- [ ] **Step 5: 写评分失败测试并实现**

测试安全分、单候选价格 12.5、min–max 价格/资产、缺失资产为 0、相同指标归一化为 0.5、总分四舍五入和并列排序顺序。返回 `{ total, parts, reasons }`。

- [ ] **Step 6: 写 URL 规范化失败测试并实现**

删除 fragment、`utm_*`、`spm`、`from`，统一 host 小写和尾斜杠；保留业务查询参数。测试 `source + listingId` 优先、规范化 URL 退化键。

- [ ] **Step 7: 写“可能重复”失败测试并实现**

仅当来源不同、总资产相差不超过 0.5M、哈夫币相同且 M7/红皮/巨浪原文证据完全相同才标记；缺失任一条件或来源相同均不标记，且永不合并记录。

- [ ] **Step 8: 运行领域测试全集**

Run: `pnpm vitest run tests/domain && pnpm typecheck`

- [ ] **Step 9: 提交**

```bash
git add src/domain tests/domain
git commit -m "feat: classify and score account listings"
```

### Task 4: SQLite 快照与来源状态

**Files:**
- Create: `src/server/db.ts`
- Create: `src/server/repository.ts`
- Test: `tests/server/repository.test.ts`

- [ ] **Step 1: 写内存 SQLite 失败测试**

测试 schema 初始化、listing upsert、按状态查询、来源最近成功时间、失败时保留旧快照、数据库写入失败时事务回滚并返回可操作错误、超过 24 小时返回 `stale: true`、`partial` 状态、时间输出为带时区的 ISO 8601 字符串。

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm vitest run tests/server/repository.test.ts`

- [ ] **Step 3: 实现数据库与事务仓库**

使用 `DatabaseSync(":memory:")` 测试；生产默认 `data/scout.sqlite`。一次来源刷新成功后才事务替换该来源快照；失败只更新 source status。

- [ ] **Step 4: 运行确认 GREEN**

Run: `pnpm vitest run tests/server/repository.test.ts && pnpm typecheck`

- [ ] **Step 5: 提交**

```bash
git add src/server/db.ts src/server/repository.ts tests/server/repository.test.ts
git commit -m "feat: persist listing snapshots"
```

### Task 5: 采集框架与三个来源适配器

**Files:**
- Create: `src/server/collector/types.ts`
- Create: `src/server/collector/fetcher.ts`
- Create: `src/server/collector/coordinator.ts`
- Create: `src/server/collector/sources.ts`
- Create: `src/server/collector/adapters/jiaoyimao.ts`
- Create: `src/server/collector/adapters/panzhi.ts`
- Create: `src/server/collector/adapters/pxb7.ts`
- Create: `tests/fixtures/jiaoyimao-home.html`
- Create: `tests/fixtures/jiaoyimao-list.html`
- Create: `tests/fixtures/jiaoyimao-list-page-2.html`
- Create: `tests/fixtures/jiaoyimao-detail.html`
- Create: `tests/fixtures/panzhi-home.html`
- Create: `tests/fixtures/panzhi-list.html`
- Create: `tests/fixtures/panzhi-list-page-2.html`
- Create: `tests/fixtures/panzhi-detail.html`
- Create: `tests/fixtures/pxb7-home.html`
- Create: `tests/fixtures/pxb7-list.html`
- Create: `tests/fixtures/pxb7-list-page-2.html`
- Create: `tests/fixtures/pxb7-detail.html`
- Test: `tests/server/fetcher.test.ts`
- Test: `tests/server/adapters.test.ts`
- Test: `tests/server/coordinator.test.ts`

- [ ] **Step 1: 在 Codex 浏览器只读检查三个公共入口**

依次打开 `https://www.jiaoyimao.com/`、`https://www.pzds.com/`、`https://pxb7.net/`，使用站内正常搜索定位“三角洲行动”账号目录。若公开首页、列表、下一页和详情可见，只保存与目录发现及解析有关的最小脱敏 DOM 片段作为 home/list/list-page-2/detail fixture。若要求登录/验证码，不处理验证码、不猜内部 API：保存能证明阻塞状态的最小 fixture，并使用公开索引页面中已观察到的字段形状制作标记为 `synthetic` 的最小详情 fixture；适配器在未经过真实 DOM 验证前必须返回 `blocked/unverified_structure`，不能把 synthetic fixture 当成实时支持。

- [ ] **Step 2: 写 fetcher 失败测试**

注入假 `fetch` 和假时钟，断言 15 秒超时、一次重试、同来源 2 秒间隔、非 2xx 错误和登录/验证码页识别。

- [ ] **Step 3: 实现受限 fetcher 并确认 GREEN**

不得在测试中访问网络；响应限制最大 2 MB，设置明确 User-Agent，返回 typed result：`ok | blocked | failed`。

- [ ] **Step 4: 写三个适配器失败测试**

先用 home fixture 断言 `discoverCatalog(homeHtml, "三角洲行动")` 只从正常可见链接或 GET 搜索表单生成目录 URL；无法发现时返回 blocked。每个 list fixture 至少包含一个可能命中的账号和一个无关账号，并通过 `nextPage(listHtml)` 只返回 DOM 中真实存在的下一页 URL。断言适配器输出同一 `ListingSummary` 合同、来源 ID、商品 URL 和价格。每个 detail fixture 断言输出统一 `ListingDetail`：分割后的证据记录、QQ/官服、M7、红皮、巨浪、资产、实名、包赔和验号字段。明确测试 summary 与 detail 合并后才可进入领域分类。

- [ ] **Step 5: 实现三个来源适配器**

适配器合同明确拆分 `entryUrl`、`discoverCatalog(entryHtml, query)`、`parseList(html)`、`nextPage(html)`、`detailUrl(summary)` 与 `parseDetail(html, summary)`。`discoverCatalog` 只接受 GET 表单或页面中可见的真实链接；`nextPage` 只复制当前 DOM 中的下一页链接，二者都不能拼接猜测路由。选择器只来自 Step 1 观察到的公开 DOM；适配器无法确认页面结构时返回 `blocked/structure_changed` 或 `blocked/unverified_structure`，不产生空白“成功”。

- [ ] **Step 6: 写协调器失败测试**

用三份假适配器断言：协调器先获取 entry、调用 `discoverCatalog`，再仅沿 `nextPage` 返回的 URL 遍历；单来源失败不影响其它来源；每个来源最多 3 页/60 摘要/20 详情；详情失败的摘要进入 `needs_verification` 而不是 eligible；达到上限产生 `partial`；成功快照提交，失败旧快照保留。

- [ ] **Step 7: 实现协调器并确认 GREEN**

预筛只用于减少详情请求，最终资格必须在 summary/detail 合并后走领域分类器；跨平台只标记“可能重复”，不合并记录。每次刷新结束时，以数据库中当前保留的全部 eligible 快照（包含明确标记 stale 的旧来源）重新计算集合相对分数并持久化；查询时不重新评分。

- [ ] **Step 8: 运行采集测试全集**

Run: `pnpm vitest run tests/server/fetcher.test.ts tests/server/adapters.test.ts tests/server/coordinator.test.ts && pnpm typecheck`

- [ ] **Step 9: 提交**

```bash
git add src/server/collector tests/fixtures tests/server
git commit -m "feat: collect public marketplace listings"
```

### Task 6: 刷新和查询 API

**Files:**
- Modify: `src/server/app.ts`
- Test: `tests/server/api.test.ts`

- [ ] **Step 1: 写 API 失败测试**

使用内存 repository 和假 coordinator，覆盖：

- `GET /api/sources` 返回三个来源及 stale/blocked 状态；
- `GET /api/listings?status=eligible` 只返回合格候选并按分排序；
- `GET /api/listings/:key` 返回证据与评分原因；
- `POST /api/refresh` 触发一次刷新，已有任务时返回 409；
- 输入错误返回结构化 400，不泄露内部堆栈。

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm vitest run tests/server/api.test.ts`

- [ ] **Step 3: 实现 API 与依赖注入**

`createApp({ repository, coordinator })` 允许测试注入；生产启动时装配真实依赖。

- [ ] **Step 4: 运行确认 GREEN**

Run: `pnpm vitest run tests/server/api.test.ts && pnpm typecheck`

- [ ] **Step 5: 提交**

```bash
git add src/server/app.ts src/server/index.ts tests/server/api.test.ts
git commit -m "feat: expose listing refresh api"
```

### Task 7: 候选台界面

**Files:**
- Create: `src/client/api.ts`
- Modify: `src/client/App.tsx`
- Create: `src/client/components/SourceStrip.tsx`
- Create: `src/client/components/FilterBar.tsx`
- Create: `src/client/components/ListingTable.tsx`
- Create: `src/client/components/ListingDetail.tsx`
- Create: `src/client/styles.css`
- Test: `tests/client/App.test.tsx`
- Test: `tests/client/ListingTable.test.tsx`

- [ ] **Step 1: 写候选台行为失败测试**

注入 API 客户端，断言：三来源状态显示条目数、最近时间、stale/blocked/partial；默认只显示 eligible；候选行显示来源、价格、红皮数、巨浪、总资产、实名/包赔标签、置信度和评分；点行显示 M7 原文、红皮名称、巨浪品质、总资产、哈夫币、安全字段、评分分项/理由、抓取时间、原始描述和原平台链接；未知字段统一渲染“待人工核验”；用户可切换排序并展开高级筛选。

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm vitest run tests/client`

- [ ] **Step 3: 实现数据加载、空态和错误态**

来源 blocked 时显示“自动采集受阻”，partial 显示已采集条目数，陈旧快照显示最近成功时间；数据库或刷新错误显示可操作信息；刷新期间禁用按钮，结束后重新查询数据。

- [ ] **Step 4: 实现列表、详情和筛选**

支持 eligible、待人工核验、已淘汰三种视图；默认 eligible。排序支持推荐分、价格、总资产、置信度；高级筛选支持来源、可二次实名、包赔、红皮角色和巨浪状态，且可一键恢复默认。原平台链接使用 `target="_blank" rel="noreferrer"`。

- [ ] **Step 5: 完成视觉实现**

采用深色战术终端风格：炭黑背景、荧光黄绿强调、清晰的等宽数字、细网格纹理；桌面双栏，窄屏改为上下布局。避免使用通用紫色渐变和默认系统字体。

- [ ] **Step 6: 补充可访问性与响应式测试**

按钮、状态和表格有可访问名称；详情区键盘可达；在 390px 宽度无横向溢出。

- [ ] **Step 7: 运行 UI 测试和构建**

Run: `pnpm vitest run tests/client && pnpm typecheck && pnpm build`

Expected: 测试通过，构建 exit 0。

- [ ] **Step 8: 提交**

```bash
git add src/client tests/client index.html
git commit -m "feat: add tactical account dashboard"
```

### Task 8: 文档、全量验证与 Codex 浏览器验收

**Files:**
- Create: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: 写运行和安全边界说明**

说明 `pnpm install`、`pnpm dev`、`pnpm test`、`pnpm build`；列出三平台公开采集、登录/CAPTCHA 暂停、无凭据存储、最终交易由用户完成；明确某来源失败后保留的 stale 快照仍参与下一次集合相对评分，界面会显著标记陈旧。

- [ ] **Step 2: 运行完整自动验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: 全部 exit 0；测试 0 failures；构建无错误。

- [ ] **Step 3: 启动持久本地服务**

使用持久终端会话运行 `pnpm dev`，确认 `/api/health` 返回 200。

- [ ] **Step 4: 在 Codex 浏览器完成 UI 验收**

打开本地候选台；验证固定条件、三个来源状态、刷新、候选列表、详情、待核验视图和窄屏布局。若公共来源可用，至少核对一条真实商品的价格、M7 证据和原链接；若被登录/验证码阻塞，确认来源明确显示 blocked 且其他来源仍可用。

- [ ] **Step 5: 检查控制台和网络错误**

页面交互后确认无未处理异常；API 错误在 UI 中以可操作文本展示。

- [ ] **Step 6: 最终提交**

```bash
git add README.md .gitignore
git commit -m "docs: add scout runbook"
git status --short
```

Expected: 工作区干净。
