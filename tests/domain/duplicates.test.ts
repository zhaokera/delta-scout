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

  it("bounds duplicate annotations for 6000 same-signature listings", () => {
    const sources = ["jiaoyimao", "panzhi", "pxb7"] as const;
    const listings = Array.from({ length: 6_000 }, (_, index) => {
      const source = sources[index % sources.length];
      return makeListing({
        key: `${source}:${index}`,
        source,
        sourceListingId: String(index),
        url: `https://${source}.test/item/${index}`,
        totalAssetsM: 266,
        hafCoins: 28_880_000,
        possibleDuplicateKeys: []
      });
    });
    const original = structuredClone(listings);

    const results = markPossibleDuplicates(listings);

    expect(results).toHaveLength(6_000);
    expect(
      results.every(
        ({ possibleDuplicateKeys }) =>
          possibleDuplicateKeys.length > 0 &&
          possibleDuplicateKeys.length <= 2
      )
    ).toBe(true);
    expect(
      results.reduce(
        (count, { possibleDuplicateKeys }) =>
          count + possibleDuplicateKeys.length,
        0
      )
    ).toBeLessThanOrEqual(12_000);
    expect(listings).toEqual(original);
  });

  it("chooses duplicate representatives independently of input order", () => {
    const listings = (
      ["jiaoyimao", "panzhi", "pxb7"] as const
    ).flatMap((source) =>
      [1, 2].map((index) =>
        makeListing({
          key: `${source}:${index}`,
          source,
          sourceListingId: String(index),
          url: `https://${source}.test/item/${index}`,
          totalAssetsM: 266
        })
      )
    );
    const byKey = (results: ReturnType<typeof markPossibleDuplicates>) =>
      Object.fromEntries(
        results.map(({ key, possibleDuplicateKeys }) => [
          key,
          possibleDuplicateKeys
        ])
      );

    expect(byKey(markPossibleDuplicates([...listings].reverse()))).toEqual(
      byKey(markPossibleDuplicates(listings))
    );
  });
});
