import {
  PANZHI_REQUIRED_OPERATOR_SKINS,
  type PageRunnerFailureCode,
  type PanzhiSnapshotItem,
  type VerificationBlocker
} from "./contracts.js";

export interface SelectorFailure {
  kind: "failure";
  code: Extract<
    PageRunnerFailureCode,
    "missing_controls" | "structural_drift"
  >;
  message: string;
}

export interface RequiredControls {
  kind: "found";
  qq: HTMLElement;
  secondRealName: HTMLElement;
  requiredSkins: [HTMLElement, HTMLElement];
  allSemantics: HTMLElement;
  operatorSkinGroup: HTMLElement;
  minPrice: HTMLInputElement;
  maxPrice: HTMLInputElement;
}

export interface VerifiedFilters {
  kind: "verified";
}

export interface ExtractedCards {
  kind: "cards";
  items: PanzhiSnapshotItem[];
}

export type SelectedStateResult =
  | { kind: "selected-state"; selected: boolean }
  | { kind: "unknown" }
  | SelectorFailure;

export interface ResultContainer {
  kind: "result-container";
  element: HTMLElement;
}

export interface ResultState {
  kind: "result-state";
  signature: string;
  visibleIds: string[];
  loadingVisible: boolean;
  endMarkerVisible: boolean;
  emptyResultVisible: boolean;
}

export type VerificationDetection =
  | { kind: "clear" }
  | { kind: "blocked"; blocker: VerificationBlocker };

const SELECTION_ATTRIBUTES = [
  "aria-selected",
  "aria-pressed",
  "aria-checked",
  "data-selected",
  "data-checked"
] as const;

const SELECTED_CLASS_TOKENS = new Set([
  "active",
  "checked",
  "is-active",
  "is-checked",
  "is-selected",
  "opt-item_active",
  "selected"
]);

function failure(
  code: SelectorFailure["code"],
  message: string
): SelectorFailure {
  return { kind: "failure", code, message };
}

export function normalizeVisibleText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isElementVisible(
  element: Element,
  cache: WeakMap<Element, boolean> = new WeakMap()
): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  let visible =
    !element.hasAttribute("hidden") &&
    element.getAttribute("aria-hidden") !== "true";
  if (visible && element instanceof HTMLElement) {
    const computedStyle = element.ownerDocument.defaultView
      ?.getComputedStyle(element);
    visible =
      element.style.display !== "none" &&
      element.style.visibility !== "hidden" &&
      computedStyle?.display !== "none" &&
      computedStyle?.visibility !== "hidden" &&
      computedStyle?.visibility !== "collapse";
  }
  if (visible && element.parentElement) {
    visible = isElementVisible(element.parentElement, cache);
  }
  cache.set(element, visible);
  return visible;
}

function exactTextElements(root: ParentNode, label: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter((element) => {
    if (normalizeVisibleText(element.textContent) !== label) return false;
    if (!isElementVisible(element)) return false;
    return ![...element.children].some(
      (child) =>
        isElementVisible(child) &&
        normalizeVisibleText(child.textContent) === label
    );
  });
}

function uniqueTextControl(
  root: ParentNode,
  label: string
): HTMLElement | SelectorFailure {
  const matches = new Set(
    exactTextElements(root, label).map((element) =>
      element.closest<HTMLElement>(".opt-item") ?? element)
  );
  if (matches.size === 0) {
    return failure("missing_controls", `Missing visible control: ${label}`);
  }
  if (matches.size !== 1) {
    return failure("structural_drift", `Ambiguous visible control: ${label}`);
  }
  return [...matches][0];
}

function uniqueSearchTypeControl(
  root: HTMLElement,
  label: string
): HTMLElement | SelectorFailure {
  const matches = new Set<HTMLElement>();
  for (const chooser of root.querySelectorAll<HTMLElement>(
    ".filter-item-checkbox"
  )) {
    if (!isElementVisible(chooser)) continue;
    for (const option of chooser.querySelectorAll<HTMLElement>(".drop-item")) {
      const optionLabel = option.querySelector("label");
      if (normalizeVisibleText(optionLabel?.textContent) === label) {
        matches.add(option);
      }
    }
  }
  if (matches.size === 0) return uniqueTextControl(root, label);
  if (matches.size !== 1) {
    return failure("structural_drift", `Ambiguous visible control: ${label}`);
  }
  return [...matches][0];
}

