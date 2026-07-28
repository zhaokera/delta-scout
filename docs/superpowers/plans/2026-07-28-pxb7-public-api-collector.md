# 螃蟹账号公开接口采集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有本地候选台通过螃蟹账号公开只读 JSON 商品接口稳定读取最多三页商品，并严格筛出 QQ 官服、6000 元内、M7「棱镜攻势」极品候选。

**Architecture:** 把采集器的 URL 参数升级为不可变 `SourceRequest`，由适配器同时描述 GET/POST、允许的公开请求头和 JSON body；交易猫、盼之继续走默认 GET。螃蟹适配器验证首页目录后构造固定搜索请求、严格解析 JSON、把列表字段转换为带 `embeddedDetail` 的摘要；协调器以方法局部请求指纹控制分页并直接使用嵌入式详情，不保存 `pageToken`。

**Tech Stack:** TypeScript、Node Fetch API、Zod、Cheerio、Vitest、`node:sqlite`、React/Vite（现有展示无需结构改造）。

---

## 文件结构

```text
src/server/collector/types.ts
  # SourceRequest、PublicRequestOptions、embeddedDetail 与新适配器合同
src/server/collector/fetcher.ts
  # 只读 GET/POST 请求执行、允许请求头、节流/重试/超时/大小限制
src/server/collector/adapters/jiaoyimao.ts
src/server/collector/adapters/panzhi.ts
  # 适配新合同，保持现有 GET 和解析行为
src/server/collector/adapters/pxb7.ts
  # 首页目录验证、公开 JSON 请求、严格响应解析、分页、嵌入式详情
src/server/collector/coordinator.ts
  # SourceRequest 调度、请求指纹、embeddedDetail 短路详情抓取
src/domain/evidence.ts
  # 精确识别 M7「棱镜攻势」别名并排除其它棱镜皮肤
src/domain/listing.ts
  # 保存 M7 极品 S/A/B/C 等级
src/client/components/ListingTable.tsx
src/client/components/ListingDetail.tsx
  # 在候选表和详情面板展示 M7 具体极品等级
tests/server/fetcher.test.ts
  # JSON POST、默认 GET 与安全请求头测试
tests/server/adapters.test.ts
  # 三来源合同、PXB 字段映射、结构错误与分页测试
tests/server/coordinator.test.ts
  # 请求指纹、嵌入式详情、部分分页和并发游标隔离
tests/server/pxb7-collection.test.ts
  # 三页 48 条离线集成验收
tests/domain/evidence.test.ts
  # M7 精确目标与反例
tests/fixtures/pxb7-list-page-{1,2,3}.json
  # 脱敏公开响应，共 48 条、至少 20 条合格
README.md
  # 螃蟹采集方式、公开 pageToken 边界与实时数量说明
```

### Task 1: 引入不可变请求合同并保持 GET 来源兼容

**Files:**
- Modify: `src/server/collector/types.ts`
- Modify: `src/server/collector/fetcher.ts`
- Modify: `src/server/collector/adapters/jiaoyimao.ts`
- Modify: `src/server/collector/adapters/panzhi.ts`
- Modify: `src/server/collector/adapters/pxb7.ts`
- Modify: `src/server/collector/coordinator.ts`
- Modify: `tests/server/fetcher.test.ts`
- Modify: `tests/server/adapters.test.ts`
- Modify: `tests/server/coordinator.test.ts`

- [ ] **Step 1: 写 JSON POST 和默认 GET 的失败测试**

在 `tests/server/fetcher.test.ts` 把现有调用改为 `{ url }`，并新增：

```ts
it("sends an approved JSON POST request without cookies or auth", async () => {
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"pageIndex":1}');
    expect(headers.get("accept")).toBe("application/json, text/plain, */*");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("origin")).toBe("https://www.pxb7.com");
    expect(headers.get("referer")).toBe("https://www.pxb7.com/");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    return new Response('{"success":true}', { status: 200 });
  });
  const fetcher = new PublicPageFetcher({ fetchFn, minimumIntervalMs: 0 });

  await expect(fetcher.fetchPage({
    url: "https://api-pc.pxb7.com/list",
    options: {
      method: "POST",
      accept: "application/json, text/plain, */*",
      contentType: "application/json",
      origin: "https://www.pxb7.com",
      referer: "https://www.pxb7.com/",
      body: '{"pageIndex":1}'
    }
  }, "pxb7")).resolves.toMatchObject({ kind: "ok" });
});
```

