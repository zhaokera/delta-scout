import { useState } from "react";
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

export interface JiaoyimaoBrowserRefreshPanelProps {
  job: JiaoyimaoBrowserRefreshJob | null;
  claimCode: string | null;
  conflict: JiaoyimaoBrowserRefreshConflict | null;
  busy: boolean;
  error: string | null;
  now?: Date;
  onStart(): void | Promise<void>;
  onCancel(jobId: string): void | Promise<void>;
  onKeepWaiting(jobId: string): void | Promise<void>;
}

function formatRemaining(
  cooldownUntil: string | null,
  now: Date
): string | null {
  if (!cooldownUntil) return null;
  const remainingMs = Date.parse(cooldownUntil) - now.getTime();
  if (!Number.isFinite(remainingMs)) return null;
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}分${String(seconds).padStart(2, "0")}秒`
    : `${seconds}秒`;
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

export function JiaoyimaoBrowserRefreshPanel({
  job,
  claimCode,
  conflict,
  busy,
  error,
  now = new Date(),
  onStart,
  onCancel,
  onKeepWaiting
}: JiaoyimaoBrowserRefreshPanelProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const active = job !== null && !TERMINAL_STATES.has(job.state);
  const guidance = job ? stateGuidance(job.state) : null;
  const remaining = job?.state === "cooling_down"
    ? formatRemaining(job.cooldownUntil, now)
    : null;
  const canKeepWaiting =
    job?.state === "awaiting_user_verification" ||
    job?.state === "paused";

  return (
    <section
      className="browser-refresh-panel"
      role="region"
      aria-label="交易猫浏览器刷新"
      aria-busy={busy}
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
        role="status"
        aria-live="polite"
      >
        <span className="browser-refresh-panel__signal" aria-hidden="true" />
        <div>
          <small>{job ? "CURRENT STATE" : "READY"}</small>
          <strong data-testid="browser-refresh-state">
            {job ? STATE_LABELS[job.state] : "等待发起"}
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

      {job?.state === "awaiting_codex" ? (
        <div className="browser-refresh-panel__claim">
          <div>
            <span>一次性接管码</span>
            {claimCode ? (
              <code aria-label="交易猫接管码">{claimCode}</code>
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
        {!active ? (
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
            className="browser-refresh-panel__quiet"
            type="button"
            disabled={busy}
            onClick={() => setConfirmingCancel(true)}
          >
            取消本次刷新
          </button>
        ) : null}
      </div>

      {confirmingCancel && job ? (
        <div className="browser-refresh-dialog__backdrop">
          <div
            className="browser-refresh-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-refresh-cancel-title"
          >
            <p className="browser-refresh-panel__eyebrow">SAFE CANCEL</p>
            <h3 id="browser-refresh-cancel-title">确认取消交易猫刷新</h3>
            <p>
              取消只会停止本次采集，现有候选和旧快照都会保留。
            </p>
            <div className="browser-refresh-dialog__actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingCancel(false)}
              >
                继续刷新
              </button>
              <button
                className="browser-refresh-dialog__danger"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingCancel(false);
                  void onCancel(job.id);
                }}
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