function nearbyVisibleText(field: HTMLElement): string {
  let container = field.parentElement;
  for (let depth = 0; container && depth < 4; depth += 1) {
    const texts: string[] = [];
    for (const element of container.querySelectorAll<HTMLElement>("*")) {
      if (!isElementVisible(element)) continue;
      const text = normalizeVisibleText(element.textContent);
      if (!text || text.length > 80) continue;
      const hasVisibleTextChild = [...element.children].some((child) =>
        isElementVisible(child) && normalizeVisibleText(child.textContent) !== ""
      );
      if (hasVisibleTextChild || texts.includes(text)) continue;
      texts.push(text);
      if (texts.length === 12) break;
    }
    if (texts.length > 1) return texts.join(" | ").slice(0, 320);
    container = container.parentElement;
  }
  return normalizeVisibleText(field.textContent).slice(0, 80);
}

function smallestGroup(
  root: Document,
  fieldLabel: string,
  requiredLabels: string[],
  requiredPlaceholders: string[] = []
): HTMLElement | SelectorFailure {
  const fieldLabels = exactTextElements(root, fieldLabel);
  if (fieldLabels.length === 0) {
    return failure("missing_controls", `Missing visible field: ${fieldLabel}`);
  }

  const groups = new Set<HTMLElement>();
  for (const field of fieldLabels) {
    let candidate = field.parentElement;
    while (candidate && candidate !== root.body.parentElement) {
      const hasLabels = requiredLabels.every(
        (label) => exactTextElements(candidate!, label).length === 1
      );
      const hasInputs = requiredPlaceholders.every(
        (placeholder) =>
          candidate!.querySelectorAll(`input[placeholder="${placeholder}"]`)
            .length === 1
      );
      if (hasLabels && hasInputs) {
        groups.add(candidate);
        break;
      }
      candidate = candidate.parentElement;
    }
  }

  if (groups.size === 0) {
    const nearby = fieldLabels.map(nearbyVisibleText)
      .filter((text, index, all) => text !== "" && all.indexOf(text) === index)
      .join(" || ")
      .slice(0, 320);
    return failure(
      "missing_controls",
      `Missing controls within visible field: ${fieldLabel}` +
        (nearby ? `; nearby=${nearby}` : "")
    );
  }
  const smallestGroups = [...groups].filter(
    (group) =>
      ![...groups].some(
        (other) => other !== group && group.contains(other)
      )
  );
  if (smallestGroups.length !== 1) {
    return failure("structural_drift", `Ambiguous field structure: ${fieldLabel}`);
  }
  return smallestGroups[0];
}

function assertOptionalAttribute(
  element: Element,
  attribute: string,
  expected: string,
  description: string
): SelectorFailure | null {
  const actual = element.getAttribute(attribute);
  if (actual !== null && actual !== expected) {
    return failure(
      "structural_drift",
      `${description} changed from ${expected} to ${actual}`
    );
  }
  return null;
}