另加一个测试断言 `{ url: "https://example.com" }` 仍发送 GET、HTML Accept、无 body。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run tests/server/fetcher.test.ts
```

Expected: FAIL，`fetchPage` 仍只接受字符串 URL。

- [ ] **Step 3: 定义请求、摘要和适配器合同**

在 `src/server/collector/types.ts` 增加：

```ts
export interface PublicRequestOptions {
  method?: "GET" | "POST";
  accept?: string;
  contentType?: string;
  origin?: string;
  referer?: string;
  body?: string;
}

export interface SourceRequest {
  url: string;
  options?: PublicRequestOptions;
}
```

并完成以下合同替换：

```ts
export interface ListingSummary {
  // 保留现有字段
  embeddedDetail?: ListingDetail;
}

export type DiscoveryResult =
  | { kind: "ok"; request: SourceRequest }
  | { kind: "blocked"; reason: string };

export interface SourceAdapter {
  // 保留 source、entryUrl、parseList、parseDetail
  discoverCatalog(content: string, query: string): DiscoveryResult;
  nextPage(
    content: string,
    currentRequest: SourceRequest
  ): SourceRequest | null;
  detailRequest(summary: ListingSummary): SourceRequest;
}

export interface PageFetcher {
  fetchPage(
    request: SourceRequest,
    source: SourceId
  ): Promise<FetchResult>;
}
```

- [ ] **Step 4: 最小实现 GET/POST fetcher**

`PublicPageFetcher.fetchPage` 先取 `const { url, options } = request`。方法缺省为 GET；只映射 `Accept`、`Content-Type`、`Origin`、`Referer`，并继续添加现有 User-Agent、redirect 和 AbortSignal。仅 POST 传 `options.body`；不得添加 Cookie、Authorization 或其它会话头。现有节流、重试、15 秒超时和 2 MB 限制保持不变。

- [ ] **Step 5: 适配交易猫和盼之**

两个适配器分别把：

```ts
{ kind: "ok", url }
```

改为：

```ts
{ kind: "ok", request: { url } }
```

`nextPage` 返回 `{ url } | null`，`detailUrl` 重命名为：

```ts
detailRequest(summary) {
  return { url: summary.url };
}
```

更新 `tests/server/adapters.test.ts` 断言，确认交易猫和盼之得到的请求描述不含 POST options。把尚未实现 JSON 的 PXB 适配器也机械迁移到新签名：目录发现暂时返回 `{ kind: "ok", request: { url: 已发现目录 } }`，`nextPage` 接收但忽略 `currentRequest`，`detailRequest` 返回 `{ url: summary.url }`，并继续保留 `unverified_structure` 行为直到 Task 3。同步把协调器当前入口、列表和详情 fetch 调用机械迁移为 `SourceRequest`，但本任务不加入请求指纹和嵌入式详情逻辑；对应测试 fetcher 以 `request.url` 查 fixture，保证合同迁移后行为不变。

- [ ] **Step 6: 运行定向测试和类型检查**

Run:

```bash
npx vitest run tests/server/fetcher.test.ts tests/server/adapters.test.ts
npx vitest run tests/server/coordinator.test.ts
npm run typecheck
```

Expected: fetcher、适配器和协调器现有测试通过，完整类型检查无错误。

- [ ] **Step 7: 提交**

```bash
git add src/server/collector/types.ts src/server/collector/fetcher.ts \
  src/server/collector/adapters/jiaoyimao.ts \
  src/server/collector/adapters/panzhi.ts \
  src/server/collector/adapters/pxb7.ts \
  src/server/collector/coordinator.ts \
  tests/server/fetcher.test.ts tests/server/adapters.test.ts \
  tests/server/coordinator.test.ts
