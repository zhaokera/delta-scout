import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type {
  JiaoyimaoBrowserRefreshConflict,
  JiaoyimaoBrowserRefreshJob,
  JiaoyimaoBrowserRefreshState
} from "../api";

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

const TERMINAL_STATES: ReadonlySet<JiaoyimaoBrowserRefreshState> =
  new Set([
    "success",
    "quarantined",
    "failed",
    "cancelled",
    "expired"
  ]);

const JIAOYIMAO_VERIFICATION_URL = (() => {
  const url = new URL(
    "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o1687157900084320/"
  );
  url.searchParams.set("rId", "108");
  url.searchParams.set(
    "priceCondition",
    JSON.stringify({
      price: {
        conditionList: ["1900,4000"],
        statConditionList: ["1900-4000"]
      }
    })
  );
  url.searchParams.set(
    "searchCondition",
    JSON.stringify({
      is_second_real_name: {
        selectType: 1,
        conditionList: ["10071"],
        statConditionList: ["可二次实名"],
        conditionType: 2
      },
      selling_point_7322805066952352771: {
        selectType: 1,
        multiSearchCondition: false,
        conditionList: ["骇爪-维什戴尔", "露娜-黑·天际线"],
        statConditionList: ["骇爪-维什戴尔", "露娜-黑·天际线"],
        conditionType: 3
      }
    })
  );
  url.searchParams.set("enforcePlat", "2");
  url.searchParams.set("newPage", "true");
  return url.toString();
})();

export interface JiaoyimaoBrowserRefreshPanelProps {
  job: JiaoyimaoBrowserRefreshJob | null;
  claimCode: string | null;
  conflict: JiaoyimaoBrowserRefreshConflict | null;
  busy: boolean;
  error: string | null;
  now?: Date | (() => Date);
  onStart(): void | Promise<void>;
  onCancel(jobId: string): void | Promise<void>;
  onKeepWaiting(jobId: string): void | Promise<void>;
}