export function locateRequiredControls(
  root: Document
): RequiredControls | SelectorFailure {
  const accountGroup = smallestGroup(root, "账号类型", ["QQ"]);
  if ("kind" in accountGroup) return accountGroup;
  const realNameGroup = smallestGroup(root, "实名情况", ["可二次实名"]);
  if ("kind" in realNameGroup) return realNameGroup;
  const skinGroup = smallestGroup(root, "特战干员外观", [
    PANZHI_REQUIRED_OPERATOR_SKINS[0].label,
    PANZHI_REQUIRED_OPERATOR_SKINS[1].label
  ]);
  if ("kind" in skinGroup) return skinGroup;
  const priceGroup = smallestGroup(
    root,
    "价格",
    [],
    ["最低值", "最高值"]
  );
  if ("kind" in priceGroup) return priceGroup;

  for (const [attribute, expected] of [
    ["data-field-id", "22858"],
    ["data-field-type", "CHECKBOX"],
    ["data-mapping-field", "22858"]
  ] as const) {
    const mismatch = assertOptionalAttribute(
      skinGroup,
      attribute,
      expected,
      "Operator skin field"
    );
    if (mismatch) return mismatch;
  }

  const qq = uniqueTextControl(accountGroup, "QQ");
  if ("kind" in qq) return qq;
  const secondRealName = uniqueTextControl(realNameGroup, "可二次实名");
  if ("kind" in secondRealName) return secondRealName;
  const firstSkin = uniqueTextControl(
    skinGroup,
    PANZHI_REQUIRED_OPERATOR_SKINS[0].label
  );
  if ("kind" in firstSkin) return firstSkin;
  const secondSkin = uniqueTextControl(
    skinGroup,
    PANZHI_REQUIRED_OPERATOR_SKINS[1].label
  );
  if ("kind" in secondSkin) return secondSkin;
  const allSemantics = uniqueSearchTypeControl(skinGroup, "全部都要有");
  if ("kind" in allSemantics) return allSemantics;

  for (const [element, expected] of [
    [firstSkin, PANZHI_REQUIRED_OPERATOR_SKINS[0]],
    [secondSkin, PANZHI_REQUIRED_OPERATOR_SKINS[1]]
  ] as const) {
    const idMismatch = assertOptionalAttribute(
      element,
      "data-option-id",
      expected.optionId,
      expected.label
    );
    if (idMismatch) return idMismatch;
    const codeMismatch = assertOptionalAttribute(
      element,
      "data-metadata-code",
      expected.metadataCode,
      expected.label
    );
    if (codeMismatch) return codeMismatch;
  }
  const searchTypeMismatch = assertOptionalAttribute(
    allSemantics,
    "data-search-type",
    "ALL",
    "Operator skin conjunction"
  );
  if (searchTypeMismatch) return searchTypeMismatch;

  const minPrices = priceGroup.querySelectorAll<HTMLInputElement>(
    'input[placeholder="最低值"]'
  );
  const maxPrices = priceGroup.querySelectorAll<HTMLInputElement>(
    'input[placeholder="最高值"]'
  );
  if (minPrices.length !== 1 || maxPrices.length !== 1) {
    return failure("structural_drift", "Ambiguous Panzhi price inputs");
  }

  return {
    kind: "found",
    qq,
    secondRealName,
    requiredSkins: [firstSkin, secondSkin],
    allSemantics,
    operatorSkinGroup: skinGroup,
    minPrice: minPrices[0],
    maxPrice: maxPrices[0]
  };
}

function booleanAttribute(value: string | null): boolean | null {
  if (value === null) return null;
  if (["true", "1", "checked", "selected", "active"].includes(value)) {
    return true;
  }
  if (["false", "0", "unchecked", "unselected", "inactive"].includes(value)) {
    return false;
  }
  return null;
}

function isSelectableInput(element: Element): element is HTMLInputElement {
  return element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio");
}

function interactiveCarrier(element: HTMLElement): HTMLElement | null {
  const selector = [
    ".opt-item",
    ".drop-item",
    "button",
    "label",
    'input[type="checkbox"]',
    'input[type="radio"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="option"]',
    "[aria-selected]",
    "[aria-pressed]",
    "[aria-checked]",
    "[data-selected]",
    "[data-checked]"
  ].join(",");
  return element.closest<HTMLElement>(selector);
}

function directText(element: HTMLElement): string {
  return normalizeVisibleText(
    [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? "")
      .join(" ")
  );
}

function searchTypeSelectionEvidence(element: HTMLElement): boolean | null {
  const option = element.closest<HTMLElement>(".drop-item");
  const chooser = option?.closest<HTMLElement>(".filter-item-checkbox");
  const label = option?.querySelector("label");
  const current = chooser ? directText(chooser) : "";
  const expected = normalizeVisibleText(label?.textContent);
  return current && expected ? current === expected : null;
}