git commit -m "refactor: describe collector requests explicitly"
```

### Task 2: 收紧 M7「棱镜攻势」证据识别

**Files:**
- Modify: `src/domain/evidence.ts`
- Modify: `src/domain/listing.ts`
- Modify: `src/server/collector/coordinator.ts`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `tests/domain/evidence.test.ts`
- Modify: `tests/domain/listing.test.ts`
- Modify: `tests/domain/listingFactory.ts`
- Modify: `tests/server/repository.test.ts`
- Modify: `tests/client/ListingTable.test.tsx`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: 写目标别名和反例失败测试**

保留 `M7 棱镜攻势`、`M7-棱镜攻势`、`M7战斗步枪-棱镜攻势S2` 的极品/优品测试，增加 `M7棱镜攻势：极品A` 冒号形式，并新增：

```ts
it.each([
  "M7棱镜幻影(极品S)",
  "M7棱镜(极品C)",
  "M7战斗步枪-棱镜攻势S2 / 其它武器极品",
  "M7战斗步枪-棱镜攻势S2 当前有皮肤，AS Val突击步枪-悬赏令(极品S)",
  "M7战斗步枪-棱镜攻势S2\n其它字段 极品"
])("does not infer peak from non-target or cross-field text: %s", (text) => {
  expect(parseM7(toEvidenceRecords(text.split("\n"))).status).not.toBe("peak");
});
```

把旧测试中裸 `M7棱镜(极品C)` 的预期从 `peak/conflicting` 改为不命中目标；确保当前交易猫规范化证据和盼之完整名称仍命中。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run tests/domain/evidence.test.ts
```

Expected: FAIL，当前实现把任意同时含 M7 与“棱镜”的文本视为相关。

- [ ] **Step 3: 实现精确目标匹配**

用一个共享正则明确列出跨平台批准的目标别名，允许空格、中英文标点和可选 `S2`：

```ts
const M7_PRISM_TARGET =
  /(?:M7\s*[-—–·•・_：:]?\s*棱镜攻势|M7\s*战斗步枪\s*[-—–·•・_：:]?\s*棱镜攻势)(?:\s*S2)?/i;
```

`parseM7` 只把命中该正则的同一 `EvidenceRecord` 纳入 `relevant`。从目标匹配结束位置读取后缀，只有以下紧邻形式才是该目标的品质：

```ts
const quality = suffix.match(
  /^\s*(?:[（(【]\s*)?(非极品|极品|优品)\s*([SABC])?/i
);
```

如果目标后先出现 `/`、其它武器名或普通描述再出现极品，状态保持 `unknown`。否定词只在目标前紧邻短语或上述 `非极品` 中判定。不得跨记录或跨武器拼接品质；其它 M7 棱镜名称不产生 `peak`。

- [ ] **Step 4: 保存并展示具体极品等级**

让 `parseM7` 在唯一、无冲突的 `peak` 证据中返回 `quality: "S" | "A" | "B" | "C" | undefined`。在 `ListingSchema` 增加：

```ts
m7PrismQuality: z.enum(["S", "A", "B", "C"]).nullable().default(null)
```

默认值让旧 SQLite 快照在读取时安全迁移为 `null`；更新 `validListing` 和 `makeListing` 的显式字段测试新快照，并在 repository 测试中直接插入一条不含该字段的旧 payload，读取后断言 `m7PrismQuality === null`。协调器写入 `m7PrismQuality: m7.quality ?? null`；M7 状态为 `conflicting` 时强制返回 `null` 并加测试。候选表和详情把 `peak + A` 显示为 `M7 · 极品A` / `M7 棱镜攻势 · 极品A`；没有字母时仍显示“极品”。客户端测试断言具体等级可见。

- [ ] **Step 5: 运行领域和客户端测试确认 GREEN**

Run:

```bash
npx vitest run tests/domain/evidence.test.ts tests/domain/listing.test.ts \
  tests/server/adapters.test.ts tests/server/repository.test.ts \
  tests/client/ListingTable.test.tsx tests/client/App.test.tsx
npm run typecheck
```

Expected: 精确 M7、现有来源解析和具体等级展示测试通过。

- [ ] **Step 6: 提交**

```bash
git add src/domain/evidence.ts src/domain/listing.ts \
  src/server/collector/coordinator.ts \
  src/client/components/ListingTable.tsx \
  src/client/components/ListingDetail.tsx \
  tests/domain/evidence.test.ts tests/domain/listing.test.ts \
  tests/domain/listingFactory.ts tests/server/repository.test.ts \
  tests/client/ListingTable.test.tsx \
  tests/client/App.test.tsx
git commit -m "fix: preserve exact M7 prism quality"
```

### Task 3: 实现螃蟹 JSON 适配器与无状态分页

**Files:**
- Modify: `src/server/collector/adapters/pxb7.ts`
- Modify: `tests/server/adapters.test.ts`
- Create: `tests/fixtures/pxb7-list-page-1.json`
- Create: `tests/fixtures/pxb7-list-page-2.json`
- Create: `tests/fixtures/pxb7-list-page-3.json`

- [ ] **Step 1: 创建三页脱敏 fixture**

每页保存与现场响应相同的最小结构：

