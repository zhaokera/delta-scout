import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ListingTable } from "../../src/client/components/ListingTable";
import type { Listing } from "../../src/domain/listing";
import type {
  ManualListingReview,
  ReviewedListing
} from "../../src/domain/manualReview";
import { makeListing } from "../domain/listingFactory";

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
      screen.getByRole("button", { name: /棱镜攻势极品账号.*¥5,500/ })
    );
    expect(onSelect).toHaveBeenCalledWith(listings[0]);
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
      screen.getByText("不设平台配额 · 跨平台总榜 Top 30")
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
});