function associatedInputs(
  element: HTMLElement,
  carrier: HTMLElement | null
): HTMLInputElement[] | SelectorFailure {
  const inputs = new Set<HTMLInputElement>();
  for (const candidate of new Set([element, carrier].filter(
    (value): value is HTMLElement => value !== null
  ))) {
    if (isSelectableInput(candidate)) inputs.add(candidate);
    for (const input of candidate.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"], input[type="radio"]'
    )) {
      inputs.add(input);
    }
  }

  const label = carrier instanceof HTMLLabelElement
    ? carrier
    : element.closest<HTMLLabelElement>("label");
  if (label) {
    if (label.htmlFor) {
      const target = element.ownerDocument.getElementById(label.htmlFor);
      if (!target || !isSelectableInput(target)) {
        return failure("structural_drift", "Filter label association drifted");
      }
      inputs.add(target);
    } else if (label.control && isSelectableInput(label.control)) {
      inputs.add(label.control);
    }
  }

  if (inputs.size > 1) {
    return failure("structural_drift", "Filter control has ambiguous inputs");
  }
  return [...inputs];
}

function directSelectionEvidence(element: HTMLElement): boolean[] {
  const evidence: boolean[] = [];
  if (isSelectableInput(element)) evidence.push(element.checked);
  for (const attribute of SELECTION_ATTRIBUTES) {
    const state = booleanAttribute(element.getAttribute(attribute));
    if (state !== null) evidence.push(state);
  }
  const dataState = booleanAttribute(element.getAttribute("data-state"));
  if (dataState !== null) evidence.push(dataState);
  if ([...element.classList].some((token) => SELECTED_CLASS_TOKENS.has(token))) {
    evidence.push(true);
  }
  return evidence;
}

export function selectedState(element: HTMLElement): SelectedStateResult {
  const carrier = interactiveCarrier(element);
  const inputs = associatedInputs(element, carrier);
  if (!Array.isArray(inputs)) return inputs;

  const evidence: boolean[] = [];
  for (const candidate of new Set([element, carrier].filter(
    (value): value is HTMLElement => value !== null
  ))) {
    evidence.push(...directSelectionEvidence(candidate));
  }
  const searchTypeState = searchTypeSelectionEvidence(element);
  if (searchTypeState !== null) evidence.push(searchTypeState);
  if (inputs.length === 1) evidence.push(inputs[0].checked);
  if (new Set(evidence).size > 1) {
    return failure("structural_drift", "Filter selected-state evidence conflicts");
  }
  return evidence.length === 0
    ? { kind: "unknown" }
    : { kind: "selected-state", selected: evidence[0] };
}

export function verifyRequiredFilters(
  root: Document
): VerifiedFilters | SelectorFailure {
  if (exactTextElements(root, "三角洲行动").length === 0) {
    return failure("missing_controls", "Missing Panzhi game label: 三角洲行动");
  }
  const controls = locateRequiredControls(root);
  if (controls.kind === "failure") return controls;

  if (controls.minPrice.value !== "1900" || controls.maxPrice.value !== "4000") {
    return failure("structural_drift", "Panzhi price range is not 1900-4000");
  }
  for (const [label, control] of [
    ["QQ", controls.qq],
    ["可二次实名", controls.secondRealName],
    [PANZHI_REQUIRED_OPERATOR_SKINS[0].label, controls.requiredSkins[0]],
    [PANZHI_REQUIRED_OPERATOR_SKINS[1].label, controls.requiredSkins[1]],
    ["全部都要有", controls.allSemantics]
  ] as const) {
    const state = selectedState(control);
    if (state.kind === "failure") return state;
    if (state.kind === "unknown") {
      return failure(
        "structural_drift",
        `No selected-state evidence for ${label}`
      );
    }
    if (!state.selected) {
      return failure("structural_drift", `Required filter is not selected: ${label}`);
    }
  }

  return { kind: "verified" };
}

function visibleTextContains(root: Document, pattern: RegExp): boolean {
  return [...root.querySelectorAll<HTMLElement>("body *")].some((element) => {
    if (!pattern.test(normalizeVisibleText(element.textContent))) return false;
    if (
      [...element.children].some((child) =>
        pattern.test(normalizeVisibleText(child.textContent))
      )
    ) {
      return false;
    }
    return isElementVisible(element);
  });
}

