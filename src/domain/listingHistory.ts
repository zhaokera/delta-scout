import type { Listing } from "./listing.js";

export interface ListingHistorySnapshot {
  priceCny: number | null;
  eligibility: Listing["eligibility"];
  m7PrismStatus: Listing["m7PrismStatus"];
  m7PrismQuality: Listing["m7PrismQuality"];
  redSkins: string[];
  redSkinCount: number | null;
  julangStatus: Listing["julangStatus"];
  julangQuality: string | null;
  totalAssetsM: number | null;
  hafCoins: number | null;
  secondRealNameAvailable: boolean | null;
  recoveryCoverage: boolean | null;
  verificationAt: string | null;
  banNotes: string[];
  confidence: number;
  parseWarnings: string[];
}

export interface ListingFieldChange {
  field: keyof ListingHistorySnapshot | "availability";
  label: string;
  before: string;
  after: string;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildListingHistorySnapshot(
  listing: Listing
): ListingHistorySnapshot {
  return {
    priceCny: listing.priceCny,
    eligibility: listing.eligibility,
    m7PrismStatus: listing.m7PrismStatus,
    m7PrismQuality: listing.m7PrismQuality,
    redSkins: uniqueSorted(listing.redSkins),
    redSkinCount: listing.redSkinCount,
    julangStatus: listing.julangStatus,
    julangQuality: listing.julangQuality,
    totalAssetsM: listing.totalAssetsM,
    hafCoins: listing.hafCoins,
    secondRealNameAvailable: listing.secondRealNameAvailable,
    recoveryCoverage: listing.recoveryCoverage,
    verificationAt: listing.verificationAt,
    banNotes: uniqueSorted(listing.banNotes),
    confidence: listing.confidence,
    parseWarnings: uniqueSorted(listing.parseWarnings)
  };
}

const LABELS: Record<keyof ListingHistorySnapshot, string> = {
  priceCny: "价格",
  eligibility: "候选状态",
  m7PrismStatus: "M7 状态",
  m7PrismQuality: "M7 品质",
  redSkins: "角色红皮",
  redSkinCount: "红皮数量",
  julangStatus: "巨浪状态",
  julangQuality: "巨浪品质",
  totalAssetsM: "总资产",
  hafCoins: "哈夫币",
  secondRealNameAvailable: "二次实名",
  recoveryCoverage: "找回保障",
  verificationAt: "验号时间",
  banNotes: "封禁备注",
  confidence: "数据完整度",
  parseWarnings: "解析提示"
};

function formatBoolean(
  value: boolean | null,
  positive: string,
  negative: string
): string {
  return value === null ? "待核验" : value ? positive : negative;
}

function formatValue(
  field: keyof ListingHistorySnapshot,
  value: ListingHistorySnapshot[keyof ListingHistorySnapshot]
): string {
  if (field === "priceCny") {
    return value === null
      ? "待核验"
      : `¥${Number(value).toLocaleString("zh-CN")}`;
  }
  if (field === "totalAssetsM") {
    return value === null ? "待核验" : `${value}M`;
  }
  if (field === "hafCoins") {
    return value === null
      ? "待核验"
      : Number(value).toLocaleString("zh-CN");
  }
  if (field === "secondRealNameAvailable") {
    return formatBoolean(
      value as boolean | null,
      "可二次实名",
      "不可二次实名"
    );
  }
  if (field === "recoveryCoverage") {
    return formatBoolean(
      value as boolean | null,
      "支持包赔",
      "无包赔"
    );
  }
  if (field === "julangStatus") {
    return value === "owned"
      ? "已拥有"
      : value === "absent"
        ? "明确没有"
        : "待核验";
  }
  if (field === "m7PrismStatus") {
    const labels: Record<Listing["m7PrismStatus"], string> = {
      absent: "未发现",
      unknown: "待核验",
      premium: "优品",
      peak: "极品",
      conflicting: "证据冲突"
    };
    return labels[value as Listing["m7PrismStatus"]];
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join("、") : "无";
  }
  if (value === null) return "待核验";
  return String(value);
}

export function diffListingSnapshots(
  before: ListingHistorySnapshot,
  after: ListingHistorySnapshot
): ListingFieldChange[] {
  const changes: ListingFieldChange[] = [];
  for (const field of Object.keys(LABELS) as Array<
    keyof ListingHistorySnapshot
  >) {
    const previous = before[field];
    const current = after[field];
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    changes.push({
      field,
      label: LABELS[field],
      before: formatValue(field, previous),
      after: formatValue(field, current)
    });
  }
  return changes;
}
