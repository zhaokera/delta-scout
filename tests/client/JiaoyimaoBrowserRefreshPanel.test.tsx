import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import {
  JiaoyimaoBrowserRefreshPanel,
  type JiaoyimaoBrowserRefreshPanelProps
} from "../../src/client/components/JiaoyimaoBrowserRefreshPanel";
import {
  httpScoutApi,
  type JiaoyimaoBrowserRefreshJob,
  type JiaoyimaoBrowserRefreshState
} from "../../src/client/api";

function makeJob(
  overrides: Partial<JiaoyimaoBrowserRefreshJob> = {}
): JiaoyimaoBrowserRefreshJob {
  return {
    id: "job-17",
    source: "jiaoyimao",
    state: "collecting_details",
    stage: "details",
    reason: null,
    claimedAt: "2026-07-31T01:00:00.000Z",
    createdAt: "2026-07-31T00:59:00.000Z",
    updatedAt: "2026-07-31T01:01:00.000Z",
    finishedAt: null,
    expiresAt: "2026-07-31T01:30:00.000Z",
    listBatchCursor: 3,
    detailCompletedCount: 7,
    detailRequiredCount: 12,
    uniqueItemCount: 48,
    itemCount: 48,
    loadActionCount: 4,
    cooldownAttempt: 0,
    cooldownUntil: null,
    nextActionAt: null,
    actionPermitExpiresAt: null,
    actionPermitConsumedAt: null,
    filterUrl: "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/",
    lastError: null,
    scanRunId: null,
    publishedRunId: null,
    ...overrides
  };
}

function makeProps(
  overrides: Partial<JiaoyimaoBrowserRefreshPanelProps> = {}
): JiaoyimaoBrowserRefreshPanelProps {
  return {
    job: null,
    claimCode: null,
    conflict: null,
    busy: false,
    error: null,
    now: new Date("2026-07-31T01:00:00.000Z"),
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onKeepWaiting: vi.fn(),
    ...overrides
  };
}

const STATE_LABELS: Record<JiaoyimaoBrowserRefreshState, string> = {
  awaiting_codex: "等待 Codex 接管",
  collecting_list: "正在采集列表",
  collecting_details: "正在核验详情",
  awaiting_user_verification: "等待人工验证",
  cooling_down: "限流冷却中",
  validating: "正在校验完整性",
  committing: "正在提交可信快照",
  success: "刷新完成",
  quarantined: "新结果已隔离",
  paused: "任务已暂停",
  failed: "刷新失败",
  cancelled: "已取消",
  expired: "任务已过期"
};

