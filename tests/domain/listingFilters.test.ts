import {
  hasCompleteKeyEvidence,
  matchesListingFilters,
  type ListingFilters
} from "../../src/domain/listingFilters.js";
import { makeListing } from "./listingFactory.js";

const DEFAULT_FILTERS: ListingFilters = {
  source: "all",
  secondRealName: false,
  recoveryCoverage: false,
  redSkin: "",
  julang: "all",
  m7Quality: "all",
  minRedSkinCount: 0,
  evidenceCompleteness: "all",
  stability: "all"
};

describe("listing filters", () => {
  it("defines complete key evidence from the four purchase fields", () => {
    const complete = makeListing();

    expect(hasCompleteKeyEvidence(complete)).toBe(true);
    for (const incomplete of [
      makeListing({ priceCny: null }),
      makeListing({ secondRealNameAvailable: null }),
      makeListing({ recoveryCoverage: null }),
      makeListing({ verificationAt: null })
    ]) {
      expect(hasCompleteKeyEvidence(incomplete)).toBe(false);
    }
  });

  it("treats M7 as an optional quality tag", () => {
    expect(hasCompleteKeyEvidence(makeListing({
      m7PrismStatus: "absent",
      m7PrismQuality: null,
      m7Evidence: []
    }))).toBe(true);
  });

  it("applies the existing platform and safety filters strictly", () => {
    const listing = makeListing({
      source: "panzhi",
      secondRealNameAvailable: true,
      recoveryCoverage: false
    });

    expect(matchesListingFilters(listing, {
      ...DEFAULT_FILTERS,
      source: "panzhi",
      secondRealName: true
    })).toBe(true);
    expect(matchesListingFilters(listing, {
      ...DEFAULT_FILTERS,
      source: "pxb7"
    })).toBe(false);
    expect(matchesListingFilters(listing, {
      ...DEFAULT_FILTERS,
      recoveryCoverage: true
    })).toBe(false);
  });

  it("normalizes whitespace and case when searching named red skins", () => {
    const listing = makeListing({
      redSkins: ["  HackClaw  ", "威 龙"]
    });

    expect(matchesListingFilters(listing, {
      ...DEFAULT_FILTERS,
      redSkin: " hackclaw "
    })).toBe(true);
    expect(matchesListingFilters(listing, {
      ...DEFAULT_FILTERS,
      redSkin: "威龙"
    })).toBe(true);
    expect(matchesListingFilters(listing, {
      ...DEFAULT_FILTERS,
      redSkin: "露娜"
    })).toBe(false);
  });

  it("uses the parsed named count and never promotes unnamed red skins", () => {
    expect(matchesListingFilters(makeListing({
      redSkinCount: 2,
      redSkinUnnamed: false
    }), {
      ...DEFAULT_FILTERS,
      minRedSkinCount: 2
    })).toBe(true);

    expect(matchesListingFilters(makeListing({
      redSkins: [],
      redSkinCount: null,
      redSkinUnnamed: true
    }), {
      ...DEFAULT_FILTERS,
      minRedSkinCount: 1
    })).toBe(false);
  });

  it.each([
    ["owned", "owned", true],
    ["absent", "absent", true],
    ["unknown", "unknown", true],
    ["owned", "unknown", false]
  ] as const)(
    "matches the %s 巨浪 filter against %s",
    (filter, status, expected) => {
      expect(matchesListingFilters(makeListing({
        julangStatus: status
      }), {
        ...DEFAULT_FILTERS,
        julang: filter
      })).toBe(expected);
    }
  );

  it.each(["S", "A", "B", "C"] as const)(
    "matches M7 quality %s exactly",
    (quality) => {
      expect(matchesListingFilters(makeListing({
        m7PrismQuality: quality
      }), {
        ...DEFAULT_FILTERS,
        m7Quality: quality
      })).toBe(true);
      expect(matchesListingFilters(makeListing({
        m7PrismQuality: quality === "S" ? "A" : "S"
      }), {
        ...DEFAULT_FILTERS,
        m7Quality: quality
      })).toBe(false);
    }
  );

  it.each([
    ["complete", makeListing(), true],
    ["complete", makeListing({ verificationAt: null }), false],
    ["unknown", makeListing({ verificationAt: null }), true],
    ["unknown", makeListing(), false]
  ] as const)(
    "matches evidence completeness %s",
    (evidenceCompleteness, listing, expected) => {
      expect(matchesListingFilters(listing, {
        ...DEFAULT_FILTERS,
        evidenceCompleteness
      })).toBe(expected);
    }
  );

  it.each(["stable", "new", "changed"] as const)(
    "matches scan stability %s exactly",
    (stability) => {
      expect(matchesListingFilters(makeListing({
        scanStability: stability
      }), {
        ...DEFAULT_FILTERS,
        stability
      })).toBe(true);
      expect(matchesListingFilters(makeListing({
        scanStability: "unknown"
      }), {
        ...DEFAULT_FILTERS,
        stability
      })).toBe(false);
    }
  );

  it("allows every field when all/default values are selected", () => {
    expect(matchesListingFilters(makeListing({
      priceCny: null,
      m7PrismQuality: null,
      secondRealNameAvailable: null,
      recoveryCoverage: null,
      verificationAt: null,
      redSkinCount: null,
      julangStatus: "unknown",
      scanStability: "unknown"
    }), DEFAULT_FILTERS)).toBe(true);
  });
});
