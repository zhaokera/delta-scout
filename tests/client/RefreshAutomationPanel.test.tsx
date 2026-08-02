import { render, screen } from "@testing-library/react";
import { RefreshAutomationPanel } from "../../src/client/components/RefreshAutomationPanel";
import type { RefreshEventView, RefreshScheduleView } from "../../src/client/api";

function removal(id: number): RefreshEventView {
  return {
    id,
    runId: 9,
    source: "pxb7",
    listingKey: `pxb7:${id}`,
    type: "removed",
    severity: "warning",
    title: "候选已不在最新快照",
    message: "可能已下架",
    details: {},
    createdAt: "2026-08-02T12:00:00.000Z",
    acknowledged: false
  };
}

describe("RefreshAutomationPanel", () => {
  it("groups removal noise from one run while preserving opportunities", () => {
    const priceDrop: RefreshEventView = {
      ...removal(3),
      type: "price_drop",
      severity: "opportunity",
      title: "候选降价",
      message: "降价 ¥100"
    };
    render(<RefreshAutomationPanel
      schedules={[]}
      events={[removal(1), removal(2), priceDrop]}
      busy={false}
      onRefresh={() => undefined}
      onAcknowledge={() => undefined}
    />);

    expect(screen.getByText("螃蟹本轮 2 个候选离开最新快照"))
      .toBeInTheDocument();
    expect(screen.getByText("候选降价")).toBeInTheDocument();
    expect(screen.queryByText("候选已不在最新快照"))
      .not.toBeInTheDocument();
  });

  it("makes a due Panzhi snapshot state explicit", () => {
    const schedule: RefreshScheduleView = {
      source: "panzhi",
      enabled: true,
      quickIntervalMinutes: 120,
      deepIntervalMinutes: 1440,
      nextQuickAt: "2026-08-02T12:00:00.000Z",
      nextDeepAt: "2026-08-03T12:00:00.000Z",
      lastStartedAt: null,
      lastFinishedAt: null,
      lastMode: null,
      lastState: "attention_required",
      consecutiveFailures: 0,
      backoffUntil: null,
      lastError: null,
      attentionRequired: true
    };
    render(<RefreshAutomationPanel
      schedules={[schedule]}
      events={[]}
      busy={false}
      onRefresh={() => undefined}
      onAcknowledge={() => undefined}
    />);

    expect(screen.getByText("等待人工快照")).toBeInTheDocument();
    expect(screen.getByText(/已到本轮刷新时间/)).toBeInTheDocument();
  });
});
