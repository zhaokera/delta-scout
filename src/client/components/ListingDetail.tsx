import type { Listing } from "../../domain/listing";
import {
  MANUAL_REVIEW_REASON_LABELS,
  type ReviewedListing
} from "../../domain/manualReview";
import {
  isReviewedListingSummary,
  type ReviewedListingSummary
} from "../../domain/listingSummary";
import { manualPreferenceAdjustment } from "../../domain/manualPreference";
import {
  assetRecoveryRate,
  potentialRecommendationScore,
  preciseRecommendationScore
} from "../../domain/score";
import {
  SAFETY_SCORE_MAX,
  VALUE_SCORE_MAX
} from "../../domain/scoreAllocation";
import type { ListingHistoryView } from "../api";
import { buildEvidenceExcerpt } from "../../domain/evidenceExcerpt";

const SOURCE_LABELS = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
} as const;

const M7_RARE_FINISH_LABELS = {
  pearl: "珠光 M7",
  iridescent: "炫彩 M7",
  candy: "糖果 M7"
} as const;

function known<T>(
  value: T | null,
  formatter: (value: T) => string = (item) => String(item)
): string {
  return value === null ? "待人工核验" : formatter(value);
}

function booleanLabel(
  value: boolean | null,
  yes: string,
  no: string
): string {
  return value === null ? "待人工核验" : value ? yes : no;
}

function m7StatusLabel(listing: Listing): string {
  if (listing.m7PrismStatus === "peak") {
    return `极品${listing.m7PrismQuality ?? ""}`;
  }
  if (listing.m7PrismStatus === "premium") {
    return `优品${listing.m7PrismQuality ?? ""}`;
  }
  if (listing.m7PrismStatus === "absent") return "未发现";
  if (listing.m7PrismStatus === "conflicting") return "证据冲突";
  return "待人工核验";
}