```json
{
  "success": true,
  "data": {
    "list": [
      {
        "productId": "2307751656489872901",
        "bizProd": "1",
        "gameId": "10371",
        "gameName": "三角洲行动",
        "price": 528800,
        "showTitle": "QQ登录【总资产】268M【哈夫币】2888w【枪械皮肤】M7战斗步枪-棱镜攻势S2(极品A)【角色皮肤】威龙-凌霄戍卫【近战武器】巨浪(极品)【实名】可二次实名",
        "productUniqueNo": "PXB-001",
        "guarantee": 1
      }
    ],
    "properties": {
      "pageToken": "fixture-page-2"
    }
  }
}
```

三页各 16 个不同纯数字 `productId`，共 48 条。至少 21 条使用 QQ、价格 `<= 600000` 分、目标 M7 极品；其余使用结构合法但不合格的微信、双登录、超预算、优品、棱镜幻影和证据缺失商品。字段类型错误等结构反例必须放在独立的内联测试 JSON 中，不能污染 48 条成功 fixture。第一页 Token 指向第二页，第二页指向第三页，第三页没有 Token。fixture 不保存现场 `pageToken`、账号、Cookie 或其它会话数据，只使用人工脱敏游标。

- [ ] **Step 2: 写目录发现、请求形状和字段映射失败测试**

在 `tests/server/adapters.test.ts` 断言：

```ts
const discovery = pxb7Adapter.discoverCatalog(
  await fixture("pxb7-home.html"),
  "三角洲行动"
);
expect(discovery).toEqual({
  kind: "ok",
  request: {
    url: "https://api-pc.pxb7.com/api/search/product/v2/selectSearchPageList",
    options: {
      method: "POST",
      accept: "application/json, text/plain, */*",
      contentType: "application/json",
      origin: "https://www.pxb7.com",
      referer: "https://www.pxb7.com/",
      body: expect.any(String)
    }
  }
});
```

紧接着解析 `discovery.request.options.body` 并断言第一页 body 完全等于：

```ts
expect(JSON.parse(discovery.request.options?.body ?? "")).toEqual({
  query: "M7战斗步枪-棱镜攻势S2 极品",
  gameId: "10371",
  pageIndex: 1,
  pageSize: 16,
  bizProd: 1,
  type: "4",
  posType: 1
});
```

解析第一页后断言首条商品：

```ts
expect(item).toMatchObject({
  source: "pxb7",
  sourceListingId: "2307751656489872901",
  url: "https://www.pxb7.com/product/2307751656489872901/1",
  priceCny: 5288,
  embeddedDetail: {
    loginPlatform: "qq",
    service: "official",
    totalAssetsM: 268,
    hafCoins: 28_880_000,
    secondRealNameAvailable: true,
    recoveryCoverage: null
  }
});
```

