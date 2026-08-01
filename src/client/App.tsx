import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { SourceId } from "../domain/listing";
import { matchesListingFilters } from "../domain/listingFilters";
import type {
  ManualExclusionInput,
  ReviewedListing
} from "../domain/manualReview";
import {
  isReviewedListingSummary,
  type ReviewedListingSummary
} from "../domain/listingSummary";
import {
  httpScoutApi,
  type ListingHistoryView,
  type ListingView,
  type PoolMode,
  type RefreshStatusView,
  type ScanHistoryResponse,
  type ScoutApi,
  type SourceStatusView
} from "./api";
import {
  FilterBar,
  type AdvancedFilters,
  type SortKey
} from "./components/FilterBar";
import { DetailDrawer } from "./components/DetailDrawer";
import {
  CandidateCompareDialog,
  CompareTray
} from "./components/CandidateCompare";
import { ListingDetail } from "./components/ListingDetail";
import { ListingTable } from "./components/ListingTable";
import { ManualReviewDialog } from
  "./components/ManualReviewDialog";
import { PoolModeToggle } from "./components/PoolModeToggle";
import { JiaoyimaoBrowserRefreshPanel } from
  "./components/JiaoyimaoBrowserRefreshPanel";
import { RefreshProgress } from "./components/RefreshProgress";
import { SourceStrip } from "./components/SourceStrip";
import { useJiaoyimaoBrowserRefresh } from
  "./useJiaoyimaoBrowserRefresh";

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
      "当前快照中没有同时证明 QQ 官服、价格在 ¥1,900–¥4,000，且拥有骇爪-维什戴尔与露娜-黑天际线的账号。M7 不是入池门槛。"
  },
  needs_verification: {
    title: "待人工核验视图暂无记录",
    description:
      "当前没有因价格、登录平台、区服或两款指定红皮证据不足而需要人工补充核验的记录。"
  },
  rejected: {
    title: "已淘汰视图暂无记录",
    description:
      "当前快照中没有明确违反硬条件或被你人工淘汰的记录。"
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
  const [listings, setListings] =
    useState<ReviewedListingSummary[]>([]);
  const [view, setView] = useState<ListingView>("pool");
  const [poolMode, setPoolMode] = useState<PoolMode>("balanced");
  const [sort, setSort] = useState<SortKey>("score");
  const [filters, setFilters] =
    useState<AdvancedFilters>(DEFAULT_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] =
    useState<ReviewedListing | ReviewedListingSummary | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listingHistory, setListingHistory] =
    useState<ListingHistoryView | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] =
    useState<string | null>(null);
  const [reviewTarget, setReviewTarget] =
    useState<ReviewedListing | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] =
    useState<string | null>(null);
  const [comparison, setComparison] =
    useState<ReviewedListingSummary[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] =
    useState<RefreshStatusView | null>(null);
  const [scanHistory, setScanHistory] =
    useState<ScanHistoryResponse | null>(null);
  const [transportWarning, setTransportWarning] =
    useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const detailSequence = useRef(0);
  const refreshInFlight = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const broadcastRef = useRef<BroadcastChannel | null>(null);
  const pollSequenceRef = useRef(0);
  const knownRunIdRef = useRef<number | null>(null);
  const knownSnapshotAtRef = useRef<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const mounted = useRef(false);
  const activeView = useRef<ListingView>(view);
  const activePoolMode = useRef<PoolMode>(poolMode);
  const narrowLayout = useMediaQuery("(max-width: 1100px)");
  const compactLayout = useMediaQuery("(max-width: 760px)");
  const [operationsOpen, setOperationsOpen] = useState(
    () => !compactLayout
  );
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const closeComparison = useCallback(() => setCompareOpen(false), []);

  const load = useCallback(
    async (
      requestedView: ListingView,
      requestedMode: PoolMode,
      options: {
        preserveOnError?: boolean;
        refreshSelection?: boolean;
        preserveMissingSelection?: boolean;
      } = {}
    ) => {
      if (!mounted.current) return;
      const requestSequence = ++loadSequence.current;
      const detailRequestSequence = ++detailSequence.current;
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
        setComparison((current) =>
          current.map(
            (listing) =>
              nextListings.find(({ key }) => key === listing.key) ??
              listing
          )
        );
        const selectedKey = selectedKeyRef.current;
        const nextSelected =
          selectedKey === null
            ? null
            : (nextListings.find(({ key }) => key === selectedKey) ??
              null);
        const preserveMissingSelection =
          options.preserveMissingSelection === true &&
          selectedKey !== null &&
          nextSelected === null;
        if (!preserveMissingSelection) setSelected(nextSelected);
        if (
          selectedKey !== null &&
          nextSelected === null &&
          !preserveMissingSelection
        ) {
          selectedKeyRef.current = null;
          setListingHistory(null);
          setHistoryError(null);
          setHistoryLoading(false);
          setDrawerOpen(false);
          if (options.refreshSelection) {
            setSelectionNotice("该账号已不在最新在售快照");
          }
        } else if (
          (nextSelected || preserveMissingSelection) &&
          options.refreshSelection
        ) {
          setSelectionNotice(
            preserveMissingSelection
              ? "该账号已不在最新在售快照"
              : null
          );
          const shouldHydrateDetail =
            nextSelected !== null &&
            isReviewedListingSummary(nextSelected);
          setDetailLoading(shouldHydrateDetail);
          setHistoryLoading(true);
          setHistoryError(null);
          const selectionKey = nextSelected?.key ?? selectedKey!;
          const [detailResult, historyResult] =
            await Promise.allSettled([
              shouldHydrateDetail
                ? api.getListing(selectionKey)
                : Promise.resolve(null),
              api.getListingHistory(selectionKey, 20)
            ]);
          if (
            !mounted.current ||
            requestSequence !== loadSequence.current ||
            detailRequestSequence !== detailSequence.current
          ) return;
          if (
            detailResult.status === "fulfilled" &&
            detailResult.value !== null
          ) {
            setSelected(detailResult.value);
          } else if (detailResult.status === "rejected") {
            setSelectionNotice(
              "最新列表已载入，但完整证据读取失败"
            );
          }
          if (historyResult.status === "fulfilled") {
            setListingHistory(historyResult.value);
          } else {
            setHistoryError(
              historyResult.reason instanceof Error
                ? historyResult.reason.message
              : "账号历史读取失败"
            );
          }
          setDetailLoading(false);
          setHistoryLoading(false);
        }
      } catch (cause) {
        if (
          !mounted.current ||
          requestSequence !== loadSequence.current
        ) return;
        if (!options.preserveOnError) {
          setListings([]);
          setSelected(null);
          selectedKeyRef.current = null;
          setListingHistory(null);
          setHistoryError(null);
          setHistoryLoading(false);
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

  const reloadBrowserPublishedData = useCallback(async () => {
    if (!mounted.current) {
      throw new Error("页面已关闭");
    }
    const requestSequence = ++loadSequence.current;
    const detailRequestSequence = ++detailSequence.current;
    const requestedView = activeView.current;
    const requestedMode = activePoolMode.current;
    const selectedKey = selectedKeyRef.current;
    setDetailLoading(false);
    if (selectedKey !== null) {
      setHistoryLoading(true);
      setHistoryError(null);
    }

    const [
      sourcesResult,
      listingsResult,
      scanResult,
      historyResult
    ] =
      await Promise.allSettled([
        api.getSources(requestedMode),
        api.getListings(requestedView, requestedMode),
        api.getScanHistory(10),
        selectedKey === null
          ? Promise.resolve(null)
          : api.getListingHistory(selectedKey, 20)
      ]);

    if (
      !mounted.current ||
      requestSequence !== loadSequence.current ||
      detailRequestSequence !== detailSequence.current
    ) {
      throw new Error("发布刷新已被更新的页面操作取代");
    }

    setLoading(false);
    if (sourcesResult.status === "fulfilled") {
      setSources(sourcesResult.value);
    }
    let summaryToHydrate: ReviewedListingSummary | null = null;
    if (listingsResult.status === "fulfilled") {
      const nextListings = listingsResult.value;
      setListings(nextListings);
      setComparison((current) =>
        current.flatMap((listing) => {
          const refreshed = nextListings.find(
            ({ key }) => key === listing.key
          );
          return refreshed ? [refreshed] : [];
        })
      );
      if (selectedKey !== null) {
        const nextSelected =
          nextListings.find(({ key }) => key === selectedKey) ?? null;
        if (nextSelected) {
          setSelected(nextSelected);
          setSelectionNotice(null);
          if (isReviewedListingSummary(nextSelected)) {
            summaryToHydrate = nextSelected;
          }
        } else {
          setSelectionNotice("该账号已不在最新在售快照");
        }
      }
    }
    if (scanResult.status === "fulfilled") {
      setScanHistory(scanResult.value);
      setTransportWarning(null);
    }
    if (summaryToHydrate !== null) {
      setDetailLoading(true);
      try {
        const detail = await api.getListing(summaryToHydrate.key);
        if (
          !mounted.current ||
          requestSequence !== loadSequence.current ||
          detailRequestSequence !== detailSequence.current
        ) {
          throw new Error("详情读取已被更新的页面操作取代");
        }
        setSelected(detail);
        setSelectionNotice(null);
      } catch (cause) {
        if (
          mounted.current &&
          requestSequence === loadSequence.current &&
          detailRequestSequence === detailSequence.current
        ) {
          setSelectionNotice(
            cause instanceof Error
              ? cause.message
              : "最新列表已载入，但完整证据读取失败"
          );
        }
      }
    }
    if (historyResult.status === "fulfilled" && historyResult.value) {
      setListingHistory(historyResult.value);
      setHistoryError(null);
    } else if (historyResult.status === "rejected") {
      setHistoryError(
        historyResult.reason instanceof Error
          ? historyResult.reason.message
          : "账号历史读取失败"
      );
    }
    if (selectedKey !== null) {
      setDetailLoading(false);
      setHistoryLoading(false);
    }

    const requiredFailures = [
      sourcesResult,
      listingsResult,
      scanResult,
      historyResult
    ].filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    const firstFailure = requiredFailures[0]?.reason;
    if (sourcesResult.status === "rejected" ||
        listingsResult.status === "rejected") {
      setError(
        firstFailure instanceof Error
          ? firstFailure.message
          : "无法读取最新候选数据"
      );
    }
    if (scanResult.status === "rejected") {
      setTransportWarning(
        scanResult.reason instanceof Error
          ? scanResult.reason.message
          : "扫描历史暂不可达"
      );
    }
    if (requiredFailures.length > 0) {
      throw firstFailure instanceof Error
        ? firstFailure
        : new Error("发布数据刷新未完整完成");
    }

    setError(null);
  }, [api]);

  const browserRefresh = useJiaoyimaoBrowserRefresh(
    api,
    refreshing,
    reloadBrowserPublishedData
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
      knownRunIdRef.current = status.runId;
      knownSnapshotAtRef.current = status.lastSnapshotAt;

      if (status.state === "running" || status.state === "idle") {
        schedulePoll(sequence, 0, 1_000);
        return;
      }

      stopPolling();
      if (status.state === "success" || status.state === "partial") {
        await load(activeView.current, activePoolMode.current, {
          preserveOnError: true,
          refreshSelection: true
        });
        broadcastRef.current?.postMessage({
          type: "refresh-state-changed",
          runId: status.runId
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
    let disposed = false;

    async function synchronizeStatus(initial = false) {
      if (!initial && refreshInFlight.current) return;
      try {
        const status = await api.getRefreshStatus();
        if (disposed || !mounted.current) return;
        const changedRun = status.runId !== knownRunIdRef.current;
        const changedSnapshot =
          status.lastSnapshotAt !== knownSnapshotAtRef.current;
        knownRunIdRef.current = status.runId;
        knownSnapshotAtRef.current = status.lastSnapshotAt;

        if (status.state === "running") {
          if (!refreshInFlight.current) {
            resumePolling(status);
          } else {
            setRefreshStatus(status);
          }
          return;
        }
        if (initial) {
          setRefreshStatus(status.state === "idle" ? null : status);
          return;
        }
        if (
          (changedRun || changedSnapshot) &&
          (status.state === "success" || status.state === "partial")
        ) {
          setRefreshStatus(status);
          await load(activeView.current, activePoolMode.current, {
            preserveOnError: true,
            refreshSelection: true
          });
        }
      } catch {
        // The active refresh poll owns visible transport warnings.
      }
    }

    const handleFocus = () => {
      void synchronizeStatus();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void synchronizeStatus();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel("delta-account-scout-refresh");
      channel.onmessage = (event) => {
        const message = event.data as unknown;
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "listing-review-changed"
        ) {
          void load(activeView.current, activePoolMode.current, {
            preserveOnError: true,
            refreshSelection: true
          });
          return;
        }
        void synchronizeStatus();
      };
      broadcastRef.current = channel;
    }
    syncTimerRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        void synchronizeStatus();
      }
    }, 5_000);
    void synchronizeStatus(true);

    return () => {
      disposed = true;
      mounted.current = false;
      loadSequence.current += 1;
      detailSequence.current += 1;
      refreshInFlight.current = false;
      pollSequenceRef.current += 1;
      clearPollTimer();
      if (syncTimerRef.current !== null) {
        clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      broadcastRef.current?.close();
      broadcastRef.current = null;
    };
  }, [api, load]);

  useEffect(() => {
    if (!narrowLayout) setDrawerOpen(false);
  }, [narrowLayout]);

  useEffect(() => {
    if (!compactLayout) setOperationsOpen(true);
  }, [compactLayout]);

  useEffect(() => {
    const browserNeedsAttention =
      browserRefresh.job !== null &&
      !["success", "quarantined", "failed", "cancelled", "expired"]
        .includes(browserRefresh.job.state);
    if (
      refreshing ||
      refreshStatus?.state === "running" ||
      browserNeedsAttention ||
      browserRefresh.error !== null
    ) {
      setOperationsOpen(true);
    }
  }, [
    browserRefresh.error,
    browserRefresh.job,
    refreshStatus?.state,
    refreshing
  ]);

  useEffect(() => {
    if (compareOpen && comparison.length < 2) {
      setCompareOpen(false);
    }
  }, [compareOpen, comparison.length]);

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
  const comparisonKeys = useMemo(
    () => new Set(comparison.map(({ key }) => key)),
    [comparison]
  );
  const emptyState = EMPTY_STATES[view];

  function clearFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  function toggleComparison(listing: ReviewedListingSummary): void {
    setReviewNotice(null);
    setComparison((current) => {
      if (current.some(({ key }) => key === listing.key)) {
        return current.filter(({ key }) => key !== listing.key);
      }
      if (current.length >= 4) {
        setReviewNotice("候选对比最多保留 4 个，请先移除一个");
        return current;
      }
      return [...current, listing];
    });
  }

  function removeComparison(key: string): void {
    setComparison((current) =>
      current.filter((listing) => listing.key !== key)
    );
  }

  function openComparison(): void {
    if (comparison.length < 2) return;
    setDrawerOpen(false);
    setCompareOpen(true);
  }

  function clearSelectionAfterReview(): void {
    detailSequence.current += 1;
    selectedKeyRef.current = null;
    setSelected(null);
    setListingHistory(null);
    setHistoryLoading(false);
    setHistoryError(null);
    setSelectionNotice(null);
    setDetailLoading(false);
    setDrawerOpen(false);
  }

  function openManualExclusion(listing: ReviewedListing): void {
    if (reviewPending) return;
    setReviewTarget(listing);
    setReviewError(null);
    setReviewNotice(null);
    if (narrowLayout) setDrawerOpen(false);
  }

  function closeManualExclusion(): void {
    if (reviewPending) return;
    setReviewTarget(null);
    setReviewError(null);
    if (narrowLayout && selectedKeyRef.current !== null) {
      setDrawerOpen(true);
    }
  }

  async function excludeReviewedListing(
    input: ManualExclusionInput
  ): Promise<void> {
    const target = reviewTarget;
    if (target === null || reviewPending) return;
    setReviewPending(true);
    setReviewError(null);
    try {
      await api.excludeListing(target.key, input);
      if (!mounted.current) return;
      await load(activeView.current, activePoolMode.current, {
        preserveOnError: true
      });
      if (!mounted.current) return;
      setListings((current) =>
        current.filter(({ key }) => key !== target.key)
      );
      removeComparison(target.key);
      clearSelectionAfterReview();
      setReviewTarget(null);
      setReviewNotice(
        `已淘汰 ${
          target.sourceListingId ?? target.title
        }，不再参与候选排名`
      );
      broadcastRef.current?.postMessage({
        type: "listing-review-changed",
        key: target.key
      });
    } catch (cause) {
      if (!mounted.current) return;
      setReviewError(
        cause instanceof Error
          ? cause.message
          : "人工淘汰操作失败，请稍后重试"
      );
    } finally {
      if (mounted.current) setReviewPending(false);
    }
  }

  async function restoreReviewedListing(
    listing: ReviewedListing
  ): Promise<void> {
    if (reviewPending) return;
    setReviewPending(true);
    setReviewError(null);
    setReviewNotice(null);
    try {
      await api.restoreListing(listing.key);
      if (!mounted.current) return;
      await load(activeView.current, activePoolMode.current, {
        preserveOnError: true
      });
      if (!mounted.current) return;
      setListings((current) =>
        current.filter(({ key }) => key !== listing.key)
      );
      clearSelectionAfterReview();
      setReviewNotice(
        `已恢复 ${
          listing.sourceListingId ?? listing.title
        }，将按当前规则重新参与排名`
      );
      broadcastRef.current?.postMessage({
        type: "listing-review-changed",
        key: listing.key
      });
    } catch (cause) {
      if (!mounted.current) return;
      setReviewError(
        cause instanceof Error
          ? cause.message
          : "恢复失败，请稍后重试"
      );
    } finally {
      if (mounted.current) setReviewPending(false);
    }
  }

  async function selectListing(listing: ReviewedListingSummary) {
    const requestSequence = ++detailSequence.current;
    selectedKeyRef.current = listing.key;
    setSelected(listing);
    setReviewError(null);
    setSelectionNotice(null);
    setListingHistory(null);
    setHistoryError(null);
    if (narrowLayout) setDrawerOpen(true);
    setDetailLoading(true);
    setHistoryLoading(true);
    const [detailResult, historyResult] = await Promise.allSettled([
      api.getListing(listing.key),
      api.getListingHistory(listing.key, 20)
    ]);
    if (
      !mounted.current ||
      requestSequence !== detailSequence.current
    ) return;
    if (detailResult.status === "fulfilled") {
      setSelected(detailResult.value);
    } else {
      setSelected((current) =>
        current?.key === listing.key ? listing : current
      );
      setSelectionNotice("完整证据读取失败，当前仍显示轻量摘要");
    }
    if (historyResult.status === "fulfilled") {
      setListingHistory(historyResult.value);
    } else {
      setHistoryError(
        historyResult.reason instanceof Error
          ? historyResult.reason.message
          : "账号历史读取失败"
      );
    }
    setDetailLoading(false);
    setHistoryLoading(false);
  }

  async function refresh() {
    if (
      !mounted.current ||
      refreshInFlight.current ||
      browserRefresh.blocksAllSourceRefresh
    ) {
      return;
    }
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
      knownRunIdRef.current = started.runId;
      broadcastRef.current?.postMessage({
        type: "refresh-state-changed",
        runId: started.runId
      });
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
            disabled={
              refreshing || browserRefresh.blocksAllSourceRefresh
            }
            aria-busy={refreshing}
            onClick={() => void refresh()}
          >
            <span aria-hidden="true">{refreshing ? "◌" : "↻"}</span>
            {refreshing ? "正在刷新…" : "刷新公开数据"}
          </button>
        </div>
      </header>

      <details
        className="operations-panel"
        open={operationsOpen}
        onToggle={(event) =>
          setOperationsOpen(event.currentTarget.open)
        }
      >
        <summary>
          <span>
            <small>01 / DATA CONTROL</small>
            <strong>数据、刷新与固定条件</strong>
          </span>
          <span className="operations-panel__summary-status">
            {sources.length === 0
              ? "正在读取平台状态"
              : `${sources.filter(({ state }) => state === "success" || state === "partial").length} / 3 平台有可信快照`}
            {scanHistory?.runs[0]
              ? ` · 最近扫描 #${scanHistory.runs[0].id}`
              : ""}
          </span>
          <b>{operationsOpen ? "收起" : "展开"}</b>
        </summary>

        <div className="operations-panel__body">
          <RefreshProgress
            status={refreshStatus}
            transportWarning={transportWarning}
          />

          {scanHistory?.runs[0] ? (
            <section
              className="scan-history-summary"
              aria-label="最近扫描历史"
            >
              <span>最近扫描</span>
              <strong>#{scanHistory.runs[0].id}</strong>
              <small>{scanHistory.runs[0].state.toUpperCase()}</small>
            </section>
          ) : null}

          <JiaoyimaoBrowserRefreshPanel
            job={browserRefresh.job}
            claimCode={browserRefresh.claimCode}
            conflict={browserRefresh.conflict}
            busy={browserRefresh.busy || refreshing}
            error={browserRefresh.error}
            onStart={browserRefresh.start}
            onCancel={browserRefresh.cancel}
            onKeepWaiting={browserRefresh.keepWaiting}
          />

          <section className="mission-brief" aria-label="固定筛选条件">
            <div className="mission-brief__label">
              <span>HARD FILTER</span>
              <strong>固定任务条件</strong>
            </div>
            <div className="mission-rule">
              <small>PLATFORM</small>
              <strong>QQ 官服</strong>
            </div>
            <div className="mission-rule">
              <small>EVALUATION</small>
              <strong>全账号统一评分 · M7 仅作品质标签</strong>
            </div>
            <div className="mission-rule">
              <small>PRICE RANGE</small>
              <strong>¥1,900–¥4,000</strong>
            </div>
            <div className="mission-rule">
              <small>REQUIRED RED SKINS</small>
              <strong>骇爪-维什戴尔 · 露娜-黑天际线</strong>
            </div>
            <div className="mission-locked">
              <span aria-hidden="true">⌁</span>
              条件已锁定
            </div>
          </section>

          <SourceStrip
            statuses={sources}
            jiaoyimaoRefreshDisabled={
              browserRefresh.busy ||
              refreshing ||
              browserRefresh.conflict !== null ||
              browserRefresh.blocksAllSourceRefresh
            }
            onJiaoyimaoRefresh={() => {
              void browserRefresh.start();
            }}
          />
        </div>
      </details>

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
          selectedKeyRef.current = null;
          setListingHistory(null);
          setHistoryError(null);
          setHistoryLoading(false);
          setSelectionNotice(null);
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
          selectedKeyRef.current = null;
          setListingHistory(null);
          setHistoryError(null);
          setHistoryLoading(false);
          setSelectionNotice(null);
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
      {selectionNotice ? (
        <section className="snapshot-warning" role="alert">
          <strong>{selectionNotice}</strong>
          <span>可在账号历史中查看最近一次可信记录。</span>
        </section>
      ) : null}
      {reviewNotice ? (
        <section
          className="manual-review-notice"
          role="status"
          aria-live="polite"
        >
          {reviewNotice}
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
                disabled={
                  refreshing || browserRefresh.blocksAllSourceRefresh
                }
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
              comparisonKeys={comparisonKeys}
              comparisonLimitReached={comparison.length >= 4}
              onSortChange={setSort}
              onSelect={(listing) => void selectListing(listing)}
              onToggleComparison={toggleComparison}
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
          <ListingDetail
            listing={selected}
            loading={detailLoading}
            history={listingHistory}
            historyLoading={historyLoading}
            historyError={historyError}
            reviewPending={reviewPending}
            reviewError={reviewError}
            onExclude={openManualExclusion}
            onRestore={(listing) =>
              void restoreReviewedListing(listing)
            }
          />
        ) : null}
      </div>

      {narrowLayout && selected && drawerOpen ? (
        <DetailDrawer
          listing={selected}
          loading={detailLoading}
          history={listingHistory}
          historyLoading={historyLoading}
          historyError={historyError}
          reviewPending={reviewPending}
          reviewError={reviewError}
          onExclude={openManualExclusion}
          onRestore={(listing) =>
            void restoreReviewedListing(listing)
          }
          onClose={closeDrawer}
        />
      ) : null}

      {reviewTarget ? (
        <ManualReviewDialog
          listing={reviewTarget}
          pending={reviewPending}
          error={reviewError}
          onCancel={closeManualExclusion}
          onSubmit={excludeReviewedListing}
        />
      ) : null}

      <CompareTray
        listings={comparison}
        onRemove={removeComparison}
        onClear={() => setComparison([])}
        onOpen={openComparison}
      />

      {compareOpen ? (
        <CandidateCompareDialog
          listings={comparison}
          onRemove={removeComparison}
          onClose={closeComparison}
        />
      ) : null}

      <footer className="app-footer">
        <span>仅聚合公开商品信息 · 不自动下单 · 最终购买前必须人工验号</span>
        <span>LOCAL / READ-ONLY COLLECTOR</span>
      </footer>
    </main>
  );
}