export function detectVerificationBlocker(
  root: Document
): VerificationDetection {
  const passwordInput = root.querySelector<HTMLInputElement>('input[type="password"]');
  if (
    (passwordInput && isElementVisible(passwordInput)) ||
    visibleTextContains(root, /登录后(?:继续|查看|操作)|请先登录|账号登录/)
  ) {
    return { kind: "blocked", blocker: "login" };
  }
  const visibleSlider = [...root.querySelectorAll<HTMLElement>('[role="slider"]')]
    .some((element) => isElementVisible(element));
  if (
    visibleSlider ||
    visibleTextContains(root, /拖动滑块|滑动验证|完成拼图/)
  ) {
    return { kind: "blocked", blocker: "slider" };
  }
  if (
    visibleTextContains(
      root,
      /请完成安全验证|图形验证码|请输入验证码|人机验证|访问验证/
    )
  ) {
    return { kind: "blocked", blocker: "captcha" };
  }
  return { kind: "clear" };
}

function cardIdentity(anchor: HTMLAnchorElement): string | null {
  const rawHref = anchor.getAttribute("href");
  if (!rawHref) return null;
  try {
    const parsed = new URL(rawHref, "https://www.pzds.com");
    const path = parsed.pathname.match(
      /^\/goodsDetails\/([A-Za-z0-9_-]{1,80})\/6\/?$/
    );
    return parsed.origin === "https://www.pzds.com" && path ? path[1] : null;
  } catch {
    return null;
  }
}

function visibleCardAnchors(
  root: ParentNode,
  cache: WeakMap<Element, boolean> = new WeakMap()
): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/goodsDetails/"]'
  )].filter(
    (anchor) => isElementVisible(anchor, cache) && cardIdentity(anchor) !== null
  );
}

function resultLoadingVisible(element: HTMLElement): boolean {
  return element.getAttribute("aria-busy") === "true" ||
    [...element.querySelectorAll<HTMLElement>(
      '[aria-busy="true"], [data-loading="true"], [role="status"]'
    )].some((candidate) =>
      isElementVisible(candidate) &&
      (candidate.getAttribute("aria-busy") === "true" ||
        candidate.getAttribute("data-loading") === "true" ||
        /加载中|正在加载/.test(normalizeVisibleText(candidate.textContent)))
    );
}

function strictEmptyResultContainer(root: Document): HTMLElement | null {
  const visibility = new WeakMap<Element, boolean>();
  const branches = [...root.querySelectorAll<HTMLElement>(
    ".goods-list-with-game"
  )].filter((element) => isElementVisible(element, visibility));
  if (branches.length !== 1) return null;

  const branch = branches[0];
  const virtualLists = [...branch.querySelectorAll<HTMLElement>(
    ".virtual-list"
  )];
  if (
    virtualLists.length !== 1 ||
    !isElementVisible(virtualLists[0], visibility)
  ) return null;
  const virtualList = virtualLists[0];

  for (const selector of [
    ".virtual-list-phantom",
    ".virtual-list-container"
  ]) {
    const matches = [...virtualList.querySelectorAll<HTMLElement>(selector)];
    if (
      matches.length !== 1 ||
      !isElementVisible(matches[0], visibility)
    ) return null;
  }

  const emptyMarkers = [...virtualList.querySelectorAll<HTMLElement>(".empty")];
  if (
    emptyMarkers.length !== 1 ||
    !isElementVisible(emptyMarkers[0], visibility) ||
    virtualList.querySelectorAll('a[href*="/goodsDetails/"]').length !== 0
  ) return null;
  if (branch.querySelectorAll('a[href*="/goodsDetails/"]').length !== 0) {
    return null;
  }
  return branch;
}

function emptyFingerprintDiagnostic(root: Document): string {
  const visibility = new WeakMap<Element, boolean>();
  const counts = (scope: ParentNode, selector: string): string => {
    const elements = [...scope.querySelectorAll<HTMLElement>(selector)];
    const visible = elements.filter((element) =>
      isElementVisible(element, visibility)
    ).length;
    return `${elements.length}/${visible}`;
  };
  const goods = [...root.querySelectorAll<HTMLElement>(
    ".goods-list-with-game"
  )];
  const visibleGoods = goods.filter((element) =>
    isElementVisible(element, visibility)
  );
  const branch = visibleGoods.length === 1 ? visibleGoods[0] : null;
  const virtuals = branch
    ? [...branch.querySelectorAll<HTMLElement>(".virtual-list")]
    : [];
  const virtual = virtuals.length === 1 ? virtuals[0] : null;
  return [
    `goods=${counts(root, ".goods-list-with-game")}`,
    `virtual=${branch ? counts(branch, ".virtual-list") : "0/0"}`,
    `phantom=${virtual ? counts(virtual, ".virtual-list-phantom") : "0/0"}`,
    `container=${virtual ? counts(virtual, ".virtual-list-container") : "0/0"}`,
    `emptyVirtual=${virtual ? counts(virtual, ".empty") : "0/0"}`,
    `emptyBranch=${branch ? counts(branch, ".empty") : "0/0"}`,
    `cardsBranch=${branch
      ? branch.querySelectorAll('a[href*="/goodsDetails/"]').length
      : 0}`,
    `loadingBranch=${branch ? resultLoadingVisible(branch) : false}`
  ].join(",");
}