function scorePart(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function money(value: number | null): string {
  return value === null
    ? "待人工核验"
    : `¥${value.toLocaleString("zh-CN")}`;
}

function stabilityLabel(listing: Listing): string {
  if (listing.scanStability === "stable") {
    return `连续稳定 · ${listing.consecutiveUnchangedScans} 轮`;
  }
  if (listing.scanStability === "new") return "首次发现";
  if (listing.scanStability === "changed") return "本轮有变化";
  return "稳定性待观测";
}

const RISK_LABELS = {
  low: "低风险",
  medium: "需关注",
  high: "高风险",
  unknown: "安全证据不足"
} as const;

export function ListingDetail({
  listing,
  loading,
  history = null,
  historyLoading = false,
  historyError = null,
  reviewPending = false,
  reviewError = null,
  onExclude,
  onRestore,
  onClose
}: {
  listing: ReviewedListing | ReviewedListingSummary | null;
  loading: boolean;
  history?: ListingHistoryView | null;
  historyLoading?: boolean;
  historyError?: string | null;
  reviewPending?: boolean;
  reviewError?: string | null;
  onExclude?: (listing: ReviewedListing) => void;
  onRestore?: (listing: ReviewedListing) => void;
  onClose?: () => void;
}) {
  if (!listing) {
    return (
      <aside className="detail-panel detail-panel--empty" aria-label="候选详情">
        <span className="target-mark" aria-hidden="true">＋</span>
        <p>选择左侧候选</p>
        <small>查看 M7 原文、红皮角色、巨浪与安全凭据</small>
      </aside>
    );
  }

  if (isReviewedListingSummary(listing)) {
    return (
      <aside
        className="detail-panel detail-panel--summary"
        aria-label="候选详情"
        aria-busy={loading}
      >
        <header className="detail-header">
          <div>
            <span className="section-index">03 / EVIDENCE</span>
            <h2 id="candidate-detail-title">
              {listing.sourceListingId ?? "候选详情"}
            </h2>
            <p>{SOURCE_LABELS[listing.source]} · 轻量列表摘要</p>
          </div>
          {onClose ? (
            <button
              className="detail-close"
              type="button"
              aria-label="关闭候选详情"
              data-detail-close
              onClick={onClose}
            >
              ×
            </button>
          ) : null}
          <div className="detail-score">
            <strong>
              {listing.score === null
                ? "—"
                : preciseRecommendationScore(listing.score).toFixed(1)}
            </strong>
            <span>推荐分</span>
          </div>
        </header>

        <section className="detail-decision-bar" aria-label="快速决策">
          <div>
            <span>当前报价</span>
            <strong>{money(listing.priceCny)}</strong>
          </div>
          <div>
            <a href={listing.url} target="_blank" rel="noreferrer">
              平台核验 ↗
            </a>
          </div>
        </section>

        <section className="detail-summary-loading" role="status">
          <i aria-hidden="true" />
          <strong>
            {loading ? "正在按需读取完整证据" : "完整证据暂未载入"}
          </strong>
          <p>
            列表已省略原始描述和证据正文；打开账号时才读取，避免一次传输数 MB 数据。
          </p>
        </section>
      </aside>
    );
  }

  const m7Excerpt = buildEvidenceExcerpt(
    listing.m7Evidence[0]?.text ?? "待人工核验"
  );
  const rareM7Excerpts = listing.m7RareFinishEvidence.map((record) => ({
    record,
    excerpt: buildEvidenceExcerpt(record.text)
  }));
  const prices =
    history?.observations.filter(
      (
        observation
      ): observation is typeof observation & { priceCny: number } =>
        observation.availability === "active" &&
        observation.priceCny !== null
    ) ?? [];
  const preferenceAdjustment = listing.score === null
    ? 0
    : manualPreferenceAdjustment(listing.score);
  const recoveryRate = assetRecoveryRate(listing);
  const potentialScore = potentialRecommendationScore(listing);
  const preciseScore = listing.score === null
    ? null
    : preciseRecommendationScore(listing.score);
  const latestMovement =
    prices.length >= 2 ? prices[0].priceCny - prices[1].priceCny : null;
  const movementLabel =
    latestMovement === null
      ? "等待下一轮可信扫描"
      : latestMovement > 0
        ? `上涨 ¥${latestMovement.toLocaleString("zh-CN")}`
        : latestMovement < 0
          ? `下降 ¥${Math.abs(latestMovement).toLocaleString("zh-CN")}`
          : "价格持平";
  const availabilityLabel =
    history?.availability === "active"
      ? "当前在售"
      : history?.availability === "removed"
        ? "已下架"
        : "在售状态待确认";

  return (
    <aside className="detail-panel" aria-label="候选详情" aria-busy={loading}>
      <header className="detail-header">
        <div>
          <span className="section-index">03 / EVIDENCE</span>
          <h2 id="candidate-detail-title">
            {listing.sourceListingId ?? "候选详情"}
          </h2>
          <p>{SOURCE_LABELS[listing.source]} · 抓取证据快照</p>
          <span
            className={`stability-badge stability-badge--${listing.scanStability}`}
          >
            {stabilityLabel(listing)}
          </span>
        </div>
        {onClose ? (
          <button
            className="detail-close"
            type="button"
            aria-label="关闭候选详情"
            data-detail-close
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
        <div className="detail-score">
          <strong>{preciseScore?.toFixed(1) ?? "—"}</strong>
          <span>推荐分</span>
          {preferenceAdjustment < 0 ? (
            <em className="preference-adjustment">
              人工偏好 {preferenceAdjustment}
            </em>
          ) : null}
        </div>
      </header>

      <section className="detail-decision-bar" aria-label="快速决策">
        <div>
          <span>当前报价</span>
          <strong>{money(listing.priceCny)}</strong>
        </div>
        <div>
          <a href={listing.url} target="_blank" rel="noreferrer">
            平台核验 ↗
          </a>
          {listing.manualReview && onRestore ? (
            <button
              className="decision-action decision-action--restore"
              type="button"
              disabled={reviewPending}
              onClick={() => onRestore(listing)}
            >
              {reviewPending ? "正在恢复…" : "恢复参与排名"}
            </button>
          ) : listing.eligibility === "eligible" && onExclude ? (
            <button
              className="decision-action decision-action--exclude"
              type="button"
              disabled={reviewPending}
              onClick={() => onExclude(listing)}
            >
              {reviewPending ? "正在处理…" : "人工淘汰"}
            </button>
          ) : null}
        </div>
      </section>

      <section className="evidence-block evidence-block--m7">
        <span className="evidence-label">品质标签 / M7</span>
        <strong>M7 棱镜攻势 · {m7StatusLabel(listing)}</strong>
        {(listing.m7PrismStatus === "peak" ||
          listing.m7PrismStatus === "premium") &&
        listing.m7PrismQuality === null ? (
          <p className="evidence-warning" role="alert">
            {listing.m7PrismStatus === "premium"
              ? "优品品质待核验"
              : "极品品质待核验"}
          </p>
        ) : null}
        <blockquote>
          {m7Excerpt.leadingEllipsis ? "…" : null}
          {m7Excerpt.segments.map((segment, index) =>
            segment.highlighted ? (
              <mark key={`${index}:${segment.text}`}>
                {segment.text}
              </mark>
            ) : (
              <span key={`${index}:${segment.text}`}>
                {segment.text}
              </span>
            )
          )}
          {m7Excerpt.trailingEllipsis ? "…" : null}
        </blockquote>
        <div className="m7-finish-detail">
          <span className="m7-finish-detail__label">高价值模板</span>
          {listing.m7RareFinishes.length > 0 ? (
            <div className="m7-finish-tags" aria-label="M7 高价值模板">
              {listing.m7RareFinishes.map((finish) => (
                <span className="m7-finish-tag" key={finish}>
                  {M7_RARE_FINISH_LABELS[finish]}
                </span>
              ))}
            </div>
          ) : (
            <p className="m7-finish-pending">未发现稀有模板</p>
          )}
          {rareM7Excerpts.map(({ record, excerpt }) => (
            <blockquote
              className="m7-finish-evidence"
              aria-label={`M7 稀有模板证据：${record.text}`}
              key={record.text}
            >
              {excerpt.leadingEllipsis ? "…" : null}
              {excerpt.segments.map((segment, index) =>
                segment.highlighted ? (
                  <mark key={`${index}:${segment.text}`}>
                    {segment.text}
                  </mark>
                ) : (
                  <span key={`${index}:${segment.text}`}>
                    {segment.text}
                  </span>
                )
              )}
              {excerpt.trailingEllipsis ? "…" : null}
            </blockquote>
          ))}
        </div>
      </section>

      <section className="detail-grid">
        <div>
          <span>指定红皮硬条件</span>
          <strong>
            {listing.requiredRedSkinStatus === "complete"
              ? listing.requiredRedSkins.join(" · ")
              : listing.requiredRedSkinStatus === "missing"
                ? "明确缺少指定红皮"
                : listing.requiredRedSkins.length > 0
                  ? `${listing.requiredRedSkins.join(" · ")} · 仍缺证据`
                  : "待人工核验"}
          </strong>
        </div>
        <div>
          <span>角色红皮</span>
          <strong>
            {listing.redSkins.length
              ? listing.redSkins.join(" · ")
              : "待人工核验"}
          </strong>
        </div>
        <div>
          <span>巨浪</span>
          <strong>
            {listing.julangStatus === "owned"
              ? `已拥有 · ${listing.julangQuality ?? "品质待核验"}`
              : listing.julangStatus === "absent"
                ? "明确没有"
                : "待人工核验"}
          </strong>
        </div>
        <div>
          <span>总资产</span>
          <strong>
            {known(listing.totalAssetsM, (value) => `${value}M`)}
          </strong>
        </div>
        <div>
          <span>资产回收率</span>
          <strong>
            {recoveryRate === null
              ? "待人工核验"
              : `${Math.round(recoveryRate * 100)}%`}
          </strong>
        </div>
        <div>
          <span>哈夫币</span>
          <strong>
            {known(listing.hafCoins, (value) =>
              value.toLocaleString("zh-CN")
            )}
          </strong>
        </div>
      </section>

      <section className="security-block">
        <div className="security-block__heading">
          <span>安全情报</span>
          <i aria-hidden="true" />
        </div>
        <dl>
          <div>
            <dt>登录 / 区服</dt>
            <dd>
              {listing.loginPlatform === "qq" ? "QQ" : "待人工核验"} /{" "}
              {listing.service === "official" ? "官服" : "待人工核验"}
            </dd>
          </div>
          <div>
            <dt>实名状态</dt>
            <dd>
              {booleanLabel(
                listing.secondRealNameAvailable,
                "可二次实名",
                "不可二次实名"
              )}
            </dd>
          </div>
          <div>
            <dt>找回保障</dt>
            <dd>
              {booleanLabel(
                listing.recoveryCoverage,
                "支持人脸包赔",
                "不支持包赔"
              )}
            </dd>
          </div>
          <div>
            <dt>验号时间</dt>
            <dd>
              {listing.verificationAt
                ? new Date(listing.verificationAt).toLocaleString("zh-CN")
                : "待人工核验"}
            </dd>
          </div>
        </dl>
      </section>

      {listing.score ? (
        <section className="score-breakdown">
          <span>评分依据</span>
          <div className="score-summary">
            <p>确定推荐 {preciseScore?.toFixed(1)} / 100</p>
            {potentialScore !== null &&
            preciseScore !== null && potentialScore > preciseScore ? (
              <p className="score-potential">
                待核验潜力 {potentialScore.toFixed(1)} / 100
              </p>
            ) : null}
            <p>账号价值 {scorePart(listing.score.value)} / 100</p>
            <p>
              购买安全 {scorePart(listing.score.safety)} / {SAFETY_SCORE_MAX.total}
            </p>
            <p>
              数据完整度 {scorePart(listing.score.dataQuality)} / 100
            </p>
            <strong
              className={`risk-badge risk-badge--${listing.score.riskLevel}`}
            >
              {RISK_LABELS[listing.score.riskLevel]}
            </strong>
            <small>
              安全证据 {listing.score.coverage.knownSafetySignals} /{" "}
              {listing.score.coverage.totalSafetySignals}
            </small>
          </div>
          <div className="score-parts">
            <p>
              M7 综合价值 {scorePart(listing.score.parts.m7)} / {VALUE_SCORE_MAX.m7}
            </p>
            <p>
              付费红皮价值 {scorePart(listing.score.parts.redSkins)} / {VALUE_SCORE_MAX.redSkins}
            </p>
            <p>巨浪 {scorePart(listing.score.parts.julang)} / {VALUE_SCORE_MAX.julang}</p>
            <p>价格 {scorePart(listing.score.parts.price)} / {VALUE_SCORE_MAX.price}</p>
            <p>资产 {scorePart(listing.score.parts.assets)} / {VALUE_SCORE_MAX.assets}</p>
            <p>
              二次实名 {scorePart(listing.score.parts.secondRealName)} / {SAFETY_SCORE_MAX.secondRealName}
            </p>
            <p>永久包赔 仅作参考 · 不参与评分</p>
            <p>验号时间 仅作参考 · 不参与评分</p>
          </div>
          {listing.score.valueReasons.map((reason) => (
            <p key={`value:${reason}`}>{reason}</p>
          ))}
          {listing.score.safetyReasons.map((reason) => (
            <p key={`safety:${reason}`}>{reason}</p>
          ))}
          {listing.score.reasons.map((reason) => (
            <p key={`overall:${reason}`}>{reason}</p>
          ))}
        </section>
      ) : null}

      <section className="history-block" aria-label="账号历史">
        <div className="history-block__heading">
          <span>在售与变化</span>
          <strong>{history ? availabilityLabel : "状态待加载"}</strong>
        </div>
        {historyLoading ? <p>正在读取可信历史…</p> : null}
        {historyError ? (
          <p className="history-block__error">{historyError}</p>
        ) : null}
        {history ? (
          <>
            <div className="price-history__heading">
              <strong>价格历史</strong>
              <span>{movementLabel}</span>
            </div>
            {prices.length > 0 ? (
              <ol className="price-history">
                {prices.map((observation) => (
                  <li key={observation.runId}>
                    <strong>
                      ¥{observation.priceCny.toLocaleString("zh-CN")}
                    </strong>
                    <span>
                      {new Date(observation.observedAt).toLocaleString(
                        "zh-CN"
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>尚无可信价格记录</p>
            )}
            <div className="change-history">
              <strong>最近变化</strong>
              {(history.observations[0]?.changes.length ?? 0) > 0 ? (
                history.observations[0].changes.map((change) => (
                  <p key={`${change.field}:${change.before}:${change.after}`}>
                    <span>{change.label}</span>
                    <b>
                      {change.before} → {change.after}
                    </b>
                  </p>
                ))
              ) : (
                <p>本轮关键字段无变化</p>
              )}
            </div>
          </>
        ) : historyLoading || historyError ? null : (
          <p>等待下一轮可信扫描</p>
        )}
      </section>

      {listing.parseWarnings.length ? (
        <section className="warning-block">
          <strong>需复核</strong>
          {listing.parseWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </section>
      ) : null}

      {listing.manualReview ? (
        <section
          className="manual-review-summary"
          aria-label="人工淘汰记录"
        >
          <strong>
            人工淘汰 ·{" "}
            {MANUAL_REVIEW_REASON_LABELS[listing.manualReview.reason]}
          </strong>
          {listing.manualReview.note ? (
            <p>{listing.manualReview.note}</p>
          ) : (
            <p>未填写补充说明</p>
          )}
          <time dateTime={listing.manualReview.reviewedAt}>
            淘汰于{" "}
            {new Date(
              listing.manualReview.reviewedAt
            ).toLocaleString("zh-CN")}
          </time>
        </section>
      ) : null}

      {reviewError ? (
        <p className="manual-review-inline-error" role="alert">
          {reviewError}
        </p>
      ) : null}

      <details className="raw-evidence">
        <summary>查看原始描述与全部证据</summary>
        <pre>{listing.originalDescription}</pre>
      </details>

      <footer className="detail-footer">
        <span>
          抓取于 {new Date(listing.capturedAt).toLocaleString("zh-CN")}
        </span>
        <a href={listing.url} target="_blank" rel="noreferrer">
          前往{SOURCE_LABELS[listing.source]}核验
          <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </aside>
  );
}
