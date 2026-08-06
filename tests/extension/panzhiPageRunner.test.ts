// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PanzhiPageRunner,
  type PageRunnerDependencies
} from "../../extensions/panzhi-auto-refresh/src/pageRunner.js";
import {
  detectVerificationBlocker,
  extractVisibleCards,
  locateRequiredControls,
  readResultState,
  selectedState,
  verifyRequiredFilters
} from "../../extensions/panzhi-auto-refresh/src/pageSelectors.js";

const fixtureDirectory = resolve(process.cwd(), "tests/fixtures");

function loadFixture(name = "panzhi-filter-page.html"): Document {
  document.documentElement.innerHTML = readFileSync(
    resolve(fixtureDirectory, name),
    "utf8"
  );
  return document;
}

function signalResultCycle(
  root: Document,
  mutate: () => void = () => undefined,
  delayMs = 0
): void {
  const list = root.querySelector<HTMLElement>(
    "[aria-label='商品列表'], .goods-list-with-game .virtual-list"
  );
  if (!list) throw new Error("missing fixture list");
  list.setAttribute("aria-busy", "true");
  setTimeout(() => {
    mutate();
    list.setAttribute("aria-busy", "false");
  }, delayMs);
}

function replaceLiveResultsWithStrictEmpty(root: Document): void {
  const list = root.querySelector<HTMLElement>("[aria-label='商品列表']");
  if (!list) throw new Error("missing fixture list");
  list.outerHTML = `
    <section class="goods-list-with-game">
      <div class="virtual-list">
        <div class="virtual-list-phantom"></div>
        <div class="virtual-list-container"></div>
        <div class="empty"></div>
      </div>
    </section>
  `;
}

function installFilterBehavior(
  root: Document,
  skipButtonLabels: string[] = []
): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
    if (skipButtonLabels.includes(button.textContent?.trim() ?? "")) continue;
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", "true");
      signalResultCycle(root);
    });
  }
  for (const input of root.querySelectorAll<HTMLInputElement>(
    'input[placeholder="最低值"], input[placeholder="最高值"]'
  )) {
    input.addEventListener("input", () => signalResultCycle(root));
  }
}

function installLiveFilterBehavior(
  root: Document,
  signalPriceImmediately = true
): void {
  for (const option of root.querySelectorAll<HTMLElement>(".opt-item")) {
    option.addEventListener("click", () => {
      option.classList.add("opt-item_active");
      signalResultCycle(root);
    });
  }
  for (const option of root.querySelectorAll<HTMLElement>(".drop-item")) {
    option.addEventListener("click", () => {
      const checkbox = option.closest(".filter-item-checkbox");
      const label = option.querySelector("label")?.textContent?.trim();
      const textNode = [...(checkbox?.childNodes ?? [])].find(
        (node) => node.nodeType === 3 && node.textContent?.trim()
      );
      if (textNode && label) textNode.textContent = `\n                ${label}\n                `;
      signalResultCycle(root);
    });
  }
  for (const input of root.querySelectorAll<HTMLInputElement>(
    'input[placeholder="最低值"], input[placeholder="最高值"]'
  )) {
    input.addEventListener("input", () => {
      if (!signalPriceImmediately) return;
      const min = root.querySelector<HTMLInputElement>(
        'input[placeholder="最低值"]'
      );
      const max = root.querySelector<HTMLInputElement>(
        'input[placeholder="最高值"]'
      );
      if (min?.value && max?.value) signalResultCycle(root);
    });
  }
}

function appendCard(root: Document, id: string): void {
  const list = root.querySelector<HTMLElement>("[aria-label='商品列表']");
  if (!list) throw new Error("missing fixture list");
  list.insertAdjacentHTML(
    "beforeend",
    `<a href="/goodsDetails/${id}/6?from=list">
      <h4>新增商品 ${id}</h4>
      <p>QQ | 可二次实名 | 骇爪-维什戴尔 | 露娜-黑天际线</p>
      <span>¥ 2999</span>
    </a>`
  );
}

