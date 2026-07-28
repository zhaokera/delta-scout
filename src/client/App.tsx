import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { Listing, SourceId } from "../domain/listing";
import {
  httpScoutApi,
  type ListingView,
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

const EMPTY_STATES: Record<
  ListingView,
  { title: string; description: string }
> = {
  pool: {
    title: "推荐候选暂为空",
    description:
      "当前没有可进入均衡 Top 30 的新鲜合格账号。商品会实时上下架，可刷新公开数据，或切到“待人工核验”检查证据不足的记录。"
  },
  eligible: {
    title: "全部合格视图暂无记录",
    description:
      "当前快照中没有满足 QQ 官服、¥6,000 以内与 M7 棱镜攻势极品条件的账号。"
  },
  needs_verification: {
    title: "待人工核验视图暂无记录",
    description:
      "当前没有因价格、武器品质或安全证据不足而需要人工补充核验的记录。"
  },
  rejected: {
    title: "已淘汰视图暂无记录",
    description:
      "当前快照中没有明确违反硬条件而被淘汰的记录。"
  }
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
  const [view, setView] = useState<ListingView>("pool");
  const [sort, setSort] = useState<SortKey>("score");
  const [filters, setFilters] =
    useState<AdvancedFilters>(DEFAULT_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const activeView = useRef<ListingView>(view);

  const load = useCallback(async (requestedView: ListingView) => {
    const requestSequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const [nextSources, nextListings] = await Promise.all([
        api.getSources(),
        api.getListings(requestedView)
      ]);
      if (requestSequence !== loadSequence.current) return;
      setSources(nextSources);
      setListings(nextListings);
      setSelected((current) =>
        current &&
        nextListings.some(({ key }) => key === current.key)
          ? current
          : null
      );
    } catch (cause) {
      if (requestSequence !== loadSequence.current) return;
      setListings([]);
      setSelected(null);
      setError(
        cause instanceof Error ? cause.message : "无法读取本地候选数据"
      );
    } finally {
      if (requestSequence === loadSequence.current) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void load(view);
  }, [load, view]);

  const visibleListings = useMemo(
    () => listings.filter((listing) => matchesFilters(listing, filters)),
    [filters, listings]
  );
  const sourceContributions = useMemo<Record<SourceId, number>>(
    () => ({
      jiaoyimao:
        sources.find(({ source }) => source === "jiaoyimao")
          ?.candidateCount ?? 0,
      panzhi:
        sources.find(({ source }) => source === "panzhi")
          ?.candidateCount ?? 0,
      pxb7:
        sources.find(({ source }) => source === "pxb7")
          ?.candidateCount ?? 0
    }),
    [sources]
  );
  const emptyState = EMPTY_STATES[view];

  function clearFilters() {
    setFilters(DEFAULT_FILTERS);
  }

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
      await load(activeView.current);
    } catch (cause) {
      setListings([]);
      setSelected(null);
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
        view={view}
        sort={sort}
        filters={filters}
        advancedOpen={advancedOpen}
        onViewChange={(nextView) => {
          if (nextView === view) return;
          loadSequence.current += 1;
          activeView.current = nextView;
          setView(nextView);
          setListings([]);
          setSelected(null);
          setError(null);
          setLoading(true);
        }}
        onSortChange={setSort}
        onFiltersChange={setFilters}
        onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
        onReset={clearFilters}
      />

      <div className="workspace">
        <div
          className="workspace__list"
          id="listing-view-panel"
          role="tabpanel"
          aria-labelledby={`listing-view-tab-${view}`}
          aria-busy={loading}
          tabIndex={0}
        >
          {loading ? (
            <div className="loading-state" aria-live="polite">
              <i aria-hidden="true" />
              正在读取当前视图快照…
            </div>
          ) : error ? (
            <section className="error-state" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <h2>数据链路异常</h2>
                <p>{error}</p>
              </div>
              <button type="button" onClick={() => void load(view)}>
                重试
              </button>
            </section>
          ) : listings.length === 0 ? (
            <section className="empty-state" aria-label="空候选">
              <span aria-hidden="true">Ø</span>
              <div>
                <h2>{emptyState.title}</h2>
                <p>{emptyState.description}</p>
              </div>
              <button type="button" onClick={() => void refresh()}>
                立即刷新
              </button>
            </section>
          ) : visibleListings.length > 0 ? (
            <ListingTable
              listings={visibleListings}
              selectedKey={selected?.key ?? null}
              sort={sort}
              view={view}
              totalCount={listings.length}
              sourceContributions={sourceContributions}
              onSortChange={setSort}
              onSelect={(listing) => void selectListing(listing)}
            />
          ) : (
            <section
              className="empty-state empty-state--filtered"
              aria-label="筛选后无结果"
            >
              <span aria-hidden="true">≠</span>
              <div>
                <h2>筛选后无结果</h2>
                <p>
                  当前视图已加载 {listings.length} 条记录，但没有账号满足高级筛选。
                </p>
              </div>
              <button type="button" onClick={clearFilters}>
                清除筛选
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
