import type { Listing } from "../../domain/listing";
import type { SortKey } from "./FilterBar";

const SOURCE_LABELS = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
} as const;

function money(value: number | null): string {
  return value === null
    ? "待核验"
    : `¥${new Intl.NumberFormat("zh-CN").format(value)}`;
}

function sortListings(listings: Listing[], sort: SortKey): Listing[] {
  return [...listings].sort((left, right) => {
    if (sort === "price") {
      return (left.priceCny ?? Infinity) - (right.priceCny ?? Infinity);
    }
    if (sort === "assets") {
      return (right.totalAssetsM ?? -1) - (left.totalAssetsM ?? -1);
    }
    if (sort === "confidence") {
      return right.confidence - left.confidence;
    }
    return (right.score?.total ?? -1) - (left.score?.total ?? -1);
  });
}

function julangLabel(listing: Listing): string {
  if (listing.julangStatus === "owned") {
    return `巨浪${listing.julangQuality ? ` · ${listing.julangQuality}` : ""}`;
  }
  if (listing.julangStatus === "absent") return "无巨浪";
  return "巨浪待核验";
}

function m7Label(listing: Listing): string {
  if (listing.m7PrismStatus === "peak") {
    return `M7 · 极品${listing.m7PrismQuality ?? ""}`;
  }
  if (listing.m7PrismStatus === "premium") return "M7 · 优品";
  if (listing.m7PrismStatus === "conflicting") return "M7 · 证据冲突";
  if (listing.m7PrismStatus === "absent") return "M7 · 未发现";
  return "M7 · 待核验";
}

export interface ListingTableProps {
  listings: Listing[];
  selectedKey: string | null;
  sort: SortKey;
  onSortChange(sort: SortKey): void;
  onSelect(listing: Listing): void;
}

export function ListingTable({
  listings,
  selectedKey,
  sort,
  onSelect
}: ListingTableProps) {
  const sorted = sortListings(listings, sort);
  return (
    <section className="listing-panel" aria-label="账号候选列表">
      <div className="listing-panel__heading">
        <div>
          <span className="section-index">02 / CANDIDATES</span>
          <h2>候选清单</h2>
        </div>
        <p>
          <strong>{sorted.length}</strong> 条
        </p>
      </div>
      <div className="listing-columns" aria-hidden="true">
        <span>账号 / 来源</span>
        <span>资产情报</span>
        <span>安全状态</span>
        <span>推荐分</span>
      </div>
      <div className="listing-rows">
        {sorted.map((listing, index) => (
          <button
            className={`listing-row${selectedKey === listing.key ? " is-selected" : ""}`}
            type="button"
            key={listing.key}
            aria-label={`${listing.sourceListingId ?? ""} ${listing.title} ${money(listing.priceCny)}`.trim()}
            onClick={() => onSelect(listing)}
          >
            <span className="listing-row__identity">
              <small>{String(index + 1).padStart(2, "0")}</small>
              <span>
                <strong>
                  {listing.sourceListingId ?? listing.title.slice(0, 18)}
                </strong>
                <em>{SOURCE_LABELS[listing.source]}</em>
              </span>
              <b>{money(listing.priceCny)}</b>
            </span>
            <span className="listing-row__assets">
              <strong>
                {listing.totalAssetsM === null
                  ? "待核验"
                  : `${listing.totalAssetsM.toLocaleString("zh-CN")}M`}
              </strong>
              <span>
                {listing.redSkinCount === null
                  ? "红皮待核验"
                  : `${listing.redSkinCount} 角色红皮`}
              </span>
              <span>{m7Label(listing)}</span>
              <span>{julangLabel(listing)}</span>
            </span>
            <span className="listing-row__safety">
              <span
                className={
                  listing.secondRealNameAvailable === true ? "positive" : ""
                }
              >
                {listing.secondRealNameAvailable === null
                  ? "实名待核验"
                  : listing.secondRealNameAvailable
                    ? "可二次实名"
                    : "不可二次实名"}
              </span>
              <span
                className={listing.recoveryCoverage === true ? "positive" : ""}
              >
                {listing.recoveryCoverage === null
                  ? "包赔待核验"
                  : listing.recoveryCoverage
                    ? "支持包赔"
                    : "无包赔"}
              </span>
              <span>置信度 {listing.confidence}%</span>
            </span>
            <span className="listing-row__score">
              <strong>{listing.score?.total ?? "—"}</strong>
              <small>/ 100</small>
              <i aria-hidden="true">↗</i>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
