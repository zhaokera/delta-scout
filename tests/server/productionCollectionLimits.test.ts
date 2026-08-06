import { describe, expect, it } from "vitest";
import {
  PRODUCTION_COLLECTION_LIMITS_BY_SOURCE
} from "../../src/server/collector/productionLimits.js";

describe("production collection limits", () => {
  it("cannot truncate the Jiaoyimao catalog at the detail stage", () => {
    const limits = PRODUCTION_COLLECTION_LIMITS_BY_SOURCE.jiaoyimao;

    expect(limits.maxDetails).toBeGreaterThanOrEqual(
      limits.maxSummaries
    );
  });
});
