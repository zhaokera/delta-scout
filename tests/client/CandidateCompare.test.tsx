import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import {
  CandidateCompareDialog,
  CompareTray
} from "../../src/client/components/CandidateCompare";
import type { Listing } from "../../src/domain/listing";
import type { ReviewedListing } from "../../src/domain/manualReview";
import { makeListing, makeScore } from "../domain/listingFactory";

function reviewed(overrides: Partial<Listing>): ReviewedListing {
  return { ...makeListing(overrides), manualReview: null };
}

const first = reviewed({
  key: "jiaoyimao:1",
  source: "jiaoyimao",
  sourceListingId: "JYM-1",
  priceCny: 3_500,
  score: {
    ...makeScore(78),
    riskLevel: "low",
    coverage: { knownSafetySignals: 1, totalSafetySignals: 1 }
  },
  m7RareFinishes: ["pearl"]
});
const second = reviewed({
  key: "pxb7:2",
  source: "pxb7",
  sourceListingId: "PXB-2",
  priceCny: 2_250,
  score: {
    ...makeScore(71),
    riskLevel: "low",
    coverage: { knownSafetySignals: 1, totalSafetySignals: 1 }
  }
});

describe("candidate comparison", () => {
  it("requires two candidates before opening comparison", () => {
    const { rerender } = render(
      <CompareTray
        listings={[first]}
        onRemove={() => undefined}
        onClear={() => undefined}
        onOpen={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "再选 1 个" }))
      .toBeDisabled();

    rerender(
      <CompareTray
        listings={[first, second]}
        onRemove={() => undefined}
        onClear={() => undefined}
        onOpen={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "开始对比" }))
      .toBeEnabled();
  });

  it("highlights best values and supports remove and Escape", async () => {
    const onRemove = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CandidateCompareDialog
        listings={[first, second]}
        onRemove={onRemove}
        onClose={onClose}
      />
    );

    expect(screen.getByRole("dialog", {
      name: "候选账号横向对比"
    })).toBeInTheDocument();
    expect(screen.getByText("珠光")).toBeInTheDocument();
    expect(screen.getByText("最高分")).toBeInTheDocument();
    expect(screen.getByText("最低价")).toBeInTheDocument();
    expect(screen.getAllByText("低风险 · 1/1")).toHaveLength(2);
    expect(screen.getAllByText("资产回收率")).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: "移除对比 PXB-2" })
    );
    expect(onRemove).toHaveBeenCalledWith(second.key);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
