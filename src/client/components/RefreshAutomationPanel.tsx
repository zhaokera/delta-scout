import type { SourceId } from "../../domain/listing";
import type {
  PanzhiAutomationState,
  PanzhiAutomationStatusView,
  RefreshEventView,
  RefreshMode,
  RefreshScheduleView
} from "../api";

const SOURCE_LABELS: Record<SourceId, string> = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
};

const STATE_LABELS: Record<RefreshScheduleView["lastState"], string> = {
  idle: "等待首次调度",
  running: "正在刷新",
  success: "最近刷新成功",
  partial: "最近部分完成",
  blocked: "自动刷新受阻",
  failed: "最近刷新失败",
  attention_required: "等待人工快照"
};

const PANZHI_STAGE_LABELS: Record<PanzhiAutomationState, string> = {
  queued: "等待 Chrome 扩展领取",
  opening_page: "正在复用或打开盼之标签页",
  applying_filters: "正在设置并核对原生筛选",
  collecting: "正在读取商品卡片",
  awaiting_user_verification: "等待你完成 Chrome 验证",
  submitting: "正在提交可信快照",
  success: "自动刷新成功",
  failed: "自动刷新失败",
  cancelled: "自动刷新已取消"
};

interface DisplayRefreshEvent extends RefreshEventView {
  displayKey: string;
}

export function buildRefreshEventFeed(
  events: RefreshEventView[]
): DisplayRefreshEvent[] {
  const removalGroups = new Map<string, RefreshEventView[]>();
  for (const event of events) {
    if (event.type !== "removed") continue;
    const key = `${event.runId}:${event.source ?? "unknown"}`;
    const group = removalGroups.get(key) ?? [];
    group.push(event);
    removalGroups.set(key, group);
  }

  const emittedRemovalGroups = new Set<string>();
  return events.flatMap((event) => {
    if (event.type !== "removed") {
      return [{ ...event, displayKey: `event:${event.id}` }];
    }
    const key = `${event.runId}:${event.source ?? "unknown"}`;
    if (emittedRemovalGroups.has(key)) return [];
    emittedRemovalGroups.add(key);
    const group = removalGroups.get(key) ?? [event];
    const sourceLabel = event.source
      ? SOURCE_LABELS[event.source]
      : "平台";
    return [{
      ...event,
      displayKey: `removed:${key}`,
      title: `${sourceLabel}本轮 ${group.length} 个候选离开最新快照`,
      message: "可能已下架或不再满足平台筛选条件，不代表账号质量被自动判差。"
    }];
  });
}

