import { useEffect, useMemo, useRef } from "react";
import type { ReviewedListingSummary } from "../../domain/listingSummary";
import { manualPreferenceAdjustment } from "../../domain/manualPreference";
import {
  assetRecoveryRate,
  potentialRecommendationScore,
  preciseRecommendationScore
} from "../../domain/score";

const SOURCE_LABELS = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
} as const;

const RISK_LABELS = {
  low: "低风险",
  medium: "需关注",
  high: "高风险",
  unknown: "安全证据不足"
} as const;

const RARE_FINISH_LABELS = {
  pearl: "珠光",
  iridescent: "炫彩",
  candy: "糖果"
} as const;

function listingName(listing: ReviewedListingSummary): string {
  return listing.sourceListingId ?? listing.title.slice(0, 18);
}

function money(value: number | null): string {
  return value === null
    ? "待核验"
    : `¥${value.toLocaleString("zh-CN")}`;
}

function yesNoUnknown(
  value: boolean | null,
  yes: string,
  no: string
): string {
  return value === null ? "待核验" : value ? yes : no;
}

function m7Label(listing: ReviewedListingSummary): string {
  if (listing.m7PrismStatus === "peak") {
    return `极品${listing.m7PrismQuality ?? "待核验"}`;
  }
  if (listing.m7PrismStatus === "premium") {
    return `优品${listing.m7PrismQuality ?? "待核验"}`;
  }
  if (listing.m7PrismStatus === "absent") return "未发现";
  if (listing.m7PrismStatus === "conflicting") return "证据冲突";
  return "待核验";
}

