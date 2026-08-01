import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { DetailDrawer } from "../../src/client/components/DetailDrawer";
import { ListingDetail } from "../../src/client/components/ListingDetail";
import type { ListingHistoryView } from "../../src/client/api";
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

describe("ListingDetail", () => {
  it("prominently flags a peak M7 whose grade is missing", () => {
    render(
      <ListingDetail
        listing={makeReviewedListing({
          m7PrismStatus: "peak",
          m7PrismQuality: null
        })}
        loading={false}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("极品品质待核验");
  });

  it("shows premium S and flags premium without a proven grade", () => {
    const { rerender } = render(
      <ListingDetail
        listing={makeReviewedListing({
          m7PrismStatus: "premium",
          m7PrismQuality: "S"
        })}
        loading={false}
      />
    );

    expect(
      screen.getByText("M7 棱镜攻势 · 优品S")
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <ListingDetail
        listing={makeReviewedListing({
          m7PrismStatus: "premium",
          m7PrismQuality: null
        })}
        loading={false}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "优品品质待核验"
    );
  });

  it("shows a bounded M7 excerpt and separates value from purchase risk", () => {
    const evidenceText =
      `${"冗长的商品说明".repeat(40)}M7 棱镜攻势 极品 品质:S级${"其它资产".repeat(40)}`;
    const { container } = render(
      <ListingDetail
        listing={makeReviewedListing({
          m7Evidence: [{ text: evidenceText, truncated: false }],
          score: {
            total: 91,
            preferenceAdjustment: 0,
            value: 86,
            safety: 75,
            dataQuality: 80,
            riskLevel: "medium",
            coverage: {
              knownSafetySignals: 2,
              totalSafetySignals: 3
            },
            parts: {
              m7: 20,
              redSkins: 20,
              julang: 20,
              price: 23,
              assets: 9,
              secondRealName: 40,
              recovery: 35,
              verification: 0
            },
            valueReasons: ["M7 极品S"],
            safetyReasons: ["验号时间待核验"],
            reasons: []
          }
        })}
        loading={false}
      />
    );

    const quote = container.querySelector("blockquote");
    expect(quote).not.toBeNull();
    expect(quote!.textContent!.length).toBeLessThanOrEqual(182);
    expect(quote!.textContent).not.toBe(evidenceText);
    expect(
      Array.from(quote!.querySelectorAll("mark")).map(
        (mark) => mark.textContent
      )
    ).toEqual(expect.arrayContaining(["M7", "棱镜攻势", "极品", "品质:S级"]));

    expect(screen.getByText("账号价值 86 / 100")).toBeInTheDocument();
    expect(screen.getByText("购买安全 75 / 100")).toBeInTheDocument();
    expect(screen.getByText("数据完整度 80 / 100")).toBeInTheDocument();
    expect(screen.getByText("中风险")).toBeInTheDocument();
    expect(screen.getByText("安全证据 2 / 3")).toBeInTheDocument();
    expect(screen.getByText("M7 综合价值 20 / 20")).toBeInTheDocument();
    expect(screen.getByText("角色红皮 20 / 25")).toBeInTheDocument();
    expect(screen.getByText("巨浪 20 / 20")).toBeInTheDocument();
    expect(screen.getByText("价格 23 / 25")).toBeInTheDocument();
    expect(screen.getByText("资产 9 / 10")).toBeInTheDocument();
  });

  it("shows trusted M7 finish tags, source evidence, and combined value", () => {
    const score = makeScore(88, { m7: 17 });
    score.valueReasons = [
      "M7 极品A，品质价值 13.0/16",
      "M7 稀有模板：珠光 M7 · 糖果 M7，价值 4.0/4"
    ];

    render(
      <ListingDetail
        listing={makeReviewedListing({
          m7RareFinishes: ["pearl", "candy"],
          m7RareFinishEvidence: [
            {
              text: "市场价5万+三角券的珠光粉M7",
              truncated: false
            },
            {
              text: "棱镜攻势M7—极品B糖果纸",
              truncated: false
            }
          ],
          score
        })}
        loading={false}
      />
    );

    expect(screen.getByText("高价值模板")).toBeInTheDocument();
    expect(screen.getByText("珠光 M7")).toBeInTheDocument();
    expect(screen.getByText("糖果 M7")).toBeInTheDocument();
    expect(screen.getByText("M7 综合价值 17 / 20")).toBeInTheDocument();
    expect(
      screen.getByText("M7 极品A，品质价值 13.0/16")
    ).toBeInTheDocument();
    expect(
      screen.getByText("M7 稀有模板：珠光 M7 · 糖果 M7，价值 4.0/4")
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "M7 稀有模板证据：市场价5万+三角券的珠光粉M7"
      )
    ).toHaveTextContent("市场价5万+三角券的珠光粉M7");
    expect(
      screen.getByLabelText(
        "M7 稀有模板证据：棱镜攻势M7—极品B糖果纸"
      )
    ).toHaveTextContent("棱镜攻势M7—极品B糖果纸");
    expect(screen.getAllByText(/珠光|糖果/).length).toBeGreaterThan(2);
  });

  it("keeps an untagged M7 finish explicitly pending verification", () => {
    render(
      <ListingDetail
        listing={makeReviewedListing({
          m7RareFinishes: [],
          m7RareFinishEvidence: []
        })}
        loading={false}
      />
    );

    expect(screen.getByText("稀有模板待核验")).toBeInTheDocument();
    expect(screen.queryByText("没有稀有模板")).not.toBeInTheDocument();
  });

  it("shows the listing scan stability and unchanged run count", () => {
    render(
      <ListingDetail
        listing={makeReviewedListing({
          scanStability: "stable",
          consecutiveUnchangedScans: 4
        })}
        loading={false}
      />
    );

    expect(screen.getByText("连续稳定 · 4 轮")).toBeInTheDocument();
  });

  it("shows availability, price movement and field-level changes", () => {
    const history: ListingHistoryView = {
      key: "panzhi:SA123",
      source: "panzhi",
      availability: "active",
      lastSeenAt: "2026-07-29T10:00:00.000Z",
      observations: [
        {
          runId: 2,
          observedAt: "2026-07-29T10:00:00.000Z",
          availability: "active",
          priceCny: 2199,
          snapshot: {
            priceCny: 2199,
            eligibility: "eligible",
            m7PrismStatus: "peak",
            m7PrismQuality: "S",
            m7RareFinishes: [],
            redSkins: ["威龙", "骇爪"],
            redSkinCount: 2,
            julangStatus: "owned",
            julangQuality: "极品",
            totalAssetsM: 300,
            hafCoins: 30_000_000,
            secondRealNameAvailable: true,
            recoveryCoverage: true,
            verificationAt: "2026-07-29T09:00:00.000Z",
            banNotes: [],
            confidence: 100,
            parseWarnings: []
          },
          changes: [
            {
              field: "priceCny",
              label: "价格",
              before: "¥1,888",
              after: "¥2,199"
            },
            {
              field: "m7PrismQuality",
              label: "M7 品质",
              before: "A",
              after: "S"
            }
          ]
        },
        {
          runId: 1,
          observedAt: "2026-07-28T10:00:00.000Z",
          availability: "active",
          priceCny: 1888,
          snapshot: {
            priceCny: 1888,
            eligibility: "eligible",
            m7PrismStatus: "peak",
            m7PrismQuality: "A",
            m7RareFinishes: [],
            redSkins: ["威龙"],
            redSkinCount: 1,
            julangStatus: "owned",
            julangQuality: "极品",
            totalAssetsM: 266,
            hafCoins: 28_880_000,
            secondRealNameAvailable: true,
            recoveryCoverage: true,
            verificationAt: "2026-07-27T10:00:00.000Z",
            banNotes: [],
            confidence: 100,
            parseWarnings: []
          },
          changes: []
        }
      ]
    };

    render(
      <ListingDetail
        listing={makeReviewedListing({ priceCny: 2199 })}
        loading={false}
        history={history}
        historyLoading={false}
        historyError={null}
      />
    );

    expect(screen.getByText("当前在售")).toBeInTheDocument();
    expect(screen.getByText("价格历史")).toBeInTheDocument();
    expect(screen.getByText("上涨 ¥311")).toBeInTheDocument();
    expect(screen.getAllByText("¥2,199")).toHaveLength(2);
    expect(screen.getByText("¥1,888")).toBeInTheDocument();
    expect(screen.getByText("M7 品质")).toBeInTheDocument();
    expect(screen.getByText("A → S")).toBeInTheDocument();
  });

  it("shows a local history error without hiding the listing", () => {
    render(
      <ListingDetail
        listing={makeReviewedListing()}
        loading={false}
        history={null}
        historyLoading={false}
        historyError="历史读取失败"
      />
    );

    expect(screen.getByText("SA123")).toBeInTheDocument();
    expect(screen.getByText("历史读取失败")).toBeInTheDocument();
  });

  it("offers one manual exclusion action for an unreviewed eligible account", async () => {
    const user = userEvent.setup();
    const listing = makeReviewedListing();
    const onExclude = vi.fn();
    const onRestore = vi.fn();

    render(
      <ListingDetail
        listing={listing}
        loading={false}
        onExclude={onExclude}
        onRestore={onRestore}
        reviewPending={false}
        reviewError={null}
      />
    );

    const action = screen.getByRole("button", {
      name: "人工淘汰"
    });
    expect(action).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "恢复参与排名" })
    ).not.toBeInTheDocument();

    await user.click(action);
    expect(onExclude).toHaveBeenCalledOnce();
    expect(onExclude).toHaveBeenCalledWith(listing);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("shows the review reason, note and time with one restore action", async () => {
    const user = userEvent.setup();
    const reviewedAt = "2026-07-31T08:00:00.000Z";
    const listing = makeReviewedListing(
      {},
      {
        excluded: true,
        reason: "price_overvalued",
        note: "同价位有更安全的号",
        reviewedAt
      }
    );
    const onRestore = vi.fn();
    const { container } = render(
      <ListingDetail
        listing={listing}
        loading={false}
        onExclude={vi.fn()}
        onRestore={onRestore}
        reviewPending={false}
        reviewError={null}
      />
    );

    expect(screen.getByText("人工淘汰 · 价格虚高")).toBeInTheDocument();
    expect(screen.getByText("同价位有更安全的号")).toBeInTheDocument();
    expect(
      container.querySelector(`time[datetime="${reviewedAt}"]`)
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "人工淘汰" })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "恢复参与排名" })
    );
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledWith(listing);
  });

  it("passes the same manual review action through the mobile drawer", async () => {
    const user = userEvent.setup();
    const listing = makeReviewedListing();
    const onExclude = vi.fn();

    render(
      <DetailDrawer
        listing={listing}
        loading={false}
        history={null}
        historyLoading={false}
        historyError={null}
        reviewPending={false}
        reviewError={null}
        onExclude={onExclude}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "人工淘汰" })
    );
    expect(onExclude).toHaveBeenCalledWith(listing);
  });
});