function formatTime(value: string | null): string {
  if (!value) return "尚未安排";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

export function RefreshAutomationPanel({
  schedules,
  events,
  busy,
  panzhiAutomation,
  onRefresh,
  onAcknowledge
}: {
  schedules: RefreshScheduleView[];
  events: RefreshEventView[];
  busy: boolean;
  panzhiAutomation?: PanzhiAutomationStatusView | null;
  onRefresh: (source: SourceId, mode: RefreshMode) => void;
  onAcknowledge: () => void;
}) {
  if (schedules.length === 0 && events.length === 0) return null;
  return (
    <section className="refresh-automation" aria-label="自动刷新与变化提醒">
      <header className="refresh-automation__header">
        <div>
          <p>SMART REFRESH</p>
          <h3>定时刷新与变化提醒</h3>
        </div>
        <span>快刷增量核验 · 每日深刷</span>
      </header>

      <RefreshScheduleGrid
        schedules={schedules}
        busy={busy}
        panzhiAutomation={panzhiAutomation}
        onRefresh={onRefresh}
      />
      <RefreshEventFeed
        events={events}
        onAcknowledge={onAcknowledge}
        limit={8}
      />
    </section>
  );
}

export function RefreshScheduleGrid({
  schedules,
  busy,
  panzhiAutomation,
  onRefresh
}: {
  schedules: RefreshScheduleView[];
  busy: boolean;
  panzhiAutomation?: PanzhiAutomationStatusView | null;
  onRefresh: (source: SourceId, mode: RefreshMode) => void;
}) {
  if (schedules.length === 0) {
    return (
      <p className="refresh-events__empty">
        正在读取三平台刷新计划…
      </p>
    );
  }

  return (
    <div className="refresh-automation__schedules">
      {schedules.map((schedule) => (
        <article key={schedule.source}>
          <div className="refresh-schedule__title">
            <strong>{SOURCE_LABELS[schedule.source]}</strong>
            <span
              className={`refresh-schedule__state refresh-schedule__state--${schedule.lastState}`}
            >
              {STATE_LABELS[schedule.lastState]}
            </span>
          </div>
          <dl>
            <div>
              <dt>快速</dt>
              <dd>{schedule.quickIntervalMinutes} 分钟</dd>
            </div>
            <div>
              <dt>完整</dt>
              <dd>每天一次</dd>
            </div>
            <div>
              <dt>下次快刷</dt>
              <dd>{formatTime(schedule.nextQuickAt)}</dd>
            </div>
          </dl>
          {schedule.backoffUntil ? (
            <p className="refresh-schedule__warning">
              已自动退避至 {formatTime(schedule.backoffUntil)}
            </p>
          ) : null}
          {schedule.attentionRequired ? (
            <p className="refresh-schedule__warning">
              自动任务已排队；Chrome 扩展连接后会继续执行
            </p>
          ) : null}
          {schedule.source === "panzhi" ? (
            <PanzhiAutomationStatus status={panzhiAutomation} />
          ) : null}
          <div className={
            schedule.source === "panzhi"
              ? "refresh-schedule__actions refresh-schedule__actions--panzhi"
              : "refresh-schedule__actions"
          }>
            {schedule.source === "panzhi" ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRefresh("panzhi", "quick")}
                >
                  立即快速刷新
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRefresh("panzhi", "deep")}
                >
                  立即完整刷新
                </button>
                <a
                  className="refresh-schedule__diagnostic"
                  href="https://www.pzds.com/goodsList/391/6"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开盼之诊断页
                </a>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRefresh(schedule.source, "quick")}
                >
                  快速刷新
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRefresh(schedule.source, "deep")}
                >
                  完整刷新
                </button>
              </>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function PanzhiAutomationStatus({
  status
}: {
  status?: PanzhiAutomationStatusView | null;
}) {
  const connected = status?.connected === true;
  const job = status?.currentJob ?? null;
  return (
    <div
      className={`panzhi-automation panzhi-automation--${
        connected ? "connected" : "disconnected"
      }`}
      aria-label="盼之 Chrome 自动刷新状态"
    >
      <div className="panzhi-automation__health">
        <span aria-hidden="true" />
        <div>
          <strong>
            {connected
              ? "Chrome 自动刷新已连接"
              : "Chrome 自动刷新未连接"}
          </strong>
          <small>
            {connected && status?.lastHeartbeatAt
              ? `心跳 ${formatTime(status.lastHeartbeatAt)}`
              : "等待本机扩展心跳"}
          </small>
        </div>
      </div>

      {!connected ? (
        <p className="panzhi-automation__setup">
          在 Chrome 扩展管理页加载已解压目录
          <code>extensions/panzhi-auto-refresh/dist/</code>
        </p>
      ) : null}

      {job ? (
        <div
          className={`panzhi-automation__stage panzhi-automation__stage--${job.state}`}
          data-state={job.state}
        >
          <div>
            <small>{job.mode === "quick" ? "QUICK RUN" : "DEEP RUN"}</small>
            <strong>{PANZHI_STAGE_LABELS[job.state]}</strong>
          </div>
          <time dateTime={job.updatedAt}>
            更新 {formatTime(job.updatedAt)}
          </time>
        </div>
      ) : (
        <p className="panzhi-automation__standby">
          暂无执行中的盼之任务
        </p>
      )}

      {job?.state === "awaiting_user_verification" ? (
        <p className="panzhi-automation__verification" role="alert">
          <strong>需要你完成一次可见验证</strong>
          请在已打开的 Chrome 盼之页面完成可见验证码或滑块；完成后会自动继续。
        </p>
      ) : null}

      {job?.state === "failed" && job.error ? (
        <p className="panzhi-automation__error">{job.error}</p>
      ) : null}
    </div>
  );
}

export function RefreshEventFeed({
  events,
  onAcknowledge,
  limit
}: {
  events: RefreshEventView[];
  onAcknowledge: () => void;
  limit?: number;
}) {
  if (events.length === 0) {
    return (
      <p className="refresh-events__empty">
        暂无降价、新进 Top10 或安全信息变化
      </p>
    );
  }

  const eventFeed = buildRefreshEventFeed(events);
  const visibleEvents = limit === undefined
    ? eventFeed
    : eventFeed.slice(0, limit);

  return (
    <div className="refresh-events">
      <div className="refresh-events__heading">
        <strong>最新变化</strong>
        <button type="button" onClick={onAcknowledge}>
          全部已读
        </button>
      </div>
      <ul>
        {visibleEvents.map((event) => (
          <li
            key={event.displayKey}
            className={`refresh-event refresh-event--${event.severity}`}
          >
            <span>{event.title}</span>
            <p>{event.message}</p>
            <time>{formatTime(event.createdAt)}</time>
          </li>
        ))}
      </ul>
    </div>
  );
}
