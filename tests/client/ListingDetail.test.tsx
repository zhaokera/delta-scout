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
});
