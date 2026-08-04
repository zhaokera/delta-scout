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

function installFilterBehavior(root: Document): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", "true");
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
    loadMore: async () => undefined,
    mutationTimeoutMs: 25,
    onStage: async () => undefined,
    ...overrides
  };
}

describe("Panzhi visible-page selectors", () => {
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
  it("stops quick mode at six observations and sixty unique cards", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let load = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
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

  it("stops deep mode after two consecutive no-growth observations", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
      loadMore: async () => {
        loads += 1;
      }
    })).run("deep");

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(loads).toBe(2);
    expect(result.snapshot.loadActionCount).toBe(3);
    expect(result.snapshot.stopReason).toBe("no_growth_twice");
    expect(result.snapshot.observedUniqueCount).toBe(2);
  });

  it("fails closed at the deep load cap rather than claiming a natural end", async () => {
    const root = loadFixture();
    installFilterBehavior(root);
    let loads = 0;
    const result = await new PanzhiPageRunner(dependencies(root, {
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
  });

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
    const qq = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "QQ"
    );
    expect(qq).toBeDefined();
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
      if (button === qq) continue;
      button.addEventListener("click", () => {
        button.setAttribute("aria-pressed", "true");
      });
    }
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
    drift.querySelector("a[href*='SA2VISIBLE1'] span")!.textContent = "价格面议";
    expect(await new PanzhiPageRunner(dependencies(drift)).run("quick"))
      .toMatchObject({ kind: "failure", code: "structural_drift" });
  });
});
