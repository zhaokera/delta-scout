import { markPossibleDuplicates } from "../../src/domain/duplicates";
import { makeListing } from "./listingFactory";

describe("markPossibleDuplicates", () => {
  it("flags strict cross-platform matches without merging them", () => {
    const left = makeListing({ key: "panzhi:left" });
    const right = makeListing({
      key: "pxb7:right",
      source: "pxb7",
      totalAssetsM: 266.4
    });

    const results = markPossibleDuplicates([left, right]);

    expect(results).toHaveLength(2);
    expect(results[0].possibleDuplicateKeys).toEqual(["pxb7:right"]);
    expect(results[1].possibleDuplicateKeys).toEqual(["panzhi:left"]);
  });

  it("does not flag matches with missing strict evidence", () => {
    const left = makeListing({ key: "panzhi:left", hafCoins: null });
    const right = makeListing({ key: "pxb7:right", source: "pxb7" });

    expect(
      markPossibleDuplicates([left, right]).every(
        ({ possibleDuplicateKeys }) => possibleDuplicateKeys.length === 0
      )
    ).toBe(true);
  });
});
