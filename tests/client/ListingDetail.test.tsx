import { render, screen } from "@testing-library/react";
import { ListingDetail } from "../../src/client/components/ListingDetail";
import type { ListingHistoryView } from "../../src/client/api";
import { makeListing, makeScore } from "../domain/listingFactory";

describe("ListingDetail", () => {
  it("prominently flags a peak M7 whose grade is missing", () => {
    render(
      <ListingDetail
        listing={makeListing({
          m7PrismStatus: "peak",
          m7PrismQuality: null
        })}
        loading={false}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("极品品质待核验");
  });

  it("shows a bounded M7 excerpt and separates value from purchase risk", () => {
    const evidenceText =
      `${"冗长的商品说明".repeat(40)}M7 棱镜攻势 极品 品质:S级${"其它资产".repeat(40)}`;
    const { container } = render(
      <ListingDetail
        listing={makeListing({
          m7Evidence: [{ text: evidenceText, truncated: false }],
          score: {
            total: 91,
            value: 86,
            safety: 75,
            dataQuality: 80,
            riskLevel: "medium",
            coverage: {
              knownSafetySignals: 2,
              totalSafetySignals: 3
            },
            parts: {
              m7: 35,
              redSkins: 16,
              julang: 15,
              price: 18,
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
    expect(screen.getByText("M7 综合价值 35 / 35")).toBeInTheDocument();
    expect(screen.getByText("角色红皮 16 / 20")).toBeInTheDocument();
    expect(screen.getByText("巨浪 15 / 15")).toBeInTheDocument();
    expect(screen.getByText("价格 18 / 20")).toBeInTheDocument();
    expect(screen.getByText("资产 9 / 10")).toBeInTheDocument();
  });

  it("shows trusted M7 finish tags, source evidence, and combined value", () => {
    const score = makeScore(88, { m7: 31 });
    score.valueReasons = [
      "M7 极品A，品质价值 23.0/27",
      "M7 稀有模板：珠光 M7 · 糖果 M7，价值 8.0/8"
    ];

    render(
      <ListingDetail
        listing={makeListing({
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
    expect(screen.getByText("M7 综合价值 31 / 35")).toBeInTheDocument();
    expect(
      screen.getByText("M7 极品A，品质价值 23.0/27")
    ).toBeInTheDocument();
    expect(
      screen.getByText("M7 稀有模板：珠光 M7 · 糖果 M7，价值 8.0/8")
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
        listing={makeListing({
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
        listing={makeListing({
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
        listing={makeListing({ priceCny: 2199 })}
        loading={false}
        history={history}
        historyLoading={false}
        historyError={null}
      />
    );

    expect(screen.getByText("当前在售")).toBeInTheDocument();
    expect(screen.getByText("价格历史")).toBeInTheDocument();
    expect(screen.getByText("上涨 ¥311")).toBeInTheDocument();
    expect(screen.getByText("¥2,199")).toBeInTheDocument();
    expect(screen.getByText("¥1,888")).toBeInTheDocument();
    expect(screen.getByText("M7 品质")).toBeInTheDocument();
    expect(screen.getByText("A → S")).toBeInTheDocument();
  });

  it("shows a local history error without hiding the listing", () => {
    render(
      <ListingDetail
        listing={makeListing()}
        loading={false}
        history={null}
        historyLoading={false}
        historyError="历史读取失败"
      />
    );

    expect(screen.getByText("SA123")).toBeInTheDocument();
    expect(screen.getByText("历史读取失败")).toBeInTheDocument();
  });
});