export function CompareTray({
  listings,
  onRemove,
  onClear,
  onOpen
}: {
  listings: ReviewedListingSummary[];
  onRemove(key: string): void;
  onClear(): void;
  onOpen(): void;
}) {
  if (listings.length === 0) return null;

  return (
    <aside className="compare-tray" aria-label="候选对比栏">
      <div className="compare-tray__summary">
        <span>COMPARE</span>
        <strong>已选 {listings.length} / 4</strong>
      </div>
      <div className="compare-tray__items">
        {listings.map((listing) => (
          <span className="compare-tray__chip" key={listing.key}>
            <b>{listingName(listing)}</b>
            <button
              type="button"
              aria-label={`移除对比 ${listingName(listing)}`}
              onClick={() => onRemove(listing.key)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="compare-tray__actions">
        <button type="button" className="text-button" onClick={onClear}>
          清空
        </button>
        <button
          type="button"
          className="compare-tray__open"
          disabled={listings.length < 2}
          onClick={onOpen}
        >
          {listings.length < 2 ? "再选 1 个" : "开始对比"}
        </button>
      </div>
    </aside>
  );
}

export function CandidateCompareBoard({
  listings,
  onRemove
}: {
  listings: ReviewedListingSummary[];
  onRemove(key: string): void;
}) {
  const bestScore = useMemo(
    () => Math.max(
      ...listings.map((listing) =>
        listing.score === null
          ? -1
          : preciseRecommendationScore(listing.score)
      )
    ),
    [listings]
  );
  const bestPrice = useMemo(() => {
    const prices = listings.flatMap((listing) =>
      listing.priceCny === null ? [] : [listing.priceCny]
    );
    return prices.length > 0 ? Math.min(...prices) : null;
  }, [listings]);

  return (
    <div className="compare-dialog__grid compare-page__grid">
      {listings.map((listing) => {
        const preciseScore = listing.score === null
          ? null
          : preciseRecommendationScore(listing.score);
        const potentialScore = potentialRecommendationScore(listing);
        const recoveryRate = assetRecoveryRate(listing);
        const isBestScore =
          preciseScore !== null && preciseScore === bestScore;
        const isBestPrice =
          listing.priceCny !== null && listing.priceCny === bestPrice;
        return (
          <article className="compare-card" key={listing.key}>
            <header className="compare-card__header">
              <div>
                <span>{SOURCE_LABELS[listing.source]}</span>
                <strong>{listingName(listing)}</strong>
              </div>
              <button
                type="button"
                aria-label={`移除对比 ${listingName(listing)}`}
                onClick={() => onRemove(listing.key)}
              >
                移除
              </button>
            </header>

            <div className="compare-card__headline">
              <div>
                <small>当前报价</small>
                <strong>{money(listing.priceCny)}</strong>
                {isBestPrice ? <em>最低价</em> : null}
              </div>
              <div>
                <small>推荐分</small>
                <strong>{preciseScore?.toFixed(1) ?? "—"}</strong>
                {isBestScore ? <em>最高分</em> : null}
                {preciseScore !== null && potentialScore !== null &&
                potentialScore > preciseScore ? (
                  <span>潜力上限 {potentialScore.toFixed(1)}</span>
                ) : null}
                {listing.score &&
                manualPreferenceAdjustment(listing.score) < 0 ? (
                  <span className="preference-adjustment">
                    人工偏好 {manualPreferenceAdjustment(listing.score)}
                  </span>
                ) : null}
              </div>
            </div>

            <dl className="compare-card__facts">
              <div>
                <dt>指定红皮</dt>
                <dd>
                  {listing.requiredRedSkinStatus === "complete"
                    ? "维什戴尔 · 黑天际线"
                    : "待核验"}
                </dd>
              </div>
              <div>
                <dt>M7 品质</dt>
                <dd>{m7Label(listing)}</dd>
              </div>
              <div>
                <dt>高价值模板</dt>
                <dd>
                  {listing.m7RareFinishes.length > 0
                    ? listing.m7RareFinishes
                        .map((finish) => RARE_FINISH_LABELS[finish])
                        .join(" · ")
                    : "未发现"}
                </dd>
              </div>
              <div>
                <dt>角色红皮</dt>
                <dd>
                  {listing.redSkinCount === null
                    ? "待核验"
                    : `${listing.redSkinCount} 个`}
                </dd>
              </div>
              <div>
                <dt>巨浪</dt>
                <dd>
                  {listing.julangStatus === "owned"
                    ? `有 · ${listing.julangQuality ?? "品质待核验"}`
                    : listing.julangStatus === "absent"
                      ? "明确没有"
                      : "待核验"}
                </dd>
              </div>
              <div>
                <dt>总资产</dt>
                <dd>
                  {listing.totalAssetsM === null
                    ? "待核验"
                    : `${listing.totalAssetsM.toLocaleString("zh-CN")}M`}
                </dd>
              </div>
              <div>
                <dt>资产回收率</dt>
                <dd>
                  {recoveryRate === null
                    ? "待核验"
                    : `${Math.round(recoveryRate * 100)}%`}
                </dd>
              </div>
              <div>
                <dt>二次实名</dt>
                <dd>
                  {yesNoUnknown(
                    listing.secondRealNameAvailable,
                    "可二次实名",
                    "不可二次实名"
                  )}
                </dd>
              </div>
              <div>
                <dt>找回保障</dt>
                <dd>
                  {yesNoUnknown(
                    listing.recoveryCoverage,
                    "支持包赔",
                    "无包赔"
                  )}
                </dd>
              </div>
              <div>
                <dt>风险 / 证据</dt>
                <dd>
                  {listing.score
                    ? `${RISK_LABELS[listing.score.riskLevel]} · ${listing.score.coverage.knownSafetySignals}/${listing.score.coverage.totalSafetySignals}`
                    : "待评分"}
                </dd>
              </div>
            </dl>

            <a href={listing.url} target="_blank" rel="noreferrer">
              前往{SOURCE_LABELS[listing.source]}人工核验 ↗
            </a>
          </article>
        );
      })}
    </div>
  );
}

export function CandidateCompareDialog({
  listings,
  onRemove,
  onClose
}: {
  listings: ReviewedListingSummary[];
  onRemove(key: string): void;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousActive =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[data-compare-close]")
      ?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="compare-dialog__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="compare-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-dialog-title"
      >
        <header className="compare-dialog__header">
          <div>
            <span className="section-index">DECISION MATRIX</span>
            <h2 id="compare-dialog-title">候选账号横向对比</h2>
            <p>绿色标签标出当前选择里的最高分和最低价。</p>
          </div>
          <button
            type="button"
            className="detail-close"
            data-compare-close
            aria-label="关闭候选对比"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <CandidateCompareBoard
          listings={listings}
          onRemove={onRemove}
        />
      </section>
    </div>
  );
}
