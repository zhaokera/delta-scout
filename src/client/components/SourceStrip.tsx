import type { SourceStatusView } from "../api";

const SOURCE_LABELS = {
  jiaoyimao: "交易猫",
  panzhi: "盼之代售",
  pxb7: "螃蟹账号"
} as const;

function sourceState(status: SourceStatusView): {
  label: string;
  tone: string;
} {
  if (status.anomaly.state === "suspect") {
    return { label: "数据骤降待确认", tone: "warn" };
  }
  if (status.completion === "complete") {
    return { label: "完整", tone: "ok" };
  }
  if (status.completion === "partial") {
    return { label: "部分完成", tone: "warn" };
  }
  if (status.completion === "failed") {
    return { label: "获取失败", tone: "danger" };
  }
  if (status.completion === "idle") {
    return { label: "等待首次刷新", tone: "muted" };
  }
  if (status.error === "captcha_required") {
    return { label: "验证码阻塞", tone: "warn" };
  }
  if (status.error === "browser_snapshot_required") {
    return { label: "等待自动浏览器采集", tone: "warn" };
  }
  if (status.error === "unverified_structure") {
    return { label: "列表待人工接入", tone: "warn" };
  }
  return { label: "自动采集受阻", tone: "warn" };
}

const STOP_REASON_LABELS: Record<string, string> = {
  end_of_pages: "已到公开末页",
  no_new_items: "本页无新增商品",
  pagination_stalled: "分页未推进，结果不完整",
  repeated_request: "重复请求保护停止",
  safety_limit: "达到安全上限",
  captcha_required: "入口触发验证码",
  browser_snapshot_required: "等待 Chrome 自动刷新",
  unverified_structure: "列表结构待核验",
  entry_failed: "入口请求失败",
  anomaly_guard: "异常量保护已启用",
  error: "采集过程出错"
};

function stopReasonLabel(
  value: string | null,
  error: string | null
): string {
  if (!value) return "未记录停止原因";
  if (value === "error" && error && STOP_REASON_LABELS[error]) {
    return STOP_REASON_LABELS[error];
  }
  return STOP_REASON_LABELS[value] ?? value;
}

function formatTime(value: string | null): string {
  if (!value) return "尚无成功记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

export function SourceStrip({
  statuses,
  jiaoyimaoRefreshDisabled = false,
  onJiaoyimaoRefresh
}: {
  statuses: SourceStatusView[];
  jiaoyimaoRefreshDisabled?: boolean;
  onJiaoyimaoRefresh?: () => void;
}) {
  return (
    <section className="source-strip" aria-label="平台采集状态">
      {statuses.map((status) => {
        const state = sourceState(status);
        const retained =
          status.completion === "blocked" ||
          status.completion === "failed";
        const idle = status.completion === "idle";
        const anomaly =
          status.anomaly.state === "suspect" ? status.anomaly : null;
        return (
          <article
            className={`source-card source-card--${status.completion}`}
            key={status.source}
          >
            <div className="source-card__top">
              <span className="source-card__name">
                {SOURCE_LABELS[status.source]}
              </span>
              <span className={`source-state source-state--${state.tone}`}>
                <i aria-hidden="true" />
                {state.label}
              </span>
            </div>
            {anomaly ? (
              <div className="source-card__anomaly">
                <span>
                  本轮观测 {anomaly.observedItemCount} 条 /{" "}
                  {anomaly.observedPagesScanned} 页
                </span>
                <span>
                  继续使用可信快照 {anomaly.baselineItemCount} 条 /{" "}
                  {anomaly.baselinePagesScanned} 页
                </span>
                <span>等待下一次完整扫描确认</span>
              </div>
            ) : retained ? (
              <div className="source-card__retained">
                <span>本轮 0 页</span>
                <span>保留旧快照 {status.itemCount} 条</span>
                <span>不参与当前候选</span>
              </div>
            ) : idle ? (
              <div className="source-card__retained">
                <span>本轮尚未扫描</span>
                <span>
                  {status.itemCount > 0
                    ? `保留快照 ${status.itemCount} 条`
                    : "暂无可用快照"}
                </span>
                <span>未参与候选</span>
              </div>
            ) : (
              <div className="source-card__metrics">
                <span>{status.pagesScanned} 页</span>
                <span>{status.itemCount} 商品</span>
                <span>{status.eligibleCount} 合格</span>
                <span>{status.candidateCount} 入选</span>
              </div>
            )}
            <div className="source-card__footer">
              <p
                className={
                  status.completion === "partial"
                    ? "source-card__reason source-card__reason--warn"
                    : "source-card__reason"
                }
              >
                <small>STOP</small>
                <span>{stopReasonLabel(status.stopReason, status.error)}</span>
              </p>
              <p className="source-card__time">
                最近成功 <time>{formatTime(status.lastSuccessAt)}</time>
              </p>
            </div>
            {status.stale ? (
              <span className="source-card__stale">旧快照已过期</span>
            ) : null}
            {status.source === "jiaoyimao" && onJiaoyimaoRefresh ? (
              <button
                className="source-card__browser-refresh"
                type="button"
                disabled={jiaoyimaoRefreshDisabled}
                onClick={onJiaoyimaoRefresh}
              >
                <span>刷新交易猫</span>
                <small>OPEN BROWSER BRIDGE ↗</small>
              </button>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
