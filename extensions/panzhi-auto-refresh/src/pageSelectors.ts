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

export function isElementVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("hidden")) return false;
    if (current.getAttribute("aria-hidden") === "true") return false;
    if (current instanceof HTMLElement) {
      if (current.style.display === "none") return false;
      if (current.style.visibility === "hidden") return false;
      const computedStyle = current.ownerDocument.defaultView
        ?.getComputedStyle(current);
      if (computedStyle?.display === "none") return false;
      if (
        computedStyle?.visibility === "hidden" ||
        computedStyle?.visibility === "collapse"
      ) {
        return false;
      }
    }
    current = current.parentElement;
  }
  return true;
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
  const matches = exactTextElements(root, label);
  if (matches.length === 0) {
    return failure("missing_controls", `Missing visible control: ${label}`);
  }
  if (matches.length !== 1) {
    return failure("structural_drift", `Ambiguous visible control: ${label}`);
  }
  return matches[0];
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
    return failure(
      "missing_controls",
      `Missing controls within visible field: ${fieldLabel}`
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
    PANZHI_REQUIRED_OPERATOR_SKINS[1].label,
    "全部都要有"
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
  const allSemantics = uniqueTextControl(skinGroup, "全部都要有");
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

export function selectedState(element: HTMLElement): boolean | null {
  const candidates: HTMLElement[] = [element];
  if (element.parentElement) candidates.push(element.parentElement);
  if (element.parentElement?.parentElement) {
    candidates.push(element.parentElement.parentElement);
  }

  for (const candidate of candidates) {
    if (candidate instanceof HTMLInputElement) {
      if (candidate.type === "checkbox" || candidate.type === "radio") {
        return candidate.checked;
      }
    }
    const nestedInput = candidate.querySelector<HTMLInputElement>(
      'input[type="checkbox"], input[type="radio"]'
    );
    if (nestedInput) return nestedInput.checked;
    for (const attribute of SELECTION_ATTRIBUTES) {
      const state = booleanAttribute(candidate.getAttribute(attribute));
      if (state !== null) return state;
    }
    const dataState = candidate.getAttribute("data-state");
    if (dataState !== null) {
      const state = booleanAttribute(dataState);
      if (state !== null) return state;
    }
    if ([...candidate.classList].some((token) => SELECTED_CLASS_TOKENS.has(token))) {
      return true;
    }
  }
  return null;
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
    if (state === null) {
      return failure(
        "structural_drift",
        `No selected-state evidence for ${label}`
      );
    }
    if (!state) {
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

export function extractVisibleCards(
  root: Document
): ExtractedCards | SelectorFailure {
  const items: PanzhiSnapshotItem[] = [];
  const seen = new Set<string>();
  const anchors = root.querySelectorAll<HTMLAnchorElement>(
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
    const title = normalizeVisibleText(heading?.textContent).slice(0, 500);
    const rawText = normalizeVisibleText(anchor.textContent).slice(0, 4_000);
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
    return failure("structural_drift", "No visible Panzhi listing cards found");
  }
  return { kind: "cards", items };
}
