import { describe, expect, it } from "vitest";
import { makeListing, makeScore } from "../domain/listingFactory.js";
import {
  canReuseListingDetail,
  detailReuseMaxAge
} from "../../src/server/collector/detailReuse.js";

function summary() {
  return {
    source: "jiaoyimao" as const,
    sourceListingId: "1785000000000000",
    title: "双红皮高资产账号",
    rawText: "QQ官服 可二次实名 双红皮 总资产500M",
    priceCny: 2500
  };
}

function trustedListing(score = 55) {
  const card = summary();
  return makeListing({
    key: `jiaoyimao:${card.sourceListingId}`,
    source: "jiaoyimao",
    sourceListingId: card.sourceListingId,
    title: card.title,
    originalDescription: `${card.rawText}\n动态资产与安全报告`,
    capturedAt: "2026-08-02T01:00:00.000Z",
    verificationAt: "2026-08-02T01:00:00.000Z",
    priceCny: 2800,
    m7PrismStatus: "absent",
    m7PrismQuality: null,
    m7Evidence: [],
    score: makeScore(score)
  });
}

describe("detail reuse", () => {
  it("reuses complete unchanged evidence even when the account has no M7", () => {
    expect(
      canReuseListingDetail(
        trustedListing(),
        summary(),
        new Date("2026-08-02T05:00:00.000Z")
      )
    ).toBe(true);
  });

  it("uses a shorter six-hour window for Top30-border candidates", () => {
    expect(detailReuseMaxAge(trustedListing(65))).toBe(6 * 60 * 60 * 1000);
    expect(
      canReuseListingDetail(
        trustedListing(65),
        summary(),
        new Date("2026-08-02T08:00:01.000Z")
      )
    ).toBe(false);
    expect(
      canReuseListingDetail(
        trustedListing(55),
        summary(),
        new Date("2026-08-02T08:00:01.000Z")
      )
    ).toBe(true);
  });

  it("reuses unchanged evidence without requiring display-only fields", () => {
    const listing = trustedListing(0);
    const displayFieldsMissing = {
      ...listing,
      eligibility: "needs_verification" as const,
      loginPlatform: "unknown" as const,
      service: "unknown" as const,
      recoveryCoverage: null,
      verificationAt: null,
      score: null
    };

    expect(detailReuseMaxAge(displayFieldsMissing)).toBe(
      6 * 60 * 60 * 1000
    );
    expect(canReuseListingDetail(
      displayFieldsMissing,
      summary(),
      new Date("2026-08-02T06:59:59.000Z")
    )).toBe(true);
    expect(canReuseListingDetail(
      displayFieldsMissing,
      summary(),
      new Date("2026-08-02T07:00:01.000Z")
    )).toBe(false);
  });

  it("uses the local capture time instead of the seller verification time", () => {
    const listing = {
      ...trustedListing(55),
      verificationAt: "2025-01-01T00:00:00.000Z"
    };

    expect(canReuseListingDetail(
      listing,
      summary(),
      new Date("2026-08-02T06:00:00.000Z")
    )).toBe(true);
  });

  it("does not reuse evidence after visible card content changes", () => {
    expect(
      canReuseListingDetail(
        trustedListing(),
        { ...summary(), rawText: "QQ官服 可二次实名 总资产900M" },
        new Date("2026-08-02T05:00:00.000Z")
      )
    ).toBe(false);
  });
});