function formatRemaining(
  cooldownUntil: string | null,
  nowMs: number
): string | null {
  if (!cooldownUntil) return null;
  const remainingMs = Date.parse(cooldownUntil) - nowMs;
  if (!Number.isFinite(remainingMs)) return null;
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}分${String(seconds).padStart(2, "0")}秒`
    : `${seconds}秒`;
}

function readNow(now: Date | (() => Date) | undefined): number {
  const value = typeof now === "function"
    ? now()
    : now ?? new Date();
  return value.getTime();
}

function isKnownState(
  state: string
): state is JiaoyimaoBrowserRefreshState {
  return Object.prototype.hasOwnProperty.call(STATE_LABELS, state);
}

function stateGuidance(
  state: JiaoyimaoBrowserRefreshState
): string | null {
  switch (state) {
    case "awaiting_user_verification":
      return "请在当前 Codex 浏览器标签页完成验证，完成后保持页面打开。";
    case "quarantined":
      return "本轮数据未通过可信校验；旧的可信快照和现有候选仍会继续展示。";
    case "failed":
      return "本轮采集没有发布，现有候选和旧快照不受影响。";
    case "paused":
      return "Codex 已暂停采集，可继续保留任务或取消本轮刷新。";
    case "expired":
      return "接管窗口已过期，可重新发起一次交易猫刷新。";
    default:
      return null;
  }
}

interface CancelTarget {
  jobId: string;
  state: JiaoyimaoBrowserRefreshState;
}

export function JiaoyimaoBrowserRefreshPanel({
  job,
  claimCode,
  conflict,
  busy,
  error,
  now,
  onStart,
  onCancel,
  onKeepWaiting
}: JiaoyimaoBrowserRefreshPanelProps) {
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(
    null
  );
  const [clockMs, setClockMs] = useState(() => readNow(now));
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const safeCancelRef = useRef<HTMLButtonElement>(null);
  const dangerCancelRef = useRef<HTMLButtonElement>(null);
  const dialogWasOpen = useRef(false);
  const knownState = job !== null && isKnownState(job.state)
    ? job.state
    : null;
  const unknownState = job !== null && knownState === null;
  const active =
    job !== null &&
    knownState !== null &&
    !TERMINAL_STATES.has(knownState);
  const guidance = unknownState
    ? "服务端状态无法识别，请刷新页面后重试。"
    : knownState
      ? stateGuidance(knownState)
      : null;
  const remaining = knownState === "cooling_down"
    ? formatRemaining(job?.cooldownUntil ?? null, clockMs)
    : null;
  const canKeepWaiting =
    knownState === "awaiting_user_verification" ||
    knownState === "paused";
  const cancelStillValid =
    cancelTarget !== null &&
    job !== null &&
    knownState !== null &&
    active &&
    job.id === cancelTarget.jobId &&
    knownState === cancelTarget.state;

  useEffect(() => {
    setClockMs(readNow(now));
    if (
      knownState !== "cooling_down" ||
      !job?.cooldownUntil ||
      !Number.isFinite(Date.parse(job.cooldownUntil))
    ) {
      return;
    }
    const deadline = Date.parse(job.cooldownUntil);
    let timer = 0;
    const tick = () => {
      const current = readNow(now);
      setClockMs(current);
      if (current >= deadline) window.clearInterval(timer);
    };
    timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [job?.cooldownUntil, knownState, now]);

  useEffect(() => {
    if (cancelTarget !== null && !cancelStillValid) {
      setCancelTarget(null);
    }
  }, [cancelStillValid, cancelTarget]);

  useEffect(() => {
    if (cancelStillValid) {
      dialogWasOpen.current = true;
      safeCancelRef.current?.focus();
      return;
    }
    if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      cancelTriggerRef.current?.focus();
    }
  }, [cancelStillValid]);

  const closeCancelDialog = () => setCancelTarget(null);

  const confirmCancellation = () => {
    if (
      cancelTarget === null ||
      job === null ||
      knownState === null ||
      !active ||
      job.id !== cancelTarget.jobId ||
      knownState !== cancelTarget.state
    ) {
      closeCancelDialog();
      return;
    }
    const capturedJobId = cancelTarget.jobId;
    closeCancelDialog();
    void onCancel(capturedJobId);
  };

  const handleDialogKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCancelDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      safeCancelRef.current,
      dangerCancelRef.current
    ].filter(
      (control): control is HTMLButtonElement =>
        control !== null && !control.disabled
    );
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !event.currentTarget.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      document.activeElement === last
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section
      className="browser-refresh-panel"
      role="region"
      aria-label="交易猫浏览器刷新"
      aria-busy={busy}
    >
      <div
        className="browser-refresh-panel__content"
        aria-hidden={cancelStillValid ? true : undefined}
        inert={cancelStillValid ? true : undefined}
      >
        <header className="browser-refresh-panel__header">
          <div>
            <p className="browser-refresh-panel__eyebrow">
              03 / TRUSTED BROWSER BRIDGE
            </p>
            <h2>交易猫可信刷新</h2>
          </div>
          <span className="browser-refresh-panel__source">JIAOYIMAO</span>
        </header>

        {conflict ? (
          <p className="browser-refresh-panel__alert" role="alert">
            <strong>当前无法发起：</strong>
            {conflict.message}
          </p>
        ) : null}
        {error ? (
          <p className="browser-refresh-panel__alert" role="alert">
            <strong>操作未完成：</strong>
            {error}
          </p>
        ) : null}

        <div
          className="browser-refresh-panel__status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="browser-refresh-panel__signal" aria-hidden="true" />
          <div>
            <small>{job ? "CURRENT STATE" : "READY"}</small>
            <strong data-testid="browser-refresh-state">
              {unknownState
                ? "未知状态"
                : knownState
                  ? STATE_LABELS[knownState]
                  : "等待发起"}
            </strong>
          </div>
          {job ? (
            <div className="browser-refresh-panel__metrics">
              <span>已发现 {job.uniqueItemCount} 个账号</span>
              <span>
                详情 {job.detailCompletedCount} / {job.detailRequiredCount}
              </span>
            </div>
          ) : (
            <p>通过已登录的 Codex 浏览器采集公开商品，不上传登录凭据。</p>
          )}
        </div>

        {knownState === "awaiting_codex" ? (
          <div className="browser-refresh-panel__claim">
            <div>
              <span>一次性接管码</span>
              {claimCode ? (
                <code aria-label={`交易猫接管码 ${claimCode}`}>
                  {claimCode}
                </code>
              ) : (
                <strong>接管码已隐藏</strong>
              )}
            </div>
            <p>
              {claimCode
                ? "该接管码仅显示一次；请只交给当前 Codex 任务。"
                : "接管码仅在发起时显示；刷新页面后不会恢复。"}
            </p>
          </div>
        ) : null}

        {remaining ? (
          <p className="browser-refresh-panel__notice">
            服务端正在控制重试节奏 · <strong>剩余 {remaining}</strong>
          </p>
        ) : null}
        {guidance ? (
          <p className="browser-refresh-panel__notice">{guidance}</p>
        ) : null}

        <div className="browser-refresh-panel__actions">
          {active ? (
            <a
              className="browser-refresh-panel__primary"
              href={JIAOYIMAO_VERIFICATION_URL}
            >
              打开交易猫验证页 ↗
            </a>
          ) : null}
          {!unknownState && !active ? (
            <button
              className="browser-refresh-panel__primary"
              type="button"
              disabled={busy || conflict !== null}
              onClick={() => void onStart()}
            >
              {job ? "重新刷新交易猫" : "刷新交易猫"}
            </button>
          ) : null}
          {canKeepWaiting && job ? (
            <button
              className="browser-refresh-panel__secondary"
              type="button"
              disabled={busy}
              onClick={() => void onKeepWaiting(job.id)}
            >
              我还在处理，继续等待
            </button>
          ) : null}
          {active && job ? (
            <button
              ref={cancelTriggerRef}
              className="browser-refresh-panel__quiet"
              type="button"
              disabled={busy}
              onClick={() =>
                setCancelTarget({
                  jobId: job.id,
                  state: knownState
                })
              }
            >
              取消本次刷新
            </button>
          ) : null}
        </div>
      </div>

      {cancelStillValid ? (
        <div className="browser-refresh-dialog__backdrop">
          <div
            className="browser-refresh-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-refresh-cancel-title"
            onKeyDown={handleDialogKeyDown}
          >
            <p className="browser-refresh-panel__eyebrow">SAFE CANCEL</p>
            <h3 id="browser-refresh-cancel-title">确认取消交易猫刷新</h3>
            <p>
              取消只会停止本次采集，现有候选和旧快照都会保留。
            </p>
            <div className="browser-refresh-dialog__actions">
              <button
                ref={safeCancelRef}
                type="button"
                disabled={busy}
                onClick={closeCancelDialog}
              >
                继续刷新
              </button>
              <button
                ref={dangerCancelRef}
                className="browser-refresh-dialog__danger"
                type="button"
                disabled={busy}
                onClick={confirmCancellation}
              >
                确认取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
