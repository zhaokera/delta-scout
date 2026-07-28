import type { KeyboardEvent } from "react";
import type { SourceId } from "../../domain/listing";
import type { ListingView } from "../api";

export type SortKey = "score" | "price" | "assets" | "confidence";

export interface AdvancedFilters {
  source: SourceId | "all";
  secondRealName: boolean;
  recoveryCoverage: boolean;
  redSkin: string;
  julang: "all" | "owned" | "absent";
}

interface FilterBarProps {
  view: ListingView;
  sort: SortKey;
  filters: AdvancedFilters;
  advancedOpen: boolean;
  onViewChange(view: ListingView): void;
  onSortChange(sort: SortKey): void;
  onFiltersChange(filters: AdvancedFilters): void;
  onToggleAdvanced(): void;
  onReset(): void;
}

const VIEW_TABS: Array<{ value: ListingView; label: string }> = [
  { value: "pool", label: "推荐候选" },
  { value: "eligible", label: "全部合格" },
  { value: "needs_verification", label: "待人工核验" },
  { value: "rejected", label: "已淘汰" }
];

export function FilterBar(props: FilterBarProps) {
  function navigateTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % VIEW_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + VIEW_TABS.length) % VIEW_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = VIEW_TABS.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    const nextView = VIEW_TABS[nextIndex].value;
    const tabs =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]'
      );
    tabs?.[nextIndex]?.focus();
    props.onViewChange(nextView);
  }

  return (
    <section className="filter-panel" aria-label="候选筛选">
      <div className="filter-panel__primary">
        <div className="status-tabs" role="tablist" aria-label="候选视图">
          {VIEW_TABS.map((tab, index) => (
            <button
              key={tab.value}
              id={`listing-view-tab-${tab.value}`}
              type="button"
              role="tab"
              aria-controls="listing-view-panel"
              aria-selected={props.view === tab.value}
              tabIndex={props.view === tab.value ? 0 : -1}
              onClick={() => props.onViewChange(tab.value)}
              onKeyDown={(event) => navigateTabs(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="filter-actions">
          <label>
            <span>排序</span>
            <select
              aria-label="候选排序"
              value={props.sort}
              onChange={(event) =>
                props.onSortChange(event.target.value as SortKey)
              }
            >
              <option value="score">推荐分</option>
              <option value="price">价格低优先</option>
              <option value="assets">总资产高优先</option>
              <option value="confidence">置信度高优先</option>
            </select>
          </label>
          <button
            className="text-button"
            type="button"
            aria-expanded={props.advancedOpen}
            onClick={props.onToggleAdvanced}
          >
            高级筛选 <span aria-hidden="true">{props.advancedOpen ? "−" : "+"}</span>
          </button>
        </div>
      </div>
      {props.advancedOpen ? (
        <div className="advanced-filters">
          <label>
            <span>来源</span>
            <select
              value={props.filters.source}
              onChange={(event) =>
                props.onFiltersChange({
                  ...props.filters,
                  source: event.target.value as SourceId | "all"
                })
              }
            >
              <option value="all">全部平台</option>
              <option value="jiaoyimao">交易猫</option>
              <option value="panzhi">盼之代售</option>
              <option value="pxb7">螃蟹账号</option>
            </select>
          </label>
          <label className="check-filter">
            <input
              type="checkbox"
              checked={props.filters.secondRealName}
              onChange={(event) =>
                props.onFiltersChange({
                  ...props.filters,
                  secondRealName: event.target.checked
                })
              }
            />
            仅可二次实名
          </label>
          <label className="check-filter">
            <input
              type="checkbox"
              checked={props.filters.recoveryCoverage}
              onChange={(event) =>
                props.onFiltersChange({
                  ...props.filters,
                  recoveryCoverage: event.target.checked
                })
              }
            />
            仅支持包赔
          </label>
          <label>
            <span>红皮角色</span>
            <input
              type="search"
              placeholder="例如：威龙"
              value={props.filters.redSkin}
              onChange={(event) =>
                props.onFiltersChange({
                  ...props.filters,
                  redSkin: event.target.value
                })
              }
            />
          </label>
          <label>
            <span>巨浪</span>
            <select
              value={props.filters.julang}
              onChange={(event) =>
                props.onFiltersChange({
                  ...props.filters,
                  julang: event.target.value as AdvancedFilters["julang"]
                })
              }
            >
              <option value="all">不限</option>
              <option value="owned">有巨浪</option>
              <option value="absent">无巨浪</option>
            </select>
          </label>
          <button className="reset-button" type="button" onClick={props.onReset}>
            恢复默认
          </button>
        </div>
      ) : null}
    </section>
  );
}
