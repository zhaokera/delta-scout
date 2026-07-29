import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { Listing, SourceId } from "../domain/listing";
import { matchesListingFilters } from "../domain/listingFilters";
import {
  httpScoutApi,
  type ListingView,
  type PoolMode,
  type RefreshStatusView,
  type ScoutApi,
  type SourceStatusView
} from "./api";
import {
  FilterBar,
  type AdvancedFilters,
  type SortKey
} from "./components/FilterBar";
import { DetailDrawer } from "./components/DetailDrawer";
import { ListingDetail } from "./components/ListingDetail";
import { ListingTable } from "./components/ListingTable";
import { PoolModeToggle } from "./components/PoolModeToggle";
import { RefreshProgress } from "./components/RefreshProgress";
import { SourceStrip } from "./components/SourceStrip";

const DEFAULT_FILTERS: AdvancedFilters = {
  source: "all",
  secondRealName: false,
  recoveryCoverage: false,
  redSkin: "",
  julang: "all",
  m7Quality: "all",
  minRedSkinCount: 0,
  evidenceCompleteness: "all",
  stability: "all"
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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener?.("change", update);
    return () => mediaQuery.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

export function App({ api = httpScoutApi }: { api?: ScoutApi }) {
  const [sources, setSources] = useState<SourceStatusView[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [view, setView] = useState<ListingView>("pool");
  const [poolMode, setPoolMode] = useState<PoolMode>("balanced");
  const [sort, setSort] = useState<SortKey>("score");
  const [filters, setFilters] =
    useState<AdvancedFilters>(DEFAULT_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] =
    useState<RefreshStatusView | null>(null);
  const [transportWarning, setTransportWarning] =
    useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const detailSequence = useRef(0);
  const refreshInFlight = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const pollSequenceRef = useRef(0);
  const mounted = useRef(false);
  const activeView = useRef<ListingView>(view);
  const activePoolMode = useRef<PoolMode>(poolMode);
  const narrowLayout = useMediaQuery("(max-width: 1100px)");
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const load = useCallback(
    async (
      requestedView: ListingView,
      requestedMode: PoolMode,
      options: { preserveOnError?: boolean } = {}
    ) => {
      if (!mounted.current) return;
      const requestSequence = ++loadSequence.current;
      detailSequence.current += 1;
      setDetailLoading(false);
      if (!options.preserveOnError) setLoading(true);
      setError(null);
      try {
        const [nextSources, nextListings] = await Promise.all([
          api.getSources(requestedMode),
          api.getListings(requestedView, requestedMode)
        ]);
        if (
          !mounted.current ||
          requestSequence !== loadSequence.current
        ) return;
        setSources(nextSources);
        setListings(nextListings);
        setSelected((current) => {
          if (!current) return null;
          return (
            nextListings.find(({ key }) => key === current.key) ?? null
          );
        });
      } catch (cause) {
        if (
          !mounted.current ||
          requestSequence !== loadSequence.current
        ) return;
        if (!options.preserveOnError) {
          setListings([]);
          setSelected(null);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "无法读取本地候选数据"
        );
      } finally {
        if (
          mounted.current &&
          requestSequence === loadSequence.current
        ) {
          setLoading(false);
        }
      }
    },
    [api]
  );

  function clearPollTimer() {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function stopPolling() {
    clearPollTimer();
    pollSequenceRef.current += 1;
    refreshInFlight.current = false;
    setRefreshing(false);
  }

  function schedulePoll(
    sequence: number,
    transportFailures: number,
    delay: number
  ) {
    clearPollTimer();
    pollTimerRef.current = setTimeout(() => {
      void pollRefreshStatus(sequence, transportFailures);
    }, delay);
  }

  async function pollRefreshStatus(
    sequence: number,
    transportFailures: number
  ) {
    if (!mounted.current || sequence !== pollSequenceRef.current) return;
    try {
      const status = await api.getRefreshStatus();
      if (!mounted.current || sequence !== pollSequenceRef.current) return;
      setRefreshStatus(status);
      setTransportWarning(null);

      if (status.state === "running" || status.state === "idle") {
        schedulePoll(sequence, 0, 1_000);
        return;
      }

      stopPolling();
      if (status.state === "success" || status.state === "partial") {
        await load(activeView.current, activePoolMode.current, {
          preserveOnError: true
        });
      }
    } catch (cause) {
      if (!mounted.current || sequence !== pollSequenceRef.current) return;
      const nextFailures = transportFailures + 1;
      if (nextFailures > 3) {
        setTransportWarning(
          cause instanceof Error ? cause.message : "进度接口不可达"
        );
      }
      schedulePoll(
        sequence,
        nextFailures,
        nextFailures > 3 ? 5_000 : 1_000
      );
    }
  }

  function resumePolling(status: RefreshStatusView) {
    clearPollTimer();
    const sequence = ++pollSequenceRef.current;
    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshStatus(status);
    setTransportWarning(null);
    schedulePoll(sequence, 0, 1_000);
  }

  useEffect(() => {
    mounted.current = true;
    void load("pool", "balanced");
    void api.getRefreshStatus()
      .then((status) => {
        if (!mounted.current || status.state !== "running") return;
        resumePolling(status);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
      detailSequence.current += 1;
      refreshInFlight.current = false;
      pollSequenceRef.current += 1;
      clearPollTimer();
    };
  }, [api, load]);

  useEffect(() => {
    if (!narrowLayout) setDrawerOpen(false);
  }, [narrowLayout]);

  const visibleListings = useMemo(
    () =>
      listings.filter((listing) =>
        matchesListingFilters(listing, filters)
      ),
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
    const requestSequence = ++detailSequence.current;
    setSelected(listing);
    if (narrowLayout) setDrawerOpen(true);
    setDetailLoading(true);
    try {
      const detail = await api.getListing(listing.key);
      if (
        !mounted.current ||
        requestSequence !== detailSequence.current
      ) return;
      setSelected(detail);
    } catch {
      if (
        !mounted.current ||
        requestSequence !== detailSequence.current
      ) return;
      setSelected((current) =>
        current?.key === listing.key ? listing : current
      );
    } finally {
      if (
        mounted.current &&
        requestSequence === detailSequence.current
      ) {
        setDetailLoading(false);
      }
    }
  }

  async function refresh() {
    if (!mounted.current || refreshInFlight.current) return;
    refreshInFlight.current = true;
    detailSequence.current += 1;
    setRefreshing(true);
    setDetailLoading(false);
    setError(null);
    setTransportWarning(null);
    setRefreshStatus(null);
    try {
      const started = await api.startRefresh();
      if (!mounted.current) return;
      const sequence = ++pollSequenceRef.current;
      setRefreshStatus({
        runId: started.runId,
        state: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        source: null,
        phase: null,
        page: 0,
        summaries: 0,
        details: 0,
        message: "刷新任务已启动",
        error: null,
        lastSnapshotAt: refreshStatus?.lastSnapshotAt ?? null
      });
      void pollRefreshStatus(sequence, 0);
    } catch (cause) {
      if (!mounted.current) return;
      refreshInFlight.current = false;
      setRefreshing(false);
      setRefreshStatus({
        runId: null,
        state: "failed",
        startedAt: null,
        finishedAt: new Date().toISOString(),
        source: null,
        phase: null,
        page: 0,
        summaries: 0,
        details: 0,
        message: null,
        error:
          cause instanceof Error
            ? cause.message
            : "刷新失败，请稍后重试",
        lastSnapshotAt: refreshStatus?.lastSnapshotAt ?? null
      });
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
            aria-busy={refreshing}
            onClick={() => void refresh()}
          >
            <span aria-hidden="true">{refreshing ? "◌" : "↻"}</span>
            {refreshing ? "正在刷新…" : "刷新公开数据"}
          </button>
        </div>
      </header>

      <RefreshProgress
        status={refreshStatus}
        transportWarning={transportWarning}
      />

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

      <PoolModeToggle
        mode={poolMode}
        onChange={(nextMode) => {
          if (nextMode === poolMode) return;
          loadSequence.current += 1;
          detailSequence.current += 1;
          activePoolMode.current = nextMode;
          setPoolMode(nextMode);
          setListings([]);
          setSelected(null);
          setDrawerOpen(false);
          setDetailLoading(false);
          setError(null);
          setLoading(true);
          void load(activeView.current, nextMode);
        }}
      />

      <FilterBar
        view={view}
        sort={sort}
        filters={filters}
        advancedOpen={advancedOpen}
        onViewChange={(nextView) => {
          if (nextView === view) return;
          loadSequence.current += 1;
          detailSequence.current += 1;
          activeView.current = nextView;
          setView(nextView);
          setListings([]);
          setSelected(null);
          setDrawerOpen(false);
          setDetailLoading(false);
          setError(null);
          setLoading(true);
          void load(nextView, activePoolMode.current);
        }}
        onSortChange={setSort}
        onFiltersChange={setFilters}
        onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
        onReset={clearFilters}
      />

      {error && listings.length > 0 ? (
        <section className="snapshot-warning" role="alert">
          <strong>无法读取最新快照，继续展示现有候选</strong>
          <span>{error}</span>
        </section>
      ) : null}

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
          ) : error && listings.length === 0 ? (
            <section className="error-state" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <h2>数据链路异常</h2>
                <p>{error}</p>
              </div>
              <button
                type="button"
                onClick={() =>
                  void load(activeView.current, activePoolMode.current)
                }
              >
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
              <button
                type="button"
                disabled={refreshing}
                aria-busy={refreshing}
                onClick={() => void refresh()}
              >
                {refreshing ? "正在刷新…" : "立即刷新"}
              </button>
            </section>
          ) : visibleListings.length > 0 ? (
            <ListingTable
              listings={visibleListings}
              selectedKey={selected?.key ?? null}
              sort={sort}
              view={view}
              poolMode={poolMode}
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
        {!narrowLayout ? (
          <ListingDetail listing={selected} loading={detailLoading} />
        ) : null}
      </div>

      {narrowLayout && selected && drawerOpen ? (
        <DetailDrawer
          listing={selected}
          loading={detailLoading}
          onClose={closeDrawer}
        />
      ) : null}

      <footer className="app-footer">
        <span>仅聚合公开商品信息 · 不自动下单 · 最终购买前必须人工验号</span>
        <span>LOCAL / READ-ONLY COLLECTOR</span>
      </footer>
    </main>
  );
}
