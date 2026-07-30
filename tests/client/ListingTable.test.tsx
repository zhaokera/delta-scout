import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ListingTable } from "../../src/client/components/ListingTable";
import { makeListing } from "../domain/listingFactory";

describe("ListingTable", () => {
  it("shows the exact M7 peak grade", () => {
    render(
      <ListingTable
        listings={[makeListing({ m7PrismQuality: "S" })]}
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
          makeListing({
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
        listings={[makeListing({ m7RareFinishes: [] })]}
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
      makeListing({ key: "panzhi:expensive", priceCny: 5500 }),
      makeListing({
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
          makeListing({
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
        listings={[makeListing({ scanStability })]}
        selectedKey={null}
        sort="score"
        onSortChange={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