function dependencies(
  root: Document,
  overrides: Partial<PageRunnerDependencies> = {}
): PageRunnerDependencies {
  return {
    document: root,
    currentUrl: () => "https://www.pzds.com/goodsList/391/6",
    now: () => new Date("2026-08-04T08:00:00.000Z"),
    random: () => 0.5,
    sleep: async () => undefined,
    settlementDelay: (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
    loadMore: async () => signalResultCycle(root),
    mutationTimeoutMs: 500,
    resultStabilityMs: 2,
    onStage: async () => undefined,
    isCurrentRun: () => true,
    ...overrides
  };
}

describe("Panzhi visible-page selectors", () => {
  it("stops a superseded run after a wait without clicking the next filter", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    installLiveFilterBehavior(root);
    let current = true;
    const controlsBefore = locateRequiredControls(root);
    expect(controlsBefore.kind).toBe("found");
    if (controlsBefore.kind !== "found") return;
    const qqClick = vi.fn();
    controlsBefore.qq.addEventListener("click", qqClick);

    const result = await new PanzhiPageRunner(dependencies(root, {
      isCurrentRun: () => current,
      sleep: async () => {
        current = false;
      }
    })).run("quick");

    expect(result).toEqual({
      kind: "superseded",
      stage: "applying_filters"
    });
    expect(qqClick).not.toHaveBeenCalled();
  });

  it("applies filters through the div controls used by the live Panzhi page", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    installLiveFilterBehavior(root);

    const result = await new PanzhiPageRunner(dependencies(root)).run("quick");

    expect(result.kind).toBe("snapshot");
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    expect(controls.qq.classList.contains("opt-item_active")).toBe(true);
    expect(controls.secondRealName.classList.contains("opt-item_active")).toBe(true);
    expect(controls.requiredSkins.every((control) =>
      control.classList.contains("opt-item_active"))).toBe(true);
    expect(controls.allSemantics.classList.contains("drop-item")).toBe(true);
    expect(selectedState(controls.allSemantics)).toEqual({
      kind: "selected-state",
      selected: true
    });
    expect(verifyRequiredFilters(root)).toEqual({ kind: "verified" });
  });

  it("allows the live price fields to defer their result refresh to the next filter action", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    installLiveFilterBehavior(root, false);

    const result = await new PanzhiPageRunner(dependencies(root)).run("quick");

    expect(result.kind).toBe("snapshot");
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    expect(controls.minPrice.value).toBe("1900");
    expect(controls.maxPrice.value).toBe("4000");
    expect(verifyRequiredFilters(root)).toEqual({ kind: "verified" });
  });

  it("waits for the SPA result container after the filter controls render", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    installLiveFilterBehavior(root);
    const list = root.querySelector<HTMLElement>("[aria-label='商品列表']");
    expect(list).not.toBeNull();
    const listMarkup = list!.outerHTML;
    list!.remove();
    let readinessDelayCount = 0;

    const result = await new PanzhiPageRunner(dependencies(root, {
      sleep: async (milliseconds) => {
        if (milliseconds !== 250) return;
        readinessDelayCount += 1;
        if (readinessDelayCount === 1) {
          root.querySelector("main")?.insertAdjacentHTML(
            "beforeend",
            listMarkup
          );
        }
      }
    })).run("quick");

    expect(readinessDelayCount).toBe(1);
    expect(result.kind).toBe("snapshot");
  });

  it("locates, applies, and strictly verifies the approved native filters", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    const delays: number[] = [];
    const runner = new PanzhiPageRunner(dependencies(root, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      }
    }));

    const result = await runner.run("quick");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot.filterProof).toEqual({
      currentUrl: "https://www.pzds.com/goodsList/391/6",
      gameLabel: "三角洲行动",
      minPriceInput: "1900",
      maxPriceInput: "4000",
      secondRealNameFilter: {
        label: "可二次实名",
        selected: true
      },
      operatorSkinFilter: {
        fieldId: "22858",
        fieldLabel: "特战干员外观",
        fieldType: "CHECKBOX",
        mappingField: "22858",
        searchType: "ALL",
        searchTypeLabel: "全部都要有",
        selectedOptions: [
          {
            optionId: "1038173",
            label: "骇爪-维什戴尔",
            metadataCode: "SA200018"
          },
          {
            optionId: "1035794",
            label: "露娜-黑天际线",
            metadataCode: "SA200003"
          }
        ]
      },
      observedAt: "2026-08-04T08:00:00.000Z"
    });
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    expect(controls.minPrice.value).toBe("1900");
    expect(controls.maxPrice.value).toBe("4000");
    expect(controls.qq.getAttribute("aria-pressed")).toBe("true");
    expect(controls.secondRealName.getAttribute("aria-pressed")).toBe("true");
    expect(controls.requiredSkins.map((control) => control.getAttribute("aria-pressed")))
      .toEqual(["true", "true"]);
    expect(controls.allSemantics.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("button:nth-of-type(3)")?.textContent).not.toBe(
      "红狼-蚀金玫瑰"
    );
    const unrelated = [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "红狼-蚀金玫瑰"
    );
    expect(unrelated?.getAttribute("aria-pressed")).toBe("false");
    expect(delays.length).toBeGreaterThanOrEqual(7);
    expect(delays.every((delay) => delay >= 350 && delay <= 850)).toBe(true);
  });

  it("extracts only unique visible canonical cards", () => {
    const root = loadFixture();

    expect(extractVisibleCards(root)).toEqual({
      kind: "cards",
      items: [
        {
          sourceListingId: "SA2VISIBLE1",
          url: "https://www.pzds.com/goodsDetails/SA2VISIBLE1/6",
          title: "双红皮三角洲账号",
          rawText:
            "双红皮三角洲账号 QQ | 可二次实名 | 骇爪-维什戴尔 | 露娜-黑天际线 ¥ 2888",
          priceCny: 2888
        },
        {
          sourceListingId: "SA2VISIBLE2",
          url: "https://www.pzds.com/goodsDetails/SA2VISIBLE2/6",
          title: "高资产三角洲账号",
          rawText:
            "高资产三角洲账号 QQ | 可二次实名 | 骇爪-维什戴尔 | 露娜-黑天际线 ¥ 3999",
          priceCny: 3999
        }
      ]
    });
  });

  it("does not let a single-card role list override the inferred main results", () => {
    const root = loadFixture();
    root.body.innerHTML = `<main>
      <div>
        <a href="/goodsDetails/SA2VISIBLE1/6">
          <h4>主商品 A</h4><span>¥ 2888</span>
        </a>
        <a href="/goodsDetails/SA2VISIBLE2/6">
          <h4>主商品 B</h4><span>¥ 3999</span>
        </a>
      </div>
      <aside role="list">
        <a href="/goodsDetails/SA2RECOMMENDED/6">
          <h4>推荐商品</h4><span>¥ 2666</span>
        </a>
      </aside>
    </main>`;

    const extracted = extractVisibleCards(root);

    expect(extracted.kind).toBe("cards");
    if (extracted.kind !== "cards") return;
    expect(extracted.items.map(({ sourceListingId }) => sourceListingId))
      .toEqual(["SA2VISIBLE1", "SA2VISIBLE2"]);

    root.querySelector("aside")?.insertAdjacentHTML(
      "beforeend",
      `<a href="/goodsDetails/SA2RECOMMENDED2/6">
        <h4>推荐商品二</h4><span>¥ 2777</span>
      </a>`
    );
    expect(extractVisibleCards(root)).toMatchObject({
      kind: "failure",
      code: "structural_drift"
    });
  });

  it("fails closed when a multi-card role list conflicts with one outside card", () => {
    const root = loadFixture();
    root.body.innerHTML = `<main>
      <div>
        <a href="/goodsDetails/SA2VISIBLE1/6">
          <h4>主商品 A</h4><span>¥ 2888</span>
        </a>
      </div>
      <aside role="list">
        <a href="/goodsDetails/SA2RECOMMENDED1/6">
          <h4>推荐商品一</h4><span>¥ 2666</span>
        </a>
        <a href="/goodsDetails/SA2RECOMMENDED2/6">
          <h4>推荐商品二</h4><span>¥ 2777</span>
        </a>
      </aside>
    </main>`;

    expect(extractVisibleCards(root)).toMatchObject({
      kind: "failure",
      code: "structural_drift"
    });
  });

  it("changes the result signature when a visible same-id price changes", () => {
    const root = loadFixture();
    const before = readResultState(root);
    expect(before.kind).toBe("result-state");
    const visiblePrice = root.querySelector<HTMLElement>(
      "a[href*='SA2VISIBLE1'] span:not(.fixture-old-price)"
    );
    expect(visiblePrice).not.toBeNull();
    visiblePrice!.textContent = "¥ 3888";

    const after = readResultState(root);

    expect(after.kind).toBe("result-state");
    if (before.kind !== "result-state" || after.kind !== "result-state") return;
    expect(after.visibleIds).toEqual(before.visibleIds);
    expect(after.signature).not.toBe(before.signature);
  });

  it("accepts only the exact visible Panzhi virtual-list empty fingerprint", () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(root);

    expect(readResultState(root)).toEqual({
      kind: "result-state",
      signature: "empty",
      visibleIds: [],
      loadingVisible: false,
      endMarkerVisible: true,
      emptyResultVisible: true
    });
    expect(extractVisibleCards(root)).toEqual({ kind: "cards", items: [] });
  });

  it("does not accept generic, ambiguous, hidden, or loading markers as empty", () => {
    const generic = loadFixture("panzhi-live-filter-page.html");
    generic.querySelector("[aria-label='商品列表']")?.remove();
    generic.body.insertAdjacentHTML("beforeend", '<div class="empty"></div>');
    expect(readResultState(generic)).toMatchObject({ kind: "failure" });

    const duplicate = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(duplicate);
    const virtual = duplicate.querySelector<HTMLElement>(".virtual-list");
    virtual?.parentElement?.append(virtual.cloneNode(true));
    expect(readResultState(duplicate)).toMatchObject({ kind: "failure" });

    const hidden = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(hidden);
    hidden.querySelector<HTMLElement>(".empty")!.style.display = "none";
    expect(readResultState(hidden)).toMatchObject({ kind: "failure" });

    const loading = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(loading);
    loading.querySelector<HTMLElement>(".virtual-list")!
      .setAttribute("aria-busy", "true");
    expect(readResultState(loading)).toMatchObject({
      kind: "result-state",
      visibleIds: [],
      loadingVisible: true,
      endMarkerVisible: false,
      emptyResultVisible: false
    });
  });

  it("reports bounded result-link diagnostics without query data", () => {
    const root = loadFixture();
    root.body.innerHTML = `<main><section class="goods-list loading-state">
        <a href="/goodsDetails/SA2ONLYONE/6?token=do-not-report">商品一</a>
        <a href="/goods-details/SA2CHANGED/6?signature=do-not-report">商品二</a>
        <a href="/help?session=do-not-report">帮助</a>
        <button class="goods-list-action">立即筛选</button>
        <p>加载失败</p>
        <iframe src="/goods-frame?token=do-not-report"></iframe>
      </section></main>`;

    const result = readResultState(root);

    expect(result).toMatchObject({
      kind: "failure",
      code: "missing_controls"
    });
    if (result.kind !== "failure") return;
    expect(result.message).toContain("allLinks=3");
    expect(result.message).toContain("goodsDetailLinks=1");
    expect(result.message).toContain("canonicalLinks=1");
    expect(result.message).toContain("visibleCanonicalLinks=1");
    expect(result.message).toContain("explicitCandidates=0");
    expect(result.message).toContain(`visibilityState=${root.visibilityState}`);
    expect(result.message).toContain(`readyState=${root.readyState}`);
    expect(result.message).toContain("iframeCount=1");
    expect(result.message).toContain("iframeHints=same:/goods-frame:");
    expect(result.message).toContain("actionHints=立即筛选");
    expect(result.message).toContain("statusHints=加载失败");
    expect(result.message).toContain(
      "classHints=goods-list|loading-state|goods-list-action"
    );
    expect(result.message).toContain(
      "emptyFingerprint=g=0/0,gp=na,rch=0/0,rk=none,vh=none," +
      "ag=0/0,lt=0/0,gl=0/0,gch=0/0,gc=0," +
      "glb=na,glp=na,gk=none,pv=0/0,pe=0/0,pvb=na,peb=na"
    );
    expect(result.message).toContain(
      "samplePaths=/goodsDetails/SA2ONLYONE/6|/goods-details/SA2CHANGED/6"
    );
    expect(result.message).not.toContain("do-not-report");
  });

  it("reports bounded style blockers for the live hidden empty structure", () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(root);
    const branch = root.querySelector<HTMLElement>(".goods-list-with-game")!;
    const virtual = branch.querySelector<HTMLElement>(".virtual-list")!;
    const empty = virtual.querySelector<HTMLElement>(".empty")!;
    branch.append(empty);
    virtual.style.display = "none";
    empty.style.display = "none";

    const result = readResultState(root);

    expect(result).toMatchObject({ kind: "failure" });
    if (result.kind !== "failure") return;
    expect(result.message).toContain(
      "emptyFingerprint=g=1/1,gp=main,rch=2/0," +
      "rk=div.virtual-list:d:div.virtual-list|div.empty:d:div.empty," +
      "vh=none,ag=0/0,lt=0/0,gl=0/0,gch=0/0,gc=0," +
      "glb=na,glp=na,gk=none,pv=1/0,pe=1/0," +
      "pvb=d:div.virtual-list,peb=d:div.empty"
    );
  });

  it("reports the bounded visible main-list shape separately from popovers", () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(root);
    const branch = root.querySelector<HTMLElement>(".goods-list-with-game")!;
    branch.insertAdjacentHTML("afterbegin", `
      <div class="all_game_list">
        <div class="list_title"></div>
        <div class="game-list"><div class="game-empty-state"></div></div>
      </div>
    `);
    const virtual = branch.querySelector<HTMLElement>(".virtual-list")!;
    branch.append(virtual.querySelector<HTMLElement>(".empty")!);
    virtual.setAttribute("aria-hidden", "true");

    const result = readResultState(root);

    expect(result).toMatchObject({ kind: "failure" });
    if (result.kind !== "failure") return;
    expect(result.message).toContain(
      "emptyFingerprint=g=1/1,gp=main,rch=3/2," +
      "rk=div.all_game_list:none|div.virtual-list:a:div.virtual-list|" +
      "div.empty:none,vh=div.all_game_list|div.list_title|div.game-list|" +
      "div.game-empty-state|div.empty,ag=1/1,lt=1/1,gl=1/1," +
      "gch=1/1,gc=0," +
      "glb=none,glp=div.all_game_list,gk=div.game-empty-state," +
      "pv=1/0,pe=1/1,pvb=a:div.virtual-list,peb=none"
    );
  });

  it("does not borrow selected state from an unrelated sibling input", () => {
    const root = loadFixture();
    const wrapper = root.createElement("div");
    wrapper.innerHTML = `
      <input type="checkbox" checked aria-label="另一个选项" />
      <span>QQ</span>
    `;
    root.body.append(wrapper);
    const target = wrapper.querySelector<HTMLElement>("span");
    expect(target).not.toBeNull();
    expect(selectedState(target!)).toEqual({ kind: "unknown" });

    const conflicting = root.createElement("button");
    conflicting.setAttribute("aria-pressed", "true");
    conflicting.innerHTML = '<input type="checkbox" />目标';
    expect(selectedState(conflicting)).toMatchObject({
      kind: "failure",
      code: "structural_drift"
    });

    const ambiguous = root.createElement("label");
    ambiguous.innerHTML = `目标
      <input type="checkbox" /><input type="checkbox" />`;
    expect(selectedState(ambiguous)).toMatchObject({
      kind: "failure",
      code: "structural_drift"
    });
  });

  it("can click an unselected semantic control but requires proof afterward", async () => {
    const root = loadFixture();
    const qq = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "QQ"
    );
    expect(qq).toBeDefined();
    qq?.removeAttribute("aria-pressed");
    installFilterBehavior(root);

    const result = await new PanzhiPageRunner(dependencies(root)).run("quick");

    expect(result.kind).toBe("snapshot");
    expect(qq?.getAttribute("aria-pressed")).toBe("true");
  });

  it("fails closed when controls are missing or selected-state evidence drifts", () => {
    const missingRoot = loadFixture();
    [...missingRoot.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "骇爪-维什戴尔"
    )?.remove();
    expect(locateRequiredControls(missingRoot)).toMatchObject({
      kind: "failure",
      code: "missing_controls"
    });

    const driftRoot = loadFixture();
    installFilterBehavior(driftRoot);
    const located = locateRequiredControls(driftRoot);
    expect(located.kind).toBe("found");
    if (located.kind !== "found") return;
    located.operatorSkinGroup.setAttribute("data-field-id", "changed");
    for (const control of [
      located.qq,
      located.secondRealName,
      ...located.requiredSkins,
      located.allSemantics
    ]) {
      control.setAttribute("aria-pressed", "true");
    }
    located.minPrice.value = "1900";
    located.maxPrice.value = "4000";
    expect(verifyRequiredFilters(driftRoot)).toMatchObject({
      kind: "failure",
      code: "structural_drift"
    });

    const missingGame = loadFixture();
    installFilterBehavior(missingGame);
    missingGame.querySelector("h1")?.remove();
    const missingGameControls = locateRequiredControls(missingGame);
    expect(missingGameControls.kind).toBe("found");
    if (missingGameControls.kind !== "found") return;
    missingGameControls.minPrice.value = "1900";
    missingGameControls.maxPrice.value = "4000";
    for (const control of [
      missingGameControls.qq,
      missingGameControls.secondRealName,
      ...missingGameControls.requiredSkins,
      missingGameControls.allSemantics
    ]) {
      control.setAttribute("aria-pressed", "true");
    }
    expect(verifyRequiredFilters(missingGame)).toMatchObject({
      kind: "failure",
      code: "missing_controls"
    });
  });

  it("reports bounded nearby filter text when a visible field is collapsed", () => {
    const root = loadFixture();
    const skinGroup = root.querySelector<HTMLElement>(
      '[aria-label="特战干员外观"]'
    );
    expect(skinGroup).not.toBeNull();
    skinGroup!.innerHTML = `
      <h2>特战干员外观</h2>
      <button type="button">展开更多</button>
      <span>请选择外观</span>
    `;

    expect(locateRequiredControls(root)).toMatchObject({
      kind: "failure",
      code: "missing_controls",
      message:
        "Missing controls within visible field: 特战干员外观; nearby=特战干员外观 | 展开更多 | 请选择外观"
    });
  });

  it("detects captcha, slider, and login walls from visible semantic markers", () => {
    const captcha = loadFixture("panzhi-captcha-page.html");
    expect(detectVerificationBlocker(captcha)).toMatchObject({
      kind: "blocked",
      blocker: "captcha"
    });

    captcha.querySelector("section")!.innerHTML = `
      <h2>拖动滑块完成验证</h2>
      <div role="slider" aria-label="滑动验证"></div>
    `;
    expect(detectVerificationBlocker(captcha)).toMatchObject({
      kind: "blocked",
      blocker: "slider"
    });

    captcha.querySelector("section")!.innerHTML = `
      <h2>登录后继续</h2>
      <label>密码<input type="password" /></label>
    `;
    expect(detectVerificationBlocker(captcha)).toMatchObject({
      kind: "blocked",
      blocker: "login"
    });
  });

  it("ignores CSS-hidden blockers and cards but rejects CSS-hidden controls", () => {
    const root = loadFixture();
    root.head.insertAdjacentHTML(
      "beforeend",
      "<style>.fixture-hidden { display: none; }</style>"
    );
    root.querySelector("main")?.insertAdjacentHTML(
      "afterbegin",
      `<section class="fixture-hidden" role="dialog">
        <h2>请完成安全验证</h2>
        <p>请输入验证码</p>
      </section>`
    );
    root.querySelector("[aria-label='商品列表']")?.insertAdjacentHTML(
      "beforeend",
      `<a class="fixture-hidden" href="/goodsDetails/SA2CSSHIDDEN/6">
        <h4>CSS 隐藏商品</h4><span>¥ 3000</span>
      </a>`
    );

    expect(detectVerificationBlocker(root)).toEqual({ kind: "clear" });
    const extracted = extractVisibleCards(root);
    expect(extracted.kind).toBe("cards");
    if (extracted.kind !== "cards") return;
    expect(extracted.items.map(({ sourceListingId }) => sourceListingId))
      .toEqual(["SA2VISIBLE1", "SA2VISIBLE2"]);

    const qq = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "QQ"
    );
    qq?.classList.add("fixture-hidden");
    expect(locateRequiredControls(root)).toMatchObject({
      kind: "failure",
      code: "missing_controls"
    });
  });
});

