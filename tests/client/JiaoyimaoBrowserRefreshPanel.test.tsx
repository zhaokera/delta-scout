import {
  act,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import {
  JiaoyimaoBrowserRefreshPanel,
  type JiaoyimaoBrowserRefreshPanelProps
} from "../../src/client/components/JiaoyimaoBrowserRefreshPanel";
import {
  httpScoutApi,
  type JiaoyimaoBrowserRefreshJob,
  type JiaoyimaoBrowserRefreshState
} from "../../src/client/api";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    expect(
      screen.getByLabelText("交易猫接管码 JYM-ONE-TIME-7")
    ).toBeInTheDocument();
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

  it("ticks cooldown from cooldownUntil and cleans up its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T01:00:00.000Z"));
    const { unmount } = render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({
          now: undefined,
          job: makeJob({
            state: "cooling_down",
            cooldownUntil: "2026-07-31T01:02:05.000Z",
            nextActionAt: "2026-07-31T08:00:00.000Z"
          })
        })}
      />
    );

    expect(screen.getByText("剩余 2分05秒")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(66_000));
    expect(screen.getByText("剩余 59秒")).toBeInTheDocument();

    unmount();
    expect(vi.getTimerCount()).toBe(0);
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

  it("closes cancellation if the job disappears and never targets a later job", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const props = makeProps({ job: makeJob(), onCancel });
    const { rerender } = render(
      <JiaoyimaoBrowserRefreshPanel {...props} />
    );

    await user.click(screen.getByRole("button", { name: "取消本次刷新" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<JiaoyimaoBrowserRefreshPanel {...props} job={null} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(
      <JiaoyimaoBrowserRefreshPanel
        {...props}
        job={makeJob({ id: "job-18" })}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("invalidates cancellation when id, state, or terminal status changes", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const props = makeProps({ job: makeJob(), onCancel });
    const { rerender } = render(
      <JiaoyimaoBrowserRefreshPanel {...props} />
    );

    await user.click(screen.getByRole("button", { name: "取消本次刷新" }));
    rerender(
      <JiaoyimaoBrowserRefreshPanel
        {...props}
        job={makeJob({ state: "validating" })}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消本次刷新" }));
    rerender(
      <JiaoyimaoBrowserRefreshPanel
        {...props}
        job={makeJob({ id: "job-18", state: "validating" })}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消本次刷新" }));
    rerender(
      <JiaoyimaoBrowserRefreshPanel
        {...props}
        job={makeJob({ id: "job-18", state: "success" })}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("traps modal focus, closes on Escape, and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({ job: makeJob() })}
      />
    );
    const trigger = screen.getByRole("button", {
      name: "取消本次刷新"
    });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    const safeButton = within(dialog).getByRole("button", {
      name: "继续刷新"
    });
    const dangerButton = within(dialog).getByRole("button", {
      name: "确认取消"
    });
    expect(safeButton).toHaveFocus();
    expect(
      document.querySelector(".browser-refresh-panel__content")
    ).toHaveAttribute("inert");

    await user.tab({ shift: true });
    expect(dangerButton).toHaveFocus();
    await user.tab();
    expect(safeButton).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("fails closed for an unknown runtime state", () => {
    const unknownJob = {
      ...makeJob(),
      state: "new_server_state"
    } as unknown as JiaoyimaoBrowserRefreshJob;
    render(
      <JiaoyimaoBrowserRefreshPanel
        {...makeProps({ job: unknownJob })}
      />
    );

    expect(screen.getByTestId("browser-refresh-state"))
      .toHaveTextContent("未知状态");
    expect(screen.getByText(/状态无法识别，请刷新页面后重试/))
      .toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消本次刷新" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新刷新交易猫" })
    ).not.toBeInTheDocument();
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
      [
        "/api/sources/jiaoyimao/browser-refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      ],
      [
        `/api/sources/jiaoyimao/browser-refresh/${job.id}/keep-waiting`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      ],
      [
        `/api/sources/jiaoyimao/browser-refresh/${job.id}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
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

  it("rejects a sensitive server message instead of echoing a claim code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "unexpected_failure",
        message: "claimCode=ONE-TIME-SECRET"
      }), {
        status: 409,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("请求失败（409）");
    expect((error as Error).message).not.toContain("ONE-TIME-SECRET");
    expect((error as Error).cause).toBeUndefined();
  });

  it("does not echo an opaque sibling credential referenced by message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "unexpected_failure",
        message: "刷新失败，跟踪值 9f4b7c2d71e6",
        credential: "9f4b7c2d71e6"
      }), {
        status: 502,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("请求失败（502）");
    expect((error as Error).message).not.toContain(
      "9f4b7c2d71e6"
    );
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([
    {
      label: "nested array and case variant",
      secret: "NESTED-BRIDGE-93",
      payload: {
        error: "unexpected_failure",
        message: "任务失败 NESTED-BRIDGE-93",
        diagnostics: [
          { harmless: "public" },
          { "BrIdGe_ToKeN": "NESTED-BRIDGE-93" }
        ]
      }
    },
    {
      label: "separator variant with string array",
      secret: "SESSION-AUTH-44",
      payload: {
        error: "unexpected_failure",
        message: "任务失败 SESSION-AUTH-44",
        meta: {
          "Session.Auth": ["SESSION-AUTH-44"]
        }
      }
    }
  ])(
    "does not echo sensitive values from $label",
    async ({ payload, secret }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
      );

      const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("请求失败（500）");
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
  );

  it("fails closed when a sensitive value is beyond the depth bound", async () => {
    const payload: Record<string, unknown> = {
      error: "unexpected_failure",
      message: "任务失败 d33p0paque71"
    };
    let cursor: Record<string, unknown> = {};
    payload.diagnostics = cursor;
    for (let depth = 0; depth < 8; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.credential = "d33p0paque71";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("请求失败（500）");
  });

  it("fails closed when an object exceeds the child scan bound", async () => {
    const diagnostics: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) {
      diagnostics[`public_${index}`] = `value_${index}`;
    }
    diagnostics.credential = "huge0paque72";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "unexpected_failure",
        message: "任务失败 huge0paque72",
        diagnostics
      }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("请求失败（500）");
  });

  it("fails closed when an array exceeds the child scan bound", async () => {
    const diagnostics: Array<Record<string, string>> = Array.from(
      { length: 70 },
      (_, index) => ({ public: `value_${index}` })
    );
    diagnostics.push({ credential: "array0paque73" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "unexpected_failure",
        message: "任务失败 array0paque73",
        diagnostics
      }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("请求失败（500）");
  });

  it("bounds cyclic error payloads without exposing a cause", async () => {
    const payload: Record<string, unknown> = {
      error: "unexpected_failure",
      message: "普通读取失败"
    };
    payload.loop = payload;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => payload
    } as Response);

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("请求失败（500）");
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([200, 512])(
    "fails closed when message contains a prefix of a %i-character sensitive value",
    async (length) => {
      const bridgeToken = `9${"x".repeat(length - 1)}`;
      const exposedPrefix = bridgeToken.slice(0, 80);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          error: "unexpected_failure",
          message: `任务失败 ${exposedPrefix}`,
          bridgeToken
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
      );

      const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe("请求失败（500）");
      expect((error as Error).message).not.toContain(exposedPrefix);
    }
  );

  it("fails closed for a non-string value under a sensitive key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "unexpected_failure",
        message: "任务失败 4815162342",
        credential: 4_815_162_342
      }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("请求失败（500）");
  });

  it("ignores an empty sensitive value without hiding a safe message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        error: "unexpected_failure",
        message: "普通读取失败",
        credential: ""
      }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );

    const error = await httpScoutApi.startJiaoyimaoBrowserRefresh()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("普通读取失败");
  });
});
