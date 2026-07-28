import { useCallback, useEffect, useMemo, useState } from "react";
import type { Eligibility, Listing } from "../domain/listing";
import {
  httpScoutApi,
  type ScoutApi,
  type SourceStatusView
} from "./api";
import {
  FilterBar,
  type AdvancedFilters,
  type SortKey
} from "./components/FilterBar";
import { ListingDetail } from "./components/ListingDetail";
import { ListingTable } from "./components/ListingTable";
import { SourceStrip } from "./components/SourceStrip";

const DEFAULT_FILTERS: AdvancedFilters = {
  source: "all",
  secondRealName: false,
  recoveryCoverage: false,
  redSkin: "",
  julang: "all"
};

function matchesFilters(
  listing: Listing,
  filters: AdvancedFilters
): boolean {
  return (
    (filters.source === "all" || listing.source === filters.source) &&
    (!filters.secondRealName ||
      listing.secondRealNameAvailable === true) &&
    (!filters.recoveryCoverage || listing.recoveryCoverage === true) &&
    (!filters.redSkin ||
      listing.redSkins.some((name) => name.includes(filters.redSkin))) &&
    (filters.julang === "all" ||
      listing.julangStatus === filters.julang)
  );
}

export function App({ api = httpScoutApi }: { api?: ScoutApi }) {
  const [sources, setSources] = useState<SourceStatusView[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [status, setStatus] = useState<Eligibility>("eligible");
  const [sort, setSort] = useState<SortKey>("score");
  const [filters, setFilters] =
    useState<AdvancedFilters>(DEFAULT_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSources, nextListings] = await Promise.all([
        api.getSources(),
        api.getListings(status)
      ]);
      setSources(nextSources);
      setListings(nextListings);
      setSelected((current) =>
        current &&
        nextListings.some(({ key }) => key === current.key)
          ? current
          : null
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "无法读取本地候选数据"
      );
    } finally {
      setLoading(false);
    }
  }, [api, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleListings = useMemo(
    () => listings.filter((listing) => matchesFilters(listing, filters)),
    [filters, listings]
  );

  async function selectListing(listing: Listing) {
    setSelected(listing);
    setDetailLoading(true);
    try {
      setSelected(await api.getListing(listing.key));
    } catch {
      setSelected(listing);
    } finally {
      setDetailLoading(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await api.refresh();
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "刷新失败，请稍后重试"
      );
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="brand-block">
          <p>
            <span aria-hidden="true">△</span> DELTA ACCOUNT SCOUT
          </p>
          <h1>三角洲账号候选台</h1>
        </div>
        <div className="masthead__actions">
          <span className="live-indicator">
            <i aria-hidden="true" />
            本地运行
          </span>
          <button
            className="refresh-button"
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <span aria-hidden="true">{refreshing ? "◌" : "↻"}</span>
            {refreshing ? "正在刷新…" : "刷新公开数据"}
          </button>
        </div>
      </header>

      <section className="mission-brief" aria-label="固定筛选条件">
        <div className="mission-brief__label">
          <span>01 / HARD FILTER</span>
          <strong>固定任务条件</strong>
        </div>
        <div className="mission-rule">
          <small>PLATFORM</small>
          <strong>QQ 官服</strong>
        </div>
        <div className="mission-rule">
          <small>WEAPON SKIN</small>
          <strong>M7 棱镜攻势 · 极品</strong>
        </div>
        <div className="mission-rule">
          <small>BUDGET CAP</small>
          <strong>¥6,000 以内</strong>
        </div>
        <div className="mission-locked">
          <span aria-hidden="true">⌁</span>
          条件已锁定
        </div>
      </section>

      <SourceStrip statuses={sources} />

      <FilterBar
        status={status}
        sort={sort}
        filters={filters}
        advancedOpen={advancedOpen}
        onStatusChange={(nextStatus) => {
          setStatus(nextStatus);
          setSelected(null);
        }}
        onSortChange={setSort}
        onFiltersChange={setFilters}
        onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
        onReset={() => setFilters(DEFAULT_FILTERS)}
      />

      {error ? (
        <div className="error-banner" role="alert">
          <strong>数据链路异常</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      <div className="workspace">
        <div className="workspace__list">
          {loading ? (
            <div className="loading-state" aria-live="polite">
              <i aria-hidden="true" />
              正在读取候选快照…
            </div>
          ) : visibleListings.length > 0 ? (
            <ListingTable
              listings={visibleListings}
              selectedKey={selected?.key ?? null}
              sort={sort}
              onSortChange={setSort}
              onSelect={(listing) => void selectListing(listing)}
            />
          ) : (
            <section className="empty-state" aria-label="空候选">
              <span aria-hidden="true">Ø</span>
              <div>
                <h2>当前没有命中硬条件的账号</h2>
                <p>
                  这不代表平台上永久没有。商品会实时上下架，建议刷新后再看，
                  或切到“待人工核验”检查证据不足的记录。
                </p>
              </div>
              <button type="button" onClick={() => void refresh()}>
                立即刷新
              </button>
            </section>
          )}
        </div>
        <ListingDetail listing={selected} loading={detailLoading} />
      </div>

      <footer className="app-footer">
        <span>仅聚合公开商品信息 · 不自动下单 · 最终购买前必须人工验号</span>
        <span>LOCAL / READ-ONLY COLLECTOR</span>
      </footer>
    </main>
  );
}
