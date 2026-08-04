import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Button, Empty, Tag } from "antd";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom";
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
  type PanzhiAutomationStatusView,
  type PoolMode,
  type RefreshEventView,
  type RefreshMode,
  type RefreshScheduleView,
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
import {
  CandidateCompareBoard,
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
import {
  RefreshEventFeed,
  RefreshScheduleGrid
} from "./components/RefreshAutomationPanel";
import { RankingDiagnostics } from
  "./components/RankingDiagnostics";
import { SourceStrip } from "./components/SourceStrip";
import {
  APP_ROUTES,
  AppFrame,
  PageIntro,
  type AppRoute
} from "./components/AppFrame";
import { ScoringRulesPage } from
  "./components/ScoringRulesPage";
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
      "当前快照中没有同时证明 QQ 官服、可二次实名、价格在 ¥1,900–¥4,000，且拥有骇爪-维什戴尔与露娜-黑天际线的账号。M7 不是入池门槛。"
  },
  needs_verification: {
    title: "待人工核验视图暂无记录",
    description:
      "当前没有因价格、登录平台、区服、二次实名或两款指定红皮证据不足而需要人工补充核验的记录。"
  },
  rejected: {
    title: "已淘汰视图暂无记录",
    description:
      "当前快照中没有明确违反硬条件或被你人工淘汰的记录。"
  }
};

export function App({ api = httpScoutApi }: { api?: ScoutApi }) {
  return (
    <BrowserRouter>
      <ScoutApp api={api} />
    </BrowserRouter>
  );
}