describe("JiaoyimaoBrowserRefreshPanel", () => {
  it("starts idle with one clear refresh action", async () => {
    const user = userEvent.setup();
    const props = makeProps();

    render(<JiaoyimaoBrowserRefreshPanel {...props} />);

    expect(
      screen.getByRole("heading", { name: "交易猫可信刷新" })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新交易猫" }));
    expect(props.onStart).toHaveBeenCalledOnce();
  });

  it("shows the one-time claim code only from the start response", () => {
    const { rerender } = render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          job: makeJob({ state: "awaiting_codex" }),
          claimCode: "JYM-ONE-TIME-7"
        })}
      />
    );

    expect(screen.getByText("等待 Codex 接管")).toBeInTheDocument();
    expect(screen.getByText("JYM-ONE-TIME-7")).toBeInTheDocument();
    expect(screen.getByText(/仅显示一次/)).toBeInTheDocument();

    rerender(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          job: makeJob({ state: "awaiting_codex" }),
          claimCode: null
        })}
      />
    );

    expect(screen.queryByText("JYM-ONE-TIME-7")).not.toBeInTheDocument();
    expect(screen.getByText(/刷新页面后不会恢复/)).toBeInTheDocument();
  });

  it.each(Object.entries(STATE_LABELS))(
    "renders an approved Chinese label for %s",
    (state, label) => {
      render(
        <JiaoyimaoBrowserRefreshPanel
          {...makeProps({
            job: makeJob({
              state: state as JiaoyimaoBrowserRefreshState
            })
          })}
        />
      );

      expect(screen.getByTestId("browser-refresh-state")).toHaveTextContent(
        label
      );
    }
  );

  it("reports real list and detail progress without fabricating credentials", () => {
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({ job: makeJob(), claimCode: null })}
      />
    );

    expect(screen.getByText("已发现 48 个账号")).toBeInTheDocument();
    expect(screen.getByText("详情 7 / 12")).toBeInTheDocument();
    expect(screen.queryByLabelText("交易猫接管码")).not.toBeInTheDocument();
    expect(screen.queryByText(/一次性接管码/)).not.toBeInTheDocument();
  });

  it("derives cooldown remaining only from the server deadline", () => {
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          now: new Date("2026-07-31T01:00:00.000Z"),
          job: makeJob({
            state: "cooling_down",
            cooldownUntil: "2026-07-31T01:02:05.000Z",
            nextActionAt: "2026-07-31T04:30:00.000Z"
          })
        })}
      />
    );

    expect(screen.getByText("剩余 2分05秒")).toBeInTheDocument();
    expect(screen.queryByText(/3小时/)).not.toBeInTheDocument();
  });

  it("asks for verification in the same Codex browser tab", () => {
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          job: makeJob({
            state: "awaiting_user_verification",
            reason: "captcha_required"
          })
        })}
      />
    );

    expect(
      screen.getByText(/请在当前 Codex 浏览器标签页完成验证/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "我还在处理，继续等待" })
    ).toBeInTheDocument();
  });

  it("explains that quarantining preserves the old snapshot", () => {
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          job: makeJob({ state: "quarantined", publishedRunId: null })
        })}
      />
    );

    expect(
      screen.getByText(/旧的可信快照和现有候选仍会继续展示/)
    ).toBeInTheDocument();
  });

  it("confirms cancellation and states that existing candidates are preserved", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({ job: makeJob(), onCancel })}
      />
    );

    await user.click(screen.getByRole("button", { name: "取消本次刷新" }));
    const dialog = screen.getByRole("dialog", { name: "确认取消交易猫刷新" });
    expect(dialog).toHaveTextContent("现有候选和旧快照都会保留");
    await user.click(within(dialog).getByRole("button", { name: "确认取消" }));
    expect(onCancel).toHaveBeenCalledWith("job-17");
  });

  it("announces conflicts and exposes busy state accessibly", () => {
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          busy: true,
          conflict: {
            activeKind: "all_sources",
            message: "全平台刷新正在运行"
          }
        })}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("全平台刷新正在运行");
    expect(screen.getByRole("region", { name: "交易猫浏览器刷新" }))
      .toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "刷新交易猫" }))
      .toBeDisabled();
  });

  it("uses touch-sized responsive control classes without a fixed-width shell", () => {
    const { container } = render(
      <JiaoyimaoBrowserRefreshPanel {...makeProps()} />
    );

    expect(container.querySelector(".browser-refresh-panel__actions"))
      .toBeInTheDocument();
    expect(container.querySelector(".browser-refresh-panel__primary"))
      .toBeInTheDocument();
    expect(container.querySelector("[style*='width']")).not.toBeInTheDocument();
  });
});

describe("httpScoutApi Jiaoyimao browser refresh", () => {
  it("calls current, start, keep-waiting, and cancel with typed routes", async () => {
    const job = makeJob();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(job), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          jobId: job.id,
          state: "awaiting_codex",
          claimCode: "ONE-TIME",
          expiresAt: job.expiresAt
        }), {
          status: 202,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(job), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...job, state: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    await expect(
      httpScoutApi.getCurrentJiaoyimaoBrowserRefresh()
    ).resolves.toEqual(job);
    await expect(
      httpScoutApi.startJiaoyimaoBrowserRefresh()
    ).resolves.toMatchObject({ claimCode: "ONE-TIME" });
    await httpScoutApi.keepWaitingForJiaoyimaoBrowserRefresh(job.id);
    await httpScoutApi.cancelJiaoyimaoBrowserRefresh(job.id);

    expect(fetchMock.mock.calls).toEqual([
      ["/api/sources/jiaoyimao/browser-refresh/current", undefined],
      ["/api/sources/jiaoyimao/browser-refresh", { method: "POST" }],
      [
        `/api/sources/jiaoyimao/browser-refresh/${job.id}/keep-waiting`,
        { method: "POST" }
      ],
      [
        `/api/sources/jiaoyimao/browser-refresh/${job.id}/cancel`,
        { method: "POST" }
      ]
    ]);
  });

  it("maps non-2xx JSON into a stable Error without echoing credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "refresh_conflict",
        message: "另一个刷新任务正在进行",
        credential: "never-show-this",
        responseBody: "private payload"
      }), {
        status: 409,
        headers: { "content-type": "application/json" }
      })
    );

    const promise = httpScoutApi.startJiaoyimaoBrowserRefresh();
    await expect(promise).rejects.toThrow("另一个刷新任务正在进行");
    await expect(promise).rejects.not.toThrow(/never-show-this|private payload/);
  });
});