并断言 evidence 保留目标 M7、角色红皮、巨浪；数值型 `guarantee: 1` 不得映射为找回包赔。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run tests/server/adapters.test.ts
```

Expected: FAIL，现有 PXB 适配器仍返回 `unverified_structure`。

- [ ] **Step 4: 实现严格响应解析和证据分段**

在 `pxb7.ts` 内定义 Zod 响应 schema 或等价的显式类型守卫，要求：

- 根节点 `success === true`；
- `data` 是对象且 `data.list` 是数组；
- 有效商品必须有纯数字字符串 `productId`、`bizProd` 为字符串 `"1"` 或数字 `1`、`gameId` 为字符串 `"10371"`、`gameName` 为字符串 `"三角洲行动"`、有限非负数字 `price`、非空字符串 `showTitle`、非空字符串 `productUniqueNo` 和有限数字 `guarantee`；
- `data.properties` 必须是对象；`pageToken` 可以缺失，但存在时必须是字符串，空字符串视为无下一页；
- 无效根结构整体返回 `{ kind: "blocked", reason: "structure_changed" }`；
- 列表内任一商品字段类型不符也让整页返回 `{ kind: "blocked", reason: "structure_changed" }`，防止结构变化被误当成成功空快照并覆盖旧数据；
- 成功空列表返回 `{ kind: "ok", items: [] }`。

`showTitle` 先按换行和 `【栏目】` 边界分段，再调用 `toEvidenceRecords`，保证每个栏目独立且 M7 品质仍与目标名称同记录。用 `parseChineseAmount` 映射总资产和哈夫币；`QQ登录` 单独存在时映射 `qq/official`，`微信登录` 单独存在时映射 `wechat/unknown`，两者同时出现或都没有时映射 `unknown/unknown`。只从明确的“可/不可二次实名”“包赔/无包赔”文本映射安全字段。

- [ ] **Step 5: 实现无状态分页**

导出或复用固定 `makeListRequest(pageIndex, pageToken?)`，它在每一页都必须写入精确固定字段 `query`、`gameId`、`pageSize`、`bizProd`、`type`、`posType`，只允许 `pageIndex` 与可选 `pageToken` 变化。`nextPage(content, currentRequest)`：

1. 严格解析当前响应；
2. 读取非空 `data.properties.pageToken`；
3. 解析 `currentRequest.options.body` 的 `pageIndex`；
4. Token 缺失、与当前 body Token 相同或当前请求不是合法 PXB POST 时返回 `null`；
5. 返回带 `pageIndex + 1` 和新 `pageToken` 的全新 `SourceRequest`，不得把游标写入模块变量。

- [ ] **Step 6: 写并运行结构错误、登录方式和分页反例**

覆盖无效 JSON、`success: false`、`data.list` 缺失、微信、双登录、无登录、非数字 ID、数字和字符串两种合法 `bizProd: 1`、错误 bizProd，以及 `gameName/productUniqueNo/guarantee/pageToken` 的错误类型。覆盖无 Token、空 Token、重复 Token，断言第二页 body 保留所有固定搜索字段，只增加响应 Token 且 `pageIndex === 2`。

Run:

```bash
npx vitest run tests/server/adapters.test.ts
```

Expected: PXB 正反例全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/server/collector/adapters/pxb7.ts tests/server/adapters.test.ts \
  tests/fixtures/pxb7-list-page-1.json \
  tests/fixtures/pxb7-list-page-2.json \
  tests/fixtures/pxb7-list-page-3.json
git commit -m "feat: parse PXB7 public product search"
```

### Task 4: 协调器使用请求描述、嵌入式详情和请求指纹

**Files:**
- Modify: `src/server/collector/coordinator.ts`
- Modify: `tests/server/coordinator.test.ts`

- [ ] **Step 1: 更新测试 fetcher 并写嵌入式详情失败测试**

`MapFetcher` 记录 `SourceRequest[]`，以 `method + url + body` 为 fixture key。给一个摘要附上 `embeddedDetail`，断言刷新后：

```ts
expect(fetcher.calls).toEqual([
  { url: adapter.entryUrl },
  discovery.request
]);
expect(adapter.detailRequest).not.toHaveBeenCalled();
expect(repository.getListings("eligible")).toHaveLength(1);
```

该摘要必须包含 QQ 官服、目标 M7 极品、价格和展示字段，并能从 embedded detail 进入 `eligible`。

- [ ] **Step 2: 写请求指纹和分页失败测试**

覆盖：

