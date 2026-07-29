import { buildMidrankPercentiles } from "../../src/domain/percentile";

describe("buildMidrankPercentiles", () => {
  it("assigns equal values the same middle rank", () => {
    expect(
      buildMidrankPercentiles([10, 20, 20, 40])
    ).toEqual(new Map([
      [10, 0],
      [20, 0.5],
      [40, 1]
    ]));
  });

  it("uses a neutral percentile for a single finite value", () => {
    expect(buildMidrankPercentiles([7])).toEqual(new Map([[7, 0.5]]));
  });

  it("excludes missing and non-finite values", () => {
    expect(
      buildMidrankPercentiles([null, Number.NaN, 10, Infinity, 30])
    ).toEqual(new Map([
      [10, 0],
      [30, 1]
    ]));
  });
});