function ScoutApp({ api }: { api: ScoutApi }) {
  const location = useLocation();
  const navigate = useNavigate();
  const initialView = useRef<ListingView>(
    location.pathname === APP_ROUTES.exclusions
      ? "rejected"
      : "pool"
  ).current;
  const [sources, setSources] = useState<SourceStatusView[]>([]);
  const [refreshSchedules, setRefreshSchedules] =
    useState<RefreshScheduleView[]>([]);
  const [panzhiAutomation, setPanzhiAutomation] =
    useState<PanzhiAutomationStatusView>({
      connected: false,
      lastHeartbeatAt: null,
      currentJob: null
    });
  const [refreshEvents, setRefreshEvents] =
    useState<RefreshEventView[]>([]);
  const [listings, setListings] =
    useState<ReviewedListingSummary[]>([]);
  const [view, setView] = useState<ListingView>(initialView);
  const [poolMode, setPoolMode] = useState<PoolMode>("balanced");
  const [sort, setSort] = useState<SortKey>("score");
  const [filters, setFilters] =
    useState<AdvancedFilters>(DEFAULT_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] =
    useState<ReviewedListing | ReviewedListingSummary | null>(null);
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
  const panzhiStatusSequenceRef = useRef(0);
  const knownRunIdRef = useRef<number | null>(null);
  const knownSnapshotAtRef = useRef<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const mounted = useRef(false);
  const activeView = useRef<ListingView>(initialView);
  const activePoolMode = useRef<PoolMode>(poolMode);

  const loadAutomation = useCallback(async () => {
    const [scheduleResult, eventsResult] = await Promise.allSettled([
      api.getRefreshSchedule?.() ?? Promise.resolve([]),
      api.getRefreshEvents?.(30, true) ?? Promise.resolve([])
    ]);
    if (!mounted.current) return;
    if (scheduleResult.status === "fulfilled") {
      setRefreshSchedules(scheduleResult.value);
    }
    if (eventsResult.status === "fulfilled") {
      setRefreshEvents(eventsResult.value);
    }
  }, [api]);

  const loadPanzhiAutomationStatus = useCallback(async () => {
    const sequence = ++panzhiStatusSequenceRef.current;
    if (!api.getPanzhiAutomationStatus) {
      if (
        mounted.current &&
        sequence === panzhiStatusSequenceRef.current
      ) {
        setPanzhiAutomation({
          connected: false,
          lastHeartbeatAt: null,
          currentJob: null
        });
      }
      return;
    }
    try {
      const status = await api.getPanzhiAutomationStatus();
      if (
        mounted.current &&
        sequence === panzhiStatusSequenceRef.current
      ) {
        setPanzhiAutomation(status);
      }
    } catch {
      if (
        mounted.current &&
        sequence === panzhiStatusSequenceRef.current
      ) {
        setPanzhiAutomation({
          connected: false,
          lastHeartbeatAt: null,
          currentJob: null
        });
      }
    }
  }, [api]);

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

    await loadAutomation();
    setError(null);
  }, [api, loadAutomation]);

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
        await loadAutomation();
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
    void load(initialView, "balanced");
    void loadAutomation();
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
          await loadAutomation();
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
  }, [api, initialView, load, loadAutomation]);

  useEffect(() => {
    if (location.pathname !== APP_ROUTES.refresh) return;
    void loadPanzhiAutomationStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadPanzhiAutomationStatus();
      }
    }, 5_000);
    return () => {
      panzhiStatusSequenceRef.current += 1;
      clearInterval(timer);
    };
  }, [loadPanzhiAutomationStatus, location.pathname]);

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
    navigate(APP_ROUTES.compare);
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
  }

  function openManualExclusion(listing: ReviewedListing): void {
    if (reviewPending) return;
    setReviewTarget(listing);
    setReviewError(null);
    setReviewNotice(null);
  }

  function closeManualExclusion(): void {
    if (reviewPending) return;
    setReviewTarget(null);
    setReviewError(null);
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

  async function refreshSource(source: SourceId, mode: RefreshMode) {
    if (
      !api.startSourceRefresh ||
      refreshInFlight.current ||
      browserRefresh.blocksAllSourceRefresh
    ) {
      return;
    }
    setError(null);
    setTransportWarning(null);
    try {
      const started = await api.startSourceRefresh(source, mode);
      if (!mounted.current) return;
      if ("kind" in started) {
        await Promise.all([
          loadAutomation(),
          source === "panzhi"
            ? loadPanzhiAutomationStatus()
            : Promise.resolve()
        ]);
        return;
      }
      const status = await api.getRefreshStatus();
      if (!mounted.current) return;
      knownRunIdRef.current = started.runId;
      resumePolling(status);
      broadcastRef.current?.postMessage({
        type: "refresh-state-changed",
        runId: started.runId
      });
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "单平台刷新启动失败"
      );
      await loadAutomation();
    }
  }

  async function acknowledgeRefreshEvents() {
    if (!api.acknowledgeRefreshEvents) return;
    try {
      await api.acknowledgeRefreshEvents(
        refreshEvents.map(({ id }) => id)
      );
      if (mounted.current) setRefreshEvents([]);
    } catch (cause) {
      if (mounted.current) {
        setTransportWarning(
          cause instanceof Error ? cause.message : "提醒状态保存失败"
        );
      }
    }
  }

  function changePoolMode(nextMode: PoolMode): void {
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
    setDetailLoading(false);
    setError(null);
    setLoading(true);
    void load(activeView.current, nextMode);
  }

  function changeListingView(nextView: ListingView): void {
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
    setDetailLoading(false);
    setError(null);
    setLoading(true);
    void load(nextView, activePoolMode.current);
  }

  function navigateSection(route: AppRoute): void {
    if (route === APP_ROUTES.exclusions) {
      setFilters(DEFAULT_FILTERS);
      changeListingView("rejected");
    } else if (route === APP_ROUTES.candidates &&
        location.pathname === APP_ROUTES.exclusions) {
      changeListingView("pool");
    }
    navigate(route);
  }

  const completeSourceCount = sources.filter(
    ({ state }) => state === "success"
  ).length;
  const partialSourceCount = sources.filter(
    ({ state }) => state === "partial"
  ).length;
  const trustedSourceCount = completeSourceCount + partialSourceCount;
  const sourceSnapshotSummary =
    partialSourceCount > 0
      ? `${completeSourceCount} 完整 · ${partialSourceCount} 部分完成`
      : `${trustedSourceCount} / 3 平台有可信快照`;

  const currentRoute = Object.values(APP_ROUTES).includes(
    location.pathname as AppRoute
  )
    ? location.pathname as AppRoute
    : APP_ROUTES.candidates;
  const unreadEventCount = refreshEvents.filter(
    ({ acknowledged }) => !acknowledged
  ).length;

  const statusNotices = (
    <>
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
    </>
  );

  const listingWorkspace = (
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
      <ListingDetail
        listing={selected}
        loading={detailLoading}
        history={listingHistory}
        historyLoading={historyLoading}
        historyError={historyError}
        reviewPending={reviewPending}
        reviewError={reviewError}
        onExclude={openManualExclusion}
        onRestore={(listing) => void restoreReviewedListing(listing)}
      />
    </div>
  );

  return (
    <AppFrame
      route={currentRoute}
      unreadEvents={unreadEventCount}
      sourceSnapshotSummary={sourceSnapshotSummary}
      refreshing={refreshing}
      refreshDisabled={browserRefresh.blocksAllSourceRefresh}
      onRefresh={() => void refresh()}
      onNavigate={navigateSection}
    >
      {statusNotices}
      <Routes>
        <Route
          path="/"
          element={<Navigate to={APP_ROUTES.candidates} replace />}
        />

        <Route
          path={APP_ROUTES.refresh}
          element={(
            <section className="page-stack refresh-center-page">
              <PageIntro
                index="03 / DATA CONTROL"
                title="刷新中心"
                description="三平台采集状态、可信浏览器接管与定时刷新统一在这里处理。"
                meta={
                  <Tag color={partialSourceCount > 0 ? "warning" : "success"}>
                    {sources.length === 0
                      ? "正在读取平台状态"
                      : sourceSnapshotSummary}
                  </Tag>
                }
              />
              <div className="refresh-center__body">
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
              <small>
                {scanHistory.runs[0].state === "success" &&
                partialSourceCount > 0
                  ? "有部分数据"
                  : scanHistory.runs[0].state.toUpperCase()}
              </small>
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
              <small>SECOND REAL NAME</small>
              <strong>必须可二次实名</strong>
            </div>
            <div className="mission-rule">
              <small>EVALUATION</small>
              <strong>全账号统一评分 · M7 非入池门槛</strong>
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

          <section className="refresh-automation" aria-label="三平台刷新计划">
            <header className="refresh-automation__header">
              <div>
                <p>SMART REFRESH</p>
                <h3>三平台刷新计划</h3>
              </div>
              <span>快刷增量核验 · 每日深刷</span>
            </header>
            <RefreshScheduleGrid
              schedules={refreshSchedules}
              panzhiAutomation={panzhiAutomation}
              busy={
                refreshing ||
                browserRefresh.busy ||
                browserRefresh.blocksAllSourceRefresh
              }
              onRefresh={(source, mode) => {
                void refreshSource(source, mode);
              }}
            />
          </section>
        </div>
      </section>
    )}
  />

        <Route
          path={APP_ROUTES.candidates}
          element={(
            <section className="page-stack candidates-page">
              <PageIntro
                index="01 / CANDIDATE RANKING"
                title="候选总榜"
                description="只对通过硬条件的账号统一评分；按均衡 Top30 或跨平台总榜查看。"
                meta={<Tag color="success">{listings.length} 个当前账号</Tag>}
              />
              <section
                className="candidate-live-ops"
                aria-label="平台快照与刷新状态"
              >
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
                <SourceStrip
                  statuses={sources}
                  jiaoyimaoRefreshDisabled={
                    browserRefresh.busy ||
                    refreshing ||
                    browserRefresh.conflict !== null ||
                    browserRefresh.blocksAllSourceRefresh
                  }
                  onJiaoyimaoRefresh={() => void browserRefresh.start()}
                />
              </section>
              <PoolModeToggle
                mode={poolMode}
                onChange={changePoolMode}
              />
              <FilterBar
                view={view}
                sort={sort}
                filters={filters}
                advancedOpen={advancedOpen}
                onViewChange={changeListingView}
                onSortChange={setSort}
                onFiltersChange={setFilters}
                onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
                onReset={clearFilters}
              />
              {view === "pool" && poolMode === "global" && !loading ? (
                <RankingDiagnostics listings={listings} />
              ) : null}
              {listingWorkspace}
            </section>
          )}
        />

        <Route
          path={APP_ROUTES.compare}
          element={(
            <section className="page-stack compare-page">
              <PageIntro
                index="02 / DECISION MATRIX"
                title="账号对比"
                description="把最多 4 个账号并排核对报价、价值项、资产回收率与安全证据。"
                meta={<Tag>{comparison.length} / 4 已选</Tag>}
                actions={comparison.length > 0 ? (
                  <Button onClick={() => setComparison([])}>清空对比</Button>
                ) : null}
              />
              {comparison.length >= 2 ? (
                <CandidateCompareBoard
                  listings={comparison}
                  onRemove={removeComparison}
                />
              ) : (
                <div className="section-empty">
                  <Empty
                    description={
                      comparison.length === 1
                        ? "还需从候选总榜加入 1 个账号"
                        : "先从候选总榜选择至少 2 个账号"
                    }
                  >
                    <Button
                      type="primary"
                      onClick={() => navigateSection(APP_ROUTES.candidates)}
                    >
                      前往候选总榜
                    </Button>
                  </Empty>
                </div>
              )}
            </section>
          )}
        />

        <Route
          path={APP_ROUTES.events}
          element={(
            <section className="page-stack events-page">
              <PageIntro
                index="04 / CHANGE FEED"
                title="变化提醒"
                description="集中查看降价、新进榜单、安全信息变化和最新快照离场事件。"
                meta={
                  <Tag color={unreadEventCount > 0 ? "warning" : "default"}>
                    {unreadEventCount} 条未读
                  </Tag>
                }
              />
              <section className="refresh-automation events-page__feed">
                <RefreshEventFeed
                  events={refreshEvents}
                  onAcknowledge={() => void acknowledgeRefreshEvents()}
                />
              </section>
            </section>
          )}
        />

        <Route
          path={APP_ROUTES.rules}
          element={(
            <section className="page-stack">
              <PageIntro
                index="05 / SCORING LOGIC"
                title="评分规则"
                description="公开当前硬门槛、价值分配、资产估值与最终推荐分权重。"
              />
              <ScoringRulesPage />
            </section>
          )}
        />

        <Route
          path={APP_ROUTES.exclusions}
          element={(
            <section className="page-stack exclusions-page">
              <PageIntro
                index="06 / REVIEW ARCHIVE"
                title="淘汰记录"
                description="查看违反硬条件或被人工淘汰的账号，保留原因并支持人工恢复。"
                meta={<Tag color="error">{listings.length} 条记录</Tag>}
              />
              {listingWorkspace}
            </section>
          )}
        />

        <Route
          path="*"
          element={<Navigate to={APP_ROUTES.candidates} replace />}
        />
      </Routes>

      {reviewTarget ? (
        <ManualReviewDialog
          listing={reviewTarget}
          pending={reviewPending}
          error={reviewError}
          onCancel={closeManualExclusion}
          onSubmit={excludeReviewedListing}
        />
      ) : null}

      {currentRoute === APP_ROUTES.candidates ? (
        <CompareTray
          listings={comparison}
          onRemove={removeComparison}
          onClear={() => setComparison([])}
          onOpen={openComparison}
        />
      ) : null}
    </AppFrame>
  );
}
