import type { RefreshStatusView } from "../api";

const SOURCE_LABELS = {
  jiaoyimao: "交易猫",
  panzhi: "盼之代售",
  pxb7: "螃蟹账号"
} as const;

const PHASE_LABELS: Record<
  NonNullable<RefreshStatusView["phase"]>,
  string
> = {
  discover: "发现入口",
  list: "列表",
  detail: "详情",
  score: "统一评分",
  commit: "提交快照"
};

function snapshotLabel(value: string | null): string {
  if (!value) return "尚无有效快照";
  return `上次有效快照 ${new Date(value).toLocaleString("zh-CN")}`;
}

export function RefreshProgress({
  status,
  transportWarning
}: {
  status: RefreshStatusView | null;
  transportWarning: string | null;
}) {
  if (transportWarning) {
    return (
      <section className="refresh-progress refresh-progress--warning" role="alert">
        <strong>无法读取刷新进度，任务可能仍在后台运行</strong>
        <span>{transportWarning}</span>
        <small>{snapshotLabel(status?.lastSnapshotAt ?? null)}</small>
      </section>
    );
  }

  if (!status || status.state === "idle" || status.state === "success") {
    return null;
  }

  if (status.state === "partial") {
    return (
      <section className="refresh-progress refresh-progress--warning" role="alert">
        <strong>部分来源未完整刷新</strong>
        <span>{status.error ?? status.message ?? "请查看各平台状态"}</span>
        <small>{snapshotLabel(status.lastSnapshotAt)}</small>
      </section>
    );
  }

  if (status.state === "failed") {
    return (
      <section className="refresh-progress refresh-progress--failed" role="alert">
        <strong>刷新失败，正在展示上次有效快照</strong>
        <span>{status.error ?? "刷新任务异常结束"}</span>
        <small>{snapshotLabel(status.lastSnapshotAt)}</small>
      </section>
    );
  }

  return (
    <section className="refresh-progress" role="status" aria-live="polite">
      <div>
        <strong>
          {status.source ? SOURCE_LABELS[status.source] : "准备刷新"}
          {status.phase ? ` · ${PHASE_LABELS[status.phase]}` : ""}
        </strong>
        <span>{status.message ?? "正在采集公开商品"}</span>
      </div>
      <div className="refresh-progress__metrics">
        <span>第 {status.page} 页</span>
        <span>{status.summaries} 商品</span>
        <span>{status.details} 详情</span>
      </div>
      <small>{snapshotLabel(status.lastSnapshotAt)}</small>
    </section>
  );
}