function smallestUniqueContainer(
  candidates: Set<HTMLElement>
): HTMLElement | null {
  const smallest = [...candidates].filter(
    (candidate) =>
      ![...candidates].some(
        (other) => other !== candidate && candidate.contains(other)
      )
  );
  return smallest.length === 1 ? smallest[0] : null;
}

function missingResultDiagnostic(
  root: Document,
  visibleCanonicalLinks: number,
  explicitCandidates: number
): string {
  const allLinks = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")];
  const goodsDetailLinks = allLinks.filter((anchor) =>
    anchor.getAttribute("href")?.includes("/goodsDetails/")
  );
  const canonicalLinks = goodsDetailLinks.filter(
    (anchor) => cardIdentity(anchor) !== null
  );
  const samplePaths = allLinks
    .map((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href) return null;
      try {
        const pathname = new URL(href, "https://www.pzds.com").pathname;
        return /goods.*detail/i.test(pathname) ? pathname : null;
      } catch {
        return null;
      }
    })
    .filter((pathname): pathname is string => pathname !== null)
    .filter((pathname, index, paths) => paths.indexOf(pathname) === index)
    .slice(0, 5);
  const actionLabels = new Set([
    "查询",
    "搜索",
    "筛选",
    "立即筛选",
    "确定",
    "确认",
    "刷新",
    "重试",
    "加载更多",
    "查看更多"
  ]);
  const actionHints = [...root.querySelectorAll<HTMLElement>(
    'button,[role="button"]'
  )]
    .filter((element) => isElementVisible(element))
    .map((element) => normalizeVisibleText(element.textContent))
    .filter((label) => actionLabels.has(label))
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 5);
  const statusLabels = new Set([
    "暂无数据",
    "暂无商品",
    "暂无相关商品",
    "加载中",
    "加载失败",
    "网络异常",
    "请稍后重试"
  ]);
  const statusHints = [...root.querySelectorAll<HTMLElement>("body *")]
    .filter((element) => isElementVisible(element))
    .map((element) => normalizeVisibleText(element.textContent))
    .filter((label) => statusLabels.has(label))
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 5);
  const classHints = [...root.querySelectorAll<HTMLElement>("[class]")]
    .flatMap((element) => [...element.classList])
    .filter((token) => /(?:goods|product|result|list|loading|empty)/i.test(token))
    .filter((token) => /^[A-Za-z0-9_-]{1,60}$/.test(token))
    .filter((token, index, tokens) => tokens.indexOf(token) === index)
    .slice(0, 8);
  const baseOrigin = root.defaultView?.location.origin ?? "https://www.pzds.com";
  const iframeHints = [...root.querySelectorAll<HTMLIFrameElement>("iframe")]
    .slice(0, 2)
    .map((frame) => {
      const rawSource = frame.getAttribute("src") ?? "about:blank";
      let locationHint = "invalid";
      try {
        const parsed = new URL(rawSource, baseOrigin);
        locationHint = parsed.origin === baseOrigin
          ? `same:${parsed.pathname}`
          : `cross:${parsed.origin}${parsed.pathname}`;
      } catch {
        // Keep the invalid marker and never report the raw source.
      }
      let documentHint = "opaque";
      try {
        const frameDocument = frame.contentDocument;
        if (frameDocument) {
          documentHint = `${frameDocument.readyState},goods=${
            frameDocument.querySelectorAll('a[href*="/goodsDetails/"]').length
          }`;
        }
      } catch {
        // A cross-origin frame is intentionally opaque.
      }
      return `${locationHint}:${documentHint}`;
    });
  return [
    `allLinks=${allLinks.length}`,
    `goodsDetailLinks=${goodsDetailLinks.length}`,
    `canonicalLinks=${canonicalLinks.length}`,
    `visibleCanonicalLinks=${visibleCanonicalLinks}`,
    `explicitCandidates=${explicitCandidates}`,
    `visibilityState=${root.visibilityState}`,
    `readyState=${root.readyState}`,
    `iframeCount=${root.querySelectorAll("iframe").length}`,
    `iframeHints=${iframeHints.join("|") || "none"}`,
    `actionHints=${actionHints.join("|") || "none"}`,
    `statusHints=${statusHints.join("|") || "none"}`,
    `classHints=${classHints.join("|") || "none"}`,
    `emptyFingerprint=${emptyFingerprintDiagnostic(root)}`,
    `samplePaths=${samplePaths.join("|") || "none"}`
  ].join("; ");
}

