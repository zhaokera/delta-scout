import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ListingTable } from "../../src/client/components/ListingTable";
import { makeListing } from "../domain/listingFactory";

describe("ListingTable", () => {
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
});
