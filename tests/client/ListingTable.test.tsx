import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ListingTable } from "../../src/client/components/ListingTable";
import type { Listing } from "../../src/domain/listing";
import type {
  ManualListingReview,
  ReviewedListing
} from "../../src/domain/manualReview";
import { makeListing, makeScore } from "../domain/listingFactory";

function makeReviewedListing(
  overrides: Partial<Listing> = {},
  manualReview: ManualListingReview | null = null
): ReviewedListing {
  return {
    ...makeListing(overrides),
    manualReview
  };
}

describe("ListingTable", () => {
  it("shows the exact M7 peak grade", () => {
    render(
      <ListingTable
        listings={[makeReviewedListing({ m7PrismQuality: "S" })]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText("M7 · 极品S")).toBeInTheDocument();
  });

  it("shows premium S without presenting it as peak", () => {
    render(
      <ListingTable
        listings={[
          makeReviewedListing({
            m7PrismStatus: "premium",
            m7PrismQuality: "S"
          })
        ]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText("M7 · 优品S")).toBeInTheDocument();
    expect(screen.queryByText("M7 · 极品S")).not.toBeInTheDocument();
  });

  it("highlights every trusted M7 rare finish without fabricating empty tags", () => {
    const { rerender } = render(
      <ListingTable
        listings={[
          makeReviewedListing({
            m7RareFinishes: ["pearl", "iridescent", "candy"]
          })
        ]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText("珠光 M7")).toBeInTheDocument();
    expect(screen.getByText("炫彩 M7")).toBeInTheDocument();
    expect(screen.getByText("糖果 M7")).toBeInTheDocument();

    rerender(
      <ListingTable
        listings={[makeReviewedListing({ m7RareFinishes: [] })]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.queryByText("珠光 M7")).not.toBeInTheDocument();
    expect(screen.queryByText("炫彩 M7")).not.toBeInTheDocument();
    expect(screen.queryByText("糖果 M7")).not.toBeInTheDocument();
  });

  it("shows asset recovery, potential upside, and concise accessible names", () => {
    const listing = makeReviewedListing({
      sourceListingId: "VALUE-1",
      title: `${"超长标题".repeat(80)}<span>残留标签</span>`,
      julangStatus: "unknown",
      julangQuality: null,
      score: {
        ...makeScore(40),
        exactTotal: 40.2,
        value: 30,
        safety: 10,
        dataQuality: 80,
        riskLevel: "low",
        coverage: { knownSafetySignals: 1, totalSafetySignals: 1 }
      }
    });

    render(
      <ListingTable
        listings={[listing]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText("资产回收率 18%")).toBeInTheDocument();
    expect(screen.getByText(/待核验潜力/)).toBeInTheDocument();
    expect(screen.getByText("安全证据 1 / 1")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "盼之账号 VALUE-1，¥2,888，推荐分 40.2"
    })).toBeInTheDocument();
  });

  it("sorts candidates by price without changing the records", async () => {
    const onSelect = vi.fn();
    const listings = [
      makeReviewedListing({ key: "panzhi:expensive", priceCny: 5500 }),
      makeReviewedListing({
        key: "panzhi:cheap",
        sourceListingId: "cheap",
        priceCny: 2800
      })
    ];
    render(
      <ListingTable
        listings={listings}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={onSelect}
      />
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "盼之账号 SA123，¥5,500，推荐分 待评分"
      })
    );
    expect(onSelect).toHaveBeenCalledWith(listings[0]);
  });

  it("adds a candidate to comparison without opening its detail", async () => {
    const onSelect = vi.fn();
    const onToggleComparison = vi.fn();
    const listing = makeReviewedListing({ sourceListingId: "COMPARE-1" });
    render(
      <ListingTable
        listings={[listing]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={onSelect}
        onToggleComparison={onToggleComparison}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "加入对比" })
    );

    expect(onToggleComparison).toHaveBeenCalledWith(listing);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows comparison and duplicate states explicitly", () => {
    const listing = makeReviewedListing({
      key: "panzhi:compare",
      sourceListingId: "COMPARE-2",
      possibleDuplicateKeys: ["jiaoyimao:duplicate"]
    });
    render(
      <ListingTable
        listings={[listing]}
        selectedKey={null}
        sort="score"
        comparisonKeys={new Set([listing.key])}
        comparisonLimitReached
        onSortChange={() => undefined}
        onSelect={() => undefined}
        onToggleComparison={() => undefined}
      />
    );

    expect(
      screen.getByText("疑似跨平台同号 · 推荐池仅保留最高分")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "移出对比" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("解析置信度 100%"))
      .toBeInTheDocument();
  });

  it("labels the global pool and shows scan stability", () => {
    render(
      <ListingTable
        listings={[
          makeReviewedListing({
            scanStability: "stable",
            consecutiveUnchangedScans: 3
          })
        ]}
        selectedKey={null}
        sort="score"
        view="pool"
        poolMode="global"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(
      screen.getByRole("heading", { name: "全局 Top 30 1 / 30" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("不设平台配额 · 仅排除明确高风险账号")
    ).toBeInTheDocument();
    expect(screen.getByText("连续稳定 · 3 轮")).toBeInTheDocument();
  });

  it.each([
    ["new", "首次发现"],
    ["changed", "本轮有变化"],
    ["unknown", "稳定性待观测"]
  ] as const)("labels %s scan stability", (scanStability, label) => {
    render(
      <ListingTable
        listings={[makeReviewedListing({ scanStability })]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("tags the manual exclusion reason in the rejected view", () => {
    render(
      <ListingTable
        listings={[
          makeReviewedListing(
            {},
            {
              excluded: true,
              reason: "price_overvalued",
              note: null,
              reviewedAt: "2026-07-31T08:00:00.000Z"
            }
          )
        ]}
        selectedKey={null}
        sort="score"
        view="rejected"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(
      screen.getByText("人工淘汰 · 价格虚高")
    ).toBeInTheDocument();
  });

  it("shows a transparent manual-preference ranking adjustment", () => {
    render(
      <ListingTable
        listings={[
          makeReviewedListing({
            score: {
              ...makeScore(74),
              preferenceAdjustment: -1,
              value: 60,
              safety: 90,
              dataQuality: 100
            }
          })
        ]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText("偏好 -1")).toBeInTheDocument();
  });
});