describe("Panzhi page collection runner", () => {
  it("uses an injected quiet-window delay instead of a throttled page timer", async () => {
    const root = loadFixture();
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    controls.minPrice.value = "1900";
    controls.maxPrice.value = "4000";
    for (const control of [
      controls.qq,
      controls.secondRealName,
      ...controls.requiredSkins,
      controls.allSemantics
    ]) {
      control.setAttribute("aria-pressed", "true");
    }
    const quietDelays: number[] = [];
    let reachedCollecting!: () => void;
    const collecting = new Promise<"collecting">((resolve) => {
      reachedCollecting = () => resolve("collecting");
    });
    const run = new PanzhiPageRunner(dependencies(root, {
      resultStabilityMs: 30,
      settlementDelay: (milliseconds: number) => {
        quietDelays.push(milliseconds);
        return milliseconds === 30
          ? Promise.resolve()
          : new Promise<void>(() => undefined);
      },
      onStage: async (stage) => {
        if (stage === "collecting") reachedCollecting();
      }
    })).run("quick");

    const raced = await Promise.race([
      collecting,
      new Promise<"page-timer">((resolve) =>
        setTimeout(() => resolve("page-timer"), 10))
    ]);

    expect(raced).toBe("collecting");
    expect(quietDelays).toContain(30);
    await run;
  });

  it("uses the injected delay for action timeouts in a background tab", async () => {
    const root = loadFixture();
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    controls.minPrice.value = "1900";
    controls.maxPrice.value = "4000";
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener("click", () => {
        button.setAttribute("aria-pressed", "true");
      });
    }
    const delays: number[] = [];

    const result = await new PanzhiPageRunner(dependencies(root, {
      mutationTimeoutMs: 25,
      settlementDelay: async (milliseconds) => {
        delays.push(milliseconds);
      }
    })).run("quick");

    expect(result).toMatchObject({
      kind: "failure",
      code: "operation_timeout",
      stage: "applying_filters"
    });
    expect(delays).toContain(25);
  });

  it("waits for a quiet window after a same-id price update", async () => {
    const root = loadFixture();
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    controls.minPrice.value = "1900";
    controls.maxPrice.value = "4000";
    for (const control of [
      controls.qq,
      controls.secondRealName,
      ...controls.requiredSkins,
      controls.allSemantics
    ]) {
      control.setAttribute("aria-pressed", "true");
    }
    const list = root.querySelector<HTMLElement>("[aria-label='商品列表']")!;
    const visiblePrice = root.querySelector<HTMLElement>(
      "a[href*='SA2VISIBLE1'] span:not(.fixture-old-price)"
    )!;
    let priceChangedAt = 0;
    let collectingAt = 0;
    list.setAttribute("aria-busy", "true");
    setTimeout(() => list.setAttribute("aria-busy", "false"), 0);
    setTimeout(() => {
      visiblePrice.textContent = "¥ 3888";
      priceChangedAt = Date.now();
    }, 15);

    const result = await new PanzhiPageRunner(dependencies(root, {
      mutationTimeoutMs: 1_000,
      resultStabilityMs: 30,
      loadMore: async () => {
        for (let index = 0; index < 58; index += 1) {
          appendCard(root, `SA2QUIET${String(index).padStart(2, "0")}`);
        }
      },
      onStage: async (stage) => {
        if (stage === "collecting") collectingAt = Date.now();
      }
    })).run("quick");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot.items.find(
      ({ sourceListingId }) => sourceListingId === "SA2VISIBLE1"
    )?.priceCny).toBe(3888);
    expect(priceChangedAt).toBeGreaterThan(0);
    expect(collectingAt - priceChangedAt).toBeGreaterThanOrEqual(24);
  });

  it("waits for preselected filters to become idle before initializing cards", async () => {
    const root = loadFixture();
    const controls = locateRequiredControls(root);
    expect(controls.kind).toBe("found");
    if (controls.kind !== "found") return;
    controls.minPrice.value = "1900";
    controls.maxPrice.value = "4000";
    for (const control of [
      controls.qq,
      controls.secondRealName,
      ...controls.requiredSkins,
      controls.allSemantics
    ]) {
      control.setAttribute("aria-pressed", "true");
    }
    const list = root.querySelector<HTMLElement>("[aria-label='商品列表']")!;
    list.setAttribute("aria-busy", "true");
    setTimeout(() => {
      for (const stale of list.querySelectorAll("a[href*='SA2VISIBLE1']")) {
        stale.remove();
      }
      appendCard(root, "SA2FRESH");
      list.setAttribute("aria-busy", "false");
    }, 3);

    const result = await new PanzhiPageRunner(dependencies(root, {
      mutationTimeoutMs: 500,
      resultStabilityMs: 4
    })).run("quick");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    const ids = result.snapshot.items.map(({ sourceListingId }) => sourceListingId);
    expect(ids).toContain("SA2FRESH");
    expect(ids).not.toContain("SA2VISIBLE1");
  });

  it("ignores unrelated mutations and waits for delayed result completion", async () => {
    const unrelated = loadFixture();
    const unrelatedControls = locateRequiredControls(unrelated);
    expect(unrelatedControls.kind).toBe("found");
    if (unrelatedControls.kind !== "found") return;
    unrelatedControls.minPrice.value = "1900";
    unrelatedControls.maxPrice.value = "4000";
    for (const button of unrelated.querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener("click", () => {
        button.setAttribute("aria-pressed", "true");
        unrelated.querySelector("h1")?.setAttribute("data-noise", "changed");
      });
    }
    expect(
      await new PanzhiPageRunner(dependencies(unrelated)).run("quick")
    ).toMatchObject({
      kind: "failure",
      code: "operation_timeout",
      stage: "applying_filters"
    });

    const delayed = loadFixture();
    let appended = false;
    for (const button of delayed.querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener("click", () => {
        button.setAttribute("aria-pressed", "true");
        delayed.querySelector("h1")?.setAttribute("data-noise", "changed");
        signalResultCycle(delayed, () => {
          if (!appended) {
            appendCard(delayed, "SA2DELAYED");
            appended = true;
          }
        }, 3);
      });
    }
    for (const input of delayed.querySelectorAll<HTMLInputElement>(
      'input[placeholder="最低值"], input[placeholder="最高值"]'
    )) {
      input.addEventListener("input", () => signalResultCycle(delayed, undefined, 3));
    }
    const delayedResult = await new PanzhiPageRunner(dependencies(delayed, {
      mutationTimeoutMs: 500,
      resultStabilityMs: 4
    })).run("quick");
    expect(delayedResult.kind).toBe("snapshot");
    if (delayedResult.kind !== "snapshot") return;
    expect(delayedResult.snapshot.items.map(({ sourceListingId }) => sourceListingId))
      .toContain("SA2DELAYED");
  });

  it("stops quick mode at six observations and sixty unique cards", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let load = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
      mutationTimeoutMs: 1_000,
      loadMore: async () => {
        load += 1;
        for (let index = 0; index < 12; index += 1) {
          appendCard(root, `SA2Q${load}${String(index).padStart(2, "0")}`);
        }
      }
    })).run("quick");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot.mode).toBe("quick");
    expect(result.snapshot.stopReason).toBe("quick_window");
    expect(result.snapshot.loadActionCount).toBe(6);
    expect(result.snapshot.observedUniqueCount).toBe(60);
    expect(result.snapshot.items).toHaveLength(60);
  });

  it("submits a strict empty quick result without forcing another load", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(root);
    installLiveFilterBehavior(root);
    const loadMore = vi.fn(async () => signalResultCycle(root));

    const result = await new PanzhiPageRunner(dependencies(root, {
      loadMore
    })).run("quick");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot).toMatchObject({
      mode: "quick",
      loadActionCount: 1,
      observedUniqueCount: 0,
      stopReason: "empty_result",
      items: []
    });
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("lets verification blockers take priority over a strict empty result", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(root);
    root.body.insertAdjacentHTML("beforeend", "<div>请输入验证码</div>");

    await expect(new PanzhiPageRunner(dependencies(root)).run("quick"))
      .resolves.toEqual({
        kind: "awaiting_user_verification",
        stage: "awaiting_user_verification",
        blocker: "captcha",
        resumeStage: "applying_filters"
      });
  });

  it("fails closed if the strict empty proof changes before submission", async () => {
    const root = loadFixture("panzhi-live-filter-page.html");
    replaceLiveResultsWithStrictEmpty(root);
    installLiveFilterBehavior(root);

    const result = await new PanzhiPageRunner(dependencies(root, {
      onStage: async (stage) => {
        if (stage === "submitting") {
          root.querySelector<HTMLElement>(".empty")?.classList.remove("empty");
        }
      }
    })).run("quick");

    expect(result).toMatchObject({
      kind: "failure",
      stage: "collecting"
    });
  });

  it("stops deep mode after two consecutive no-growth observations", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
      loadMore: async () => {
        loads += 1;
        signalResultCycle(root);
      }
    })).run("deep");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(loads).toBe(2);
    expect(result.snapshot.loadActionCount).toBe(3);
    expect(result.snapshot.stopReason).toBe("no_growth_twice");
    expect(result.snapshot.observedUniqueCount).toBe(2);
  });

  it("does not count unrelated load mutations as no-growth observations", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
      loadMore: async () => {
        loads += 1;
        root.querySelector("h1")?.setAttribute("data-load-noise", `${loads}`);
      }
    })).run("deep");

    expect(loads).toBe(1);
    expect(result).toMatchObject({
      kind: "failure",
      code: "operation_timeout",
      stage: "collecting",
      loadActionCount: 2
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("fails closed at the deep load cap rather than claiming a natural end", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
      mutationTimeoutMs: 1_000,
      loadMore: async () => {
        loads += 1;
        appendCard(root, `SA2DEEP${loads}`);
      }
    })).run("deep");

    expect(loads).toBe(99);
    expect(result).toMatchObject({
      kind: "failure",
      code: "collection_limit",
      loadActionCount: 100
    });
  }, 25_000);

  it("never returns a snapshot while verification is visible", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const stages: string[] = [];
    const runner = new PanzhiPageRunner(dependencies(root, {
      loadMore: async () => {
        loads += 1;
        if (loads === 1) {
          root.body.insertAdjacentHTML(
            "afterbegin",
            `<section role="dialog" aria-label="安全验证">
              <h2>请完成安全验证</h2>
              <p>请输入验证码</p>
            </section>`
          );
        } else {
          signalResultCycle(root);
        }
      },
      onStage: async (stage) => {
        stages.push(stage);
      }
    }));

    const blocked = await runner.run("quick");
    expect(blocked).toMatchObject({
      kind: "awaiting_user_verification",
      blocker: "captcha",
      resumeStage: "applying_filters"
    });
    expect(blocked).not.toHaveProperty("snapshot");

    root.querySelector("[role='dialog']")?.remove();
    stages.length = 0;
    const resumed = await runner.run("quick");
    expect(stages[0]).toBe("applying_filters");
    expect(resumed.kind).toBe("snapshot");
  });

  it("prioritizes a blocker that appears while a filter click is settling", async () => {
    const root = loadFixture();
    installFilterBehavior(root, ["QQ"]);
    const qq = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "QQ"
    );
    expect(qq).toBeDefined();
    qq?.addEventListener("click", () => {
      queueMicrotask(() => {
        root.body.insertAdjacentHTML(
          "afterbegin",
          `<section role="dialog" aria-label="安全验证">
            <h2>拖动滑块完成验证</h2>
            <div role="slider" aria-label="滑动验证"></div>
          </section>`
        );
      });
    });

    const result = await new PanzhiPageRunner(dependencies(root)).run("quick");

    expect(result).toMatchObject({
      kind: "awaiting_user_verification",
      blocker: "slider",
      resumeStage: "applying_filters"
    });
    expect(result).not.toHaveProperty("snapshot");

    const priceRoot = loadFixture();
    installFilterBehavior(priceRoot);
    priceRoot.querySelector<HTMLInputElement>(
      'input[placeholder="最低值"]'
    )?.addEventListener("input", () => {
      queueMicrotask(() => {
        priceRoot.body.insertAdjacentHTML(
          "afterbegin",
          `<section role="dialog"><h2>登录后继续</h2>
            <label>密码<input type="password" /></label></section>`
        );
      });
    });
    const priceBlocked = await new PanzhiPageRunner(
      dependencies(priceRoot)
    ).run("quick");
    expect(priceBlocked).toMatchObject({
      kind: "awaiting_user_verification",
      blocker: "login",
      resumeStage: "applying_filters"
    });
  });

  it("fails closed at the deep five-hundred-card cap", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
      mutationTimeoutMs: 1_000,
      loadMore: async () => {
        loads += 1;
        for (let index = 0; index < 498; index += 1) {
          appendCard(root, `SA2CAP${String(index).padStart(3, "0")}`);
        }
      }
    })).run("deep");

    expect(loads).toBe(1);
    expect(result).toMatchObject({
      kind: "failure",
      code: "collection_limit",
      loadActionCount: 2
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("rejects a catalog URL that drifts during collection", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let drifted = false;
    const result = await new PanzhiPageRunner(dependencies(root, {
      currentUrl: () => drifted
        ? "https://www.pzds.com/goodsList/391/6?unexpected=1"
        : "https://www.pzds.com/goodsList/391/6",
      loadMore: async () => {
        drifted = true;
        signalResultCycle(root);
      }
    })).run("quick");

    expect(result).toMatchObject({
      kind: "failure",
      code: "structural_drift",
      stage: "collecting"
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("returns typed failures for a missing page contract and malformed cards", async () => {
    const missing = loadFixture();
    [...missing.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "QQ"
    )?.remove();
    expect(await new PanzhiPageRunner(dependencies(missing)).run("quick"))
      .toMatchObject({ kind: "failure", code: "missing_controls" });

    const drift = loadFixture();
    installFilterBehavior(drift);
    drift.querySelector(
      "a[href*='SA2VISIBLE1'] span:not(.fixture-old-price)"
    )!.textContent = "价格面议";
    expect(await new PanzhiPageRunner(dependencies(drift)).run("quick"))
      .toMatchObject({ kind: "failure", code: "structural_drift" });
  });

  it("rechecks verification after announcing submission", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    const stages: string[] = [];
    const result = await new PanzhiPageRunner(dependencies(root, {
      onStage: async (stage) => {
        stages.push(stage);
        if (stage === "submitting") {
          root.body.insertAdjacentHTML(
            "afterbegin",
            `<section role="dialog"><h2>请完成安全验证</h2>
              <p>请输入验证码</p></section>`
          );
        }
      }
    })).run("quick");

    expect(stages.slice(-2)).toEqual([
      "submitting",
      "awaiting_user_verification"
    ]);
    expect(result).toMatchObject({
      kind: "awaiting_user_verification",
      blocker: "captcha",
      resumeStage: "applying_filters"
    });
    expect(result).not.toHaveProperty("snapshot");
  });
});
