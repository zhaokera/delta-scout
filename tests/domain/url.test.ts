import { listingKey, normalizeListingUrl } from "../../src/domain/url";

describe("normalizeListingUrl", () => {
  it("removes tracking and fragments while keeping business parameters", () => {
    expect(
      normalizeListingUrl(
        "https://WWW.PZDS.COM/item/?id=SA1&utm_source=x&spm=1&from=feed#detail"
      )
    ).toBe("https://www.pzds.com/item?id=SA1");
  });
});

describe("listingKey", () => {
  it("prefers a platform listing id", () => {
    expect(
      listingKey("panzhi", "SA1", "https://www.pzds.com/item?id=SA1")
    ).toBe("panzhi:SA1");
  });

  it("falls back to the normalized URL", () => {
    expect(
      listingKey(
        "panzhi",
        null,
        "https://www.pzds.com/item/?id=SA1&utm_source=x"
      )
    ).toBe("panzhi:https://www.pzds.com/item?id=SA1");
  });
});
