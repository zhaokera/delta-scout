import { render, screen } from "@testing-library/react";
import { ListingDetail } from "../../src/client/components/ListingDetail";
import { makeListing } from "../domain/listingFactory";

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

  it("shows a bounded highlighted M7 excerpt and all five score parts", () => {
    const evidenceText =
      `${"冗长的商品说明".repeat(40)}M7 棱镜攻势 极品 品质:S级${"其它资产".repeat(40)}`;
    const { container } = render(
      <ListingDetail
        listing={makeListing({
          m7Evidence: [{ text: evidenceText, truncated: false }],
          score: {
            total: 91,
            parts: {
              safety: 27,
              skinValue: 29,
              price: 18,
              assets: 9,
              confidence: 8
            },
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

    expect(screen.getByText("安全信息 27 / 30")).toBeInTheDocument();
    expect(screen.getByText("皮肤价值 29 / 30")).toBeInTheDocument();
    expect(screen.getByText("价格 18 / 20")).toBeInTheDocument();
    expect(screen.getByText("资产 9 / 10")).toBeInTheDocument();
    expect(screen.getByText("置信度 8 / 10")).toBeInTheDocument();
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
});