- `nextPage` 返回与当前 `method + url + body` 相同的请求时停止，不重复 fetch；
- 第二或第三页失败时保存已有商品并标记 `partial`；
- 两个独立协调器并发刷新同一无状态适配器时，各自从 page 1 开始并各走自己的 Token，不共享已访问集合；
- 仍保持最多 3 页、60 摘要、20 个外部详情上限。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
npx vitest run tests/server/coordinator.test.ts
```

Expected: FAIL，协调器仍传字符串 URL，且总是请求详情页。

- [ ] **Step 4: 实现请求描述和局部指纹**

入口请求改为：

```ts
const entryRequest: SourceRequest = { url: adapter.entryUrl };
```

列表循环维护：

```ts
const seenRequests = new Set<string>();
const fingerprint = [
  request.options?.method ?? "GET",
  request.url,
  request.options?.body ?? ""
].join("\n");
```

请求前若指纹重复则成功停止分页；这个 Set 只能定义在 `refreshSource` 内，不能成为实例字段。传给 `adapter.nextPage(page.html, currentRequest)` 的必须是本次实际执行的不可变请求。

- [ ] **Step 5: 实现嵌入式详情短路**

创建 `CollectedSummary` 时：

```ts
detail: item.embeddedDetail ?? null,
detailAttempted: item.embeddedDetail !== undefined
```

只有 `item.embeddedDetail === undefined && shouldFetchDetail(item)` 才计入 20 个详情上限并调用 `adapter.detailRequest(item)`。嵌入式详情已满足字段证据时，分类不得被降为 `needs_verification`。

- [ ] **Step 6: 运行协调器、全套测试和类型检查**

Run:

```bash
npx vitest run tests/server/coordinator.test.ts
npm test
npm run typecheck
```

Expected: 所有测试与类型检查通过，交易猫和盼之无回归。

- [ ] **Step 7: 提交**

```bash
git add src/server/collector/coordinator.ts tests/server/coordinator.test.ts
git commit -m "feat: collect embedded PXB7 product details"
```

### Task 5: 三页离线验收、文档和实时只读验证

**Files:**
- Create: `tests/server/pxb7-collection.test.ts`
- Modify: `README.md`

- [ ] **Step 1: 写三页 48 条集成验收**

用真实 `pxb7Adapter`、内存 `ListingRepository` 和 fixture fetcher 运行一个来源刷新，断言：

```ts
expect(fetcher.listRequests).toHaveLength(3);
expect(repository.getListings()).toHaveLength(48);
expect(repository.getListings("eligible").length).toBeGreaterThanOrEqual(20);
expect(repository.getListings("eligible").every((listing) =>
  listing.source === "pxb7" &&
  listing.loginPlatform === "qq" &&
  listing.service === "official" &&
  listing.priceCny !== null &&
  listing.priceCny <= 6000 &&
  listing.m7PrismStatus === "peak" &&
  ["S", "A", "B", "C"].includes(listing.m7PrismQuality ?? "") &&
  listing.url ===
    `https://www.pxb7.com/product/${listing.sourceListingId}/1`
)).toBe(true);
expect(fetcher.detailRequests).toHaveLength(0);
```

同时检查至少一条候选的 `m7PrismQuality`、`redSkins`、`julangStatus/julangQuality`、`totalAssetsM`、`hafCoins` 和二次实名字段，以证明现有 UI 所需字段齐全。

- [ ] **Step 2: 运行集成测试确认 GREEN**

Run:

```bash
npx vitest run tests/server/pxb7-collection.test.ts
```

Expected: 3 页、48 条、至少 20 条 eligible，且没有商品详情请求。

- [ ] **Step 3: 更新 README**

把螃蟹状态改为“首页确认目录后调用页面自身使用的公开只读 JSON 商品查询”；说明：

- 不使用登录态、Cookie、认证 Token；
- `pageToken` 只在单次刷新内存中分页，用后丢弃；
- 最多三页、每页 16 条；
- 实时库存不足时展示实际数量，不伪造 20 条；
- 平台结构变化时保留旧快照并标记来源异常。

- [ ] **Step 4: 运行完整静态和生产验证**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部通过，无 whitespace error。

- [ ] **Step 5: 使用内存库做一次实时只读 PXB 刷新**

用 `tsx -e` 构造只含 `pxb7Adapter` 的 `CollectionCoordinator`、`PublicPageFetcher` 和内存数据库，打印来源状态、总商品数、合格数及首条合格候选的非敏感字段。不得读取浏览器 Cookie，不得写生产 SQLite。

验收规则：

- 首页目录与公开 POST 请求成功时，来源状态不再是 `unverified_structure`；
- 连续 Token 存在时最多发 3 个列表请求；
- 合格候选全部满足 QQ、官服、`priceCny <= 6000`、`m7PrismStatus === "peak"`；
- 实时数量允许小于 20，但必须报告实际数量；
- 若平台当前返回验证码或结构变化，保留离线通过证据并如实报告实时阻塞原因，不能伪报成功。

- [ ] **Step 6: 启动功能工作树服务并在 Codex 浏览器验证**

先停止旧的 `main` 开发服务，再从功能工作树运行 `npm run dev`，打开 `http://127.0.0.1:4311/`。点击刷新后检查螃蟹来源状态；选择一条螃蟹合格候选，确认列表和详情显示 M7 极品、角色红皮、巨浪、资产、实名以及正确的原平台链接。

- [ ] **Step 7: 提交**

```bash
git add tests/server/pxb7-collection.test.ts README.md
git commit -m "test: verify three PXB7 candidate pages"
```

- [ ] **Step 8: 最终审阅并整合**

按 `superpowers:verification-before-completion` 重新运行完整验证，按 `superpowers:requesting-code-review` 检查相对 `main` 的全部改动。确认无问题后，按 `superpowers:finishing-a-development-branch` 将 `codex/pxb7-public-api` 快进或合并回 `main`，并在 `main` 再运行：

```bash
npm test
npm run typecheck
npm run build
git status --short --branch
```

Expected: 测试、类型检查和构建全绿，`main` 工作区干净。
