import type { Listing } from "../../domain/listing";

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

export function ListingDetail({
  listing,
  loading
}: {
  listing: Listing | null;
  loading: boolean;
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

  return (
    <aside className="detail-panel" aria-label="候选详情" aria-busy={loading}>
      <header className="detail-header">
        <div>
          <span className="section-index">03 / EVIDENCE</span>
          <h2>{listing.sourceListingId ?? "候选详情"}</h2>
          <p>{SOURCE_LABELS[listing.source]} · 抓取证据快照</p>
        </div>
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
          {listing.m7Evidence[0]?.text ?? "待人工核验"}
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
          {listing.score.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </section>
      ) : null}

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