export function locateResultContainer(
  root: Document
): ResultContainer | SelectorFailure {
  const visibility = new WeakMap<Element, boolean>();
  const strictEmpty = strictEmptyResultContainer(root);
  if (strictEmpty) {
    return { kind: "result-container", element: strictEmpty };
  }
  const explicit = new Set(
    [...root.querySelectorAll<HTMLElement>(
      '[aria-label="商品列表"], [data-panzhi-results]'
    )].filter(
      (element) =>
        isElementVisible(element, visibility) &&
        (visibleCardAnchors(element, visibility).length > 0 ||
          resultLoadingVisible(element))
    )
  );
  if (explicit.size > 0) {
    const element = smallestUniqueContainer(explicit);
    return element
      ? { kind: "result-container", element }
      : failure("structural_drift", "Panzhi result container is ambiguous");
  }

  const anchors = visibleCardAnchors(root, visibility);
  if (anchors.length < 2) {
    return failure(
      "missing_controls",
      `Missing unique Panzhi result container; ${missingResultDiagnostic(
        root,
        anchors.length,
        explicit.size
      )}`
    );
  }
  const inferred = new Set<HTMLElement>();
  for (const anchor of anchors) {
    let candidate = anchor.parentElement;
    while (candidate && candidate !== root.body) {
      if (visibleCardAnchors(candidate, visibility).length >= 2) {
        inferred.add(candidate);
        break;
      }
      candidate = candidate.parentElement;
    }
  }
  const element = smallestUniqueContainer(inferred);
  if (!element) {
    return failure("structural_drift", "Panzhi result container is ambiguous");
  }

  const inferredIds = visibleCardAnchors(element, visibility)
    .map((anchor) => cardIdentity(anchor)!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
  const weakRoleLists = [...root.querySelectorAll<HTMLElement>('[role="list"]')]
    .filter(
      (candidate) =>
        isElementVisible(candidate, visibility) &&
        visibleCardAnchors(candidate, visibility).length >= 2
    );
  for (const weak of weakRoleLists) {
    const weakIds = visibleCardAnchors(weak, visibility)
      .map((anchor) => cardIdentity(anchor)!)
      .filter((id, index, ids) => ids.indexOf(id) === index);
    const weakIdSet = new Set(weakIds);
    const hasDifferentOutsideCard = anchors.some((anchor) =>
      !weak.contains(anchor) && !weakIdSet.has(cardIdentity(anchor)!)
    );
    if (hasDifferentOutsideCard) {
      return failure(
        "structural_drift",
        "Panzhi role list conflicts with an outside listing card"
      );
    }
    const sameCards = weakIds.length === inferredIds.length &&
      weakIds.every((id, index) => id === inferredIds[index]);
    const sameBranch = weak === element ||
      weak.contains(element) ||
      element.contains(weak);
    if (!sameBranch || !sameCards) {
      return failure(
        "structural_drift",
        "Panzhi role list conflicts with the inferred result container"
      );
    }
  }
  return { kind: "result-container", element };
}

function scopedVisibleTextContains(root: HTMLElement, pattern: RegExp): boolean {
  return [...root.querySelectorAll<HTMLElement>("*")].some((element) => {
    if (!pattern.test(normalizeVisibleText(element.textContent))) return false;
    if (
      [...element.children].some((child) =>
        pattern.test(normalizeVisibleText(child.textContent))
      )
    ) {
      return false;
    }
    return isElementVisible(element);
  });
}

export function readResultState(root: Document): ResultState | SelectorFailure {
  const located = locateResultContainer(root);
  if (located.kind === "failure") return located;
  const structurallyEmptyResult = strictEmptyResultContainer(root);
  const anchors = visibleCardAnchors(located.element);
  const visibleCards = new Map<string, string>();
  for (const anchor of anchors) {
    const id = cardIdentity(anchor)!;
    if (visibleCards.has(id)) continue;
    const heading = anchor.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6");
    const title = heading ? visibleDescendantText(heading) : "";
    const rawText = visibleDescendantText(anchor);
    const price = rawText.match(
      /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/
    )?.[1] ?? "";
    visibleCards.set(id, JSON.stringify({ id, title, rawText, price }));
  }
  const visibleIds = [...visibleCards.keys()];
  const loadingVisible = resultLoadingVisible(located.element);
  const emptyResultVisible =
    structurallyEmptyResult === located.element && !loadingVisible;
  const endMarkerVisible =
    emptyResultVisible ||
    located.element.getAttribute("data-end") === "true" ||
    located.element.getAttribute("data-panzhi-end") === "true" ||
    scopedVisibleTextContains(located.element, /没有更多|已加载全部|已经到底/);
  if (visibleIds.length === 0 && !loadingVisible && !emptyResultVisible) {
    return failure("structural_drift", "Panzhi result container has no cards");
  }
  return {
    kind: "result-state",
    signature: emptyResultVisible
      ? "empty"
      : [...visibleCards.values()].join("\u001f"),
    visibleIds,
    loadingVisible,
    endMarkerVisible,
    emptyResultVisible
  };
}

function visibleDescendantText(root: HTMLElement): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      if (node.parentElement && isElementVisible(node.parentElement)) {
        const text = normalizeVisibleText(node.textContent);
        if (text) parts.push(text);
      }
      return;
    }
    if (node instanceof Element && !isElementVisible(node)) return;
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return normalizeVisibleText(parts.join(" "));
}

