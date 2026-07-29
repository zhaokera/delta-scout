import type { PoolMode } from "../api";

export function PoolModeToggle({
  mode,
  onChange
}: {
  mode: PoolMode;
  onChange(mode: PoolMode): void;
}) {
  return (
    <section className="pool-mode" aria-label="候选池模式">
      <div>
        <span>候选池策略</span>
        <small>
          {mode === "balanced"
            ? "优先保证三个平台都有代表账号"
            : "完全按推荐分选出跨平台总榜"}
        </small>
      </div>
      <div className="pool-mode__buttons">
        <button
          type="button"
          aria-pressed={mode === "balanced"}
          onClick={() => onChange("balanced")}
        >
          平台均衡
        </button>
        <button
          type="button"
          aria-pressed={mode === "global"}
          onClick={() => onChange("global")}
        >
          全局 Top 30
        </button>
      </div>
    </section>
  );
}
