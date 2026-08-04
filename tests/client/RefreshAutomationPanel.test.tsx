import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { RefreshAutomationPanel } from "../../src/client/components/RefreshAutomationPanel";
import type {
  PanzhiAutomationStatusView,
  RefreshEventView,
  RefreshScheduleView
} from "../../src/client/api";

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

function panzhiSchedule(): RefreshScheduleView {
  return {
    source: "panzhi",
    enabled: true,
    quickIntervalMinutes: 120,
    deepIntervalMinutes: 1440,
    nextQuickAt: "2026-08-02T12:00:00.000Z",
    nextDeepAt: "2026-08-03T12:00:00.000Z",
    lastStartedAt: null,
    lastFinishedAt: null,
    lastMode: null,
    lastState: "running",
    consecutiveFailures: 0,
    backoffUntil: null,
    lastError: null,
    attentionRequired: false
  };
}

function panzhiStatus(
  overrides: Partial<PanzhiAutomationStatusView> = {}
): PanzhiAutomationStatusView {
  return {
    connected: true,
    lastHeartbeatAt: "2026-08-04T08:00:00.000Z",
    currentJob: {
      id: "5a89a54c-47ef-49c0-b48f-8f931ddf0c8b",
      mode: "quick",
      state: "queued",
      leaseExpiresAt: null,
      verificationDeadlineAt: null,
      verificationNotifiedAt: null,
      error: null,
      scanRunId: null,
      createdAt: "2026-08-04T08:00:00.000Z",
      updatedAt: "2026-08-04T08:00:00.000Z",
      finishedAt: null
    },
    ...overrides
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

  it("shows connected and disconnected Chrome extension health", () => {
    const { rerender } = render(<RefreshAutomationPanel
      schedules={[panzhiSchedule()]}
      events={[]}
      busy={false}
      panzhiAutomation={panzhiStatus()}
      onRefresh={() => undefined}
      onAcknowledge={() => undefined}
    />);

    expect(screen.getByText("Chrome 自动刷新已连接"))
      .toBeInTheDocument();
    expect(screen.getByText(/^更新 \d{2}\/\d{2} \d{2}:\d{2}$/))
      .toBeInTheDocument();

    rerender(<RefreshAutomationPanel
      schedules={[panzhiSchedule()]}
      events={[]}
      busy={false}
      panzhiAutomation={panzhiStatus({
        connected: false,
        lastHeartbeatAt: null,
        currentJob: null
      })}
      onRefresh={() => undefined}
      onAcknowledge={() => undefined}
    />);

    expect(screen.getByText("Chrome 自动刷新未连接"))
      .toBeInTheDocument();
    expect(screen.getByText("extensions/panzhi-auto-refresh/dist/"))
      .toBeInTheDocument();
  });

  it.each([
    ["queued", "等待 Chrome 扩展领取"],
    ["opening_page", "正在复用或打开盼之标签页"],
    ["applying_filters", "正在设置并核对原生筛选"],
    ["collecting", "正在读取商品卡片"],
    ["awaiting_user_verification", "等待你完成 Chrome 验证"],
    ["submitting", "正在提交可信快照"],
    ["success", "自动刷新成功"],
    ["failed", "自动刷新失败"],
    ["cancelled", "自动刷新已取消"]
  ] as const)("renders the %s automatic stage", (state, label) => {
    render(<RefreshAutomationPanel
      schedules={[panzhiSchedule()]}
      events={[]}
      busy={false}
      panzhiAutomation={panzhiStatus({
        currentJob: {
          ...panzhiStatus().currentJob!,
          state
        }
      })}
      onRefresh={() => undefined}
      onAcknowledge={() => undefined}
    />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("pauses visibly for verification without implying it can solve the challenge", () => {
    render(<RefreshAutomationPanel
      schedules={[panzhiSchedule()]}
      events={[]}
      busy={false}
      panzhiAutomation={panzhiStatus({
        currentJob: {
          ...panzhiStatus().currentJob!,
          state: "awaiting_user_verification",
          verificationDeadlineAt: "2026-08-05T08:00:00.000Z"
        }
      })}
      onRefresh={() => undefined}
      onAcknowledge={() => undefined}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "请在已打开的 Chrome 盼之页面完成可见验证码或滑块"
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "完成后会自动继续"
    );
  });

  it("queues quick and deep work without using those controls as links", () => {
    const onRefresh = vi.fn();
    render(<RefreshAutomationPanel
      schedules={[panzhiSchedule()]}
      events={[]}
      busy={false}
      panzhiAutomation={panzhiStatus()}
      onRefresh={onRefresh}
      onAcknowledge={() => undefined}
    />);

    const card = screen.getByText("盼之").closest("article");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".refresh-schedule__actions--panzhi"))
      .toBeInTheDocument();
    fireEvent.click(within(card!).getByRole("button", {
      name: "立即快速刷新"
    }));
    fireEvent.click(within(card!).getByRole("button", {
      name: "立即完整刷新"
    }));

    expect(onRefresh).toHaveBeenNthCalledWith(1, "panzhi", "quick");
    expect(onRefresh).toHaveBeenNthCalledWith(2, "panzhi", "deep");
    expect(within(card!).queryByRole("link", {
      name: /立即.*刷新/
    })).not.toBeInTheDocument();
    expect(within(card!).getByRole("link", {
      name: "打开盼之诊断页"
    })).toHaveAttribute("href", "https://www.pzds.com/goodsList/391/6");
  });
});
