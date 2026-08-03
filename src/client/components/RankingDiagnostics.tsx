import type { SourceId } from "../../domain/listing";
import type { ReviewedListingSummary } from "../../domain/listingSummary";

const SOURCE_LABELS: Record<SourceId, string> = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
};

const SOURCES: SourceId[] = ["jiaoyimao", "panzhi", "pxb7"];

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function displayAverage(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

export interface SourceRankingDiagnostic {
  source: SourceId;
  count: number;
  score: number | null;
  value: number | null;
  safety: number | null;
  dataQuality: number | null;
  knownSafetySignals: number | null;
}

export function buildRankingDiagnostics(
  listings: ReviewedListingSummary[]
): SourceRankingDiagnostic[] {
  return SOURCES.map((source) => {
    const sourceListings = listings.filter(
      (listing) => listing.source === source && listing.score !== null
    );
    const scores = sourceListings.flatMap(({ score }) =>
      score ? [score.exactTotal ?? score.total] : []
    );
    return {
      source,
      count: sourceListings.length,
      score: average(scores),
      value: average(sourceListings.flatMap(({ score }) =>
        score ? [score.value] : []
      )),
      safety: average(sourceListings.flatMap(({ score }) =>
        score ? [score.safety] : []
      )),
      dataQuality: average(sourceListings.flatMap(({ score }) =>
        score ? [score.dataQuality] : []
      )),
      knownSafetySignals: average(sourceListings.flatMap(({ score }) =>
        score ? [score.coverage.knownSafetySignals] : []
      ))
    };
  });
}

export function RankingDiagnostics({
  listings
}: {
  listings: ReviewedListingSummary[];
}) {
  if (listings.length === 0) return null;
  const diagnostics = buildRankingDiagnostics(listings);
  const dominant = diagnostics.find(({ count }) => count >= 20);

  return (
    <section className="ranking-diagnostics" aria-label="跨平台排名诊断">
      <header>
        <div>
          <span>RANKING AUDIT</span>
          <strong>总榜平台构成与分项均值</strong>
        </div>
        <p>只统计当前全局 Top 30，不给任何平台加分、扣分或保底名额。</p>
      </header>
      <div className="ranking-diagnostics__grid">
        {diagnostics.map((item) => (
          <article key={item.source}>
            <div>
              <strong>{SOURCE_LABELS[item.source]}</strong>
              <b>{item.count} 席</b>
            </div>
            <dl>
              <div><dt>推荐分</dt><dd>{displayAverage(item.score)}</dd></div>
              <div><dt>账号价值</dt><dd>{displayAverage(item.value)}</dd></div>
              <div><dt>购买安全</dt><dd>{displayAverage(item.safety)}</dd></div>
              <div><dt>数据完整度</dt><dd>{displayAverage(item.dataQuality)}</dd></div>
              <div><dt>安全证据</dt><dd>{displayAverage(item.knownSafetySignals)} / 1</dd></div>
            </dl>
          </article>
        ))}
      </div>
      {dominant ? (
        <p className="ranking-diagnostics__note">
          {SOURCE_LABELS[dominant.source]}占 {dominant.count} 席。请结合上面的价值、安全和完整度均值判断原因；席位多本身不代表平台更可靠。
        </p>
      ) : null}
    </section>
  );
}
