import type { Listing } from "../../domain/listing";
import type { ListingHistoryView } from "../api";
import { buildEvidenceExcerpt } from "../../domain/evidenceExcerpt";

const SOURCE_LABELS = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
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
  if (listing.m7PrismStatus === "premium") return "优品（不符合硬条件）";
  if (listing.m7PrismStatus === "absent") return "未发现";
  if (listing.m7PrismStatus === "conflicting") return "证据冲突";
  return "待人工核验";
}

function scorePart(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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
  medium: "中风险",
  high: "高风险",
  unknown: "风险待核验"
} as const;

export function ListingDetail({
  listing,
  loading,
  history = null,
  historyLoading = false,
  historyError = null,
  onClose
}: {
  listing: Listing | null;
  loading: boolean;
  history?: ListingHistoryView | null;
  historyLoading?: boolean;
  historyError?: string | null;
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

  const m7Excerpt = buildEvidenceExcerpt(
    listing.m7Evidence[0]?.text ?? "待人工核验"
  );
  const prices =
    history?.observations.filter(
      (
        observation
      ): observation is typeof observation & { priceCny: number } =>
        observation.availability === "active" &&
        observation.priceCny !== null
    ) ?? [];
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
          <strong>{listing.score?.total ?? "—"}</strong>
          <span>推荐分</span>
        </div>
      </header>

      <section className="evidence-block evidence-block--m7">
        <span className="evidence-label">硬条件 / M7</span>
        <strong>M7 棱镜攻势 · {m7StatusLabel(listing)}</strong>
        {listing.m7PrismStatus === "peak" &&
        listing.m7PrismQuality === null ? (
          <p className="evidence-warning" role="alert">
            极品品质待核验
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
      </section>

      <section className="detail-grid">
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
            <p>账号价值 {scorePart(listing.score.value)} / 100</p>
            <p>购买安全 {scorePart(listing.score.safety)} / 100</p>
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
            <p>M7 品质 {scorePart(listing.score.parts.m7)} / 35</p>
            <p>
              角色红皮 {scorePart(listing.score.parts.redSkins)} / 20
            </p>
            <p>巨浪 {scorePart(listing.score.parts.julang)} / 15</p>
            <p>价格 {scorePart(listing.score.parts.price)} / 20</p>
            <p>资产 {scorePart(listing.score.parts.assets)} / 10</p>
            <p>
              二次实名 {scorePart(listing.score.parts.secondRealName)} / 40
            </p>
            <p>
              找回保障 {scorePart(listing.score.parts.recovery)} / 35
            </p>
            <p>
              验号时效 {scorePart(listing.score.parts.verification)} / 25
            </p>
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