export function extractVisibleCards(
  root: Document
): ExtractedCards | SelectorFailure {
  const located = locateResultContainer(root);
  if (located.kind === "failure") return located;
  const items: PanzhiSnapshotItem[] = [];
  const seen = new Set<string>();
  const anchors = located.element.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/goodsDetails/"]'
  );

  for (const anchor of anchors) {
    if (!isElementVisible(anchor)) continue;
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) {
      return failure("structural_drift", "Visible Panzhi card has no URL");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawHref, "https://www.pzds.com");
    } catch {
      return failure("structural_drift", "Visible Panzhi card URL is invalid");
    }
    const path = parsedUrl.pathname.match(
      /^\/goodsDetails\/([A-Za-z0-9_-]{1,80})\/6\/?$/
    );
    if (parsedUrl.origin !== "https://www.pzds.com" || !path) {
      return failure("structural_drift", "Visible Panzhi card URL drifted");
    }
    const sourceListingId = path[1];
    if (seen.has(sourceListingId)) continue;

    const heading = anchor.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6");
    const title = heading ? visibleDescendantText(heading).slice(0, 500) : "";
    const rawText = visibleDescendantText(anchor).slice(0, 4_000);
    const priceMatch = rawText.match(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
    const priceCny = priceMatch
      ? Number(priceMatch[1].replace(/,/g, ""))
      : Number.NaN;
    if (!title || !rawText || !Number.isFinite(priceCny)) {
      return failure("structural_drift", "Visible Panzhi card structure drifted");
    }

    seen.add(sourceListingId);
    items.push({
      sourceListingId,
      url: `https://www.pzds.com/goodsDetails/${sourceListingId}/6`,
      title,
      rawText,
      priceCny
    });
  }

  if (items.length === 0) {
    if (
      strictEmptyResultContainer(root) === located.element &&
      !resultLoadingVisible(located.element)
    ) {
      return { kind: "cards", items: [] };
    }
    return failure("structural_drift", "No visible Panzhi listing cards found");
  }
  return { kind: "cards", items };
}
