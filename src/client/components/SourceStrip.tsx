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
  if (status.stale) return { label: "快照已过期", tone: "warn" };
  if (status.state === "success") return { label: "公开页正常", tone: "ok" };
  if (status.state === "partial") return { label: "部分数据", tone: "warn" };
  if (status.state === "failed") return { label: "获取失败", tone: "danger" };
  if (status.state === "idle") return { label: "等待首次刷新", tone: "muted" };
  if (status.error === "captcha_required") {
    return { label: "验证码阻塞", tone: "warn" };
  }
  if (status.error === "unverified_structure") {
    return { label: "列表待人工接入", tone: "warn" };
  }
  return { label: "自动采集受阻", tone: "warn" };
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
  statuses
}: {
  statuses: SourceStatusView[];
}) {
  return (
    <section className="source-strip" aria-label="平台采集状态">
      {statuses.map((status) => {
        const state = sourceState(status);
        return (
          <article className="source-card" key={status.source}>
            <div className="source-card__top">
              <span className="source-card__name">
                {SOURCE_LABELS[status.source]}
              </span>
              <span className={`source-state source-state--${state.tone}`}>
                <i aria-hidden="true" />
                {state.label}
              </span>
            </div>
            <div className="source-card__metric">
              <strong>{String(status.itemCount).padStart(2, "0")}</strong>
              <span>条快照</span>
            </div>
            <p>
              最近成功 <time>{formatTime(status.lastSuccessAt)}</time>
            </p>
          </article>
        );
      })}
    </section>
  );
}
