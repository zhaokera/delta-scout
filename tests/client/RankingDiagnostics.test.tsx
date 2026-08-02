import { render, screen } from "@testing-library/react";
import {
  buildRankingDiagnostics,
  RankingDiagnostics
} from "../../src/client/components/RankingDiagnostics";
import { summarizeReviewedListing } from "../../src/domain/listingSummary";
import { makeListing, makeScore } from "../domain/listingFactory";

function summary(source: "jiaoyimao" | "panzhi" | "pxb7", id: number) {
  return summarizeReviewedListing({
    ...makeListing({
      key: `${source}:${id}`,
      source,
      sourceListingId: String(id),
      score: {
        ...makeScore(60 + id),
        exactTotal: 60.5 + id,
        value: 40 + id,
        safety: 30,
        dataQuality: 90,
        coverage: { knownSafetySignals: 1, totalSafetySignals: 2 }
      }
    }),
    manualReview: null
  });
}

describe("RankingDiagnostics", () => {
  it("computes platform averages only from the supplied Top 30", () => {
    const diagnostics = buildRankingDiagnostics([
      summary("jiaoyimao", 1),
      summary("jiaoyimao", 2),
      summary("pxb7", 3)
    ]);

    expect(diagnostics[0]).toMatchObject({
      source: "jiaoyimao",
      count: 2,
      score: 62,
      value: 41.5,
      safety: 30,
      dataQuality: 90,
      knownSafetySignals: 1
    });
    expect(diagnostics[1]).toMatchObject({ source: "panzhi", count: 0 });
  });

  it("explains dominance without adding a platform adjustment", () => {
    render(<RankingDiagnostics listings={[
      ...Array.from({ length: 20 }, (_, index) => summary("pxb7", index)),
      summary("jiaoyimao", 21)
    ]} />);

    expect(screen.getByRole("region", { name: "跨平台排名诊断" }))
      .toHaveTextContent("不给任何平台加分、扣分或保底名额");
    expect(screen.getByText("螃蟹占 20 席", { exact: false }))
      .toBeInTheDocument();
  });
});
