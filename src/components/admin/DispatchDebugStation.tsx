import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Copy,
  Terminal,
  Cpu,
  Wifi,
  ShieldCheck,
  Zap,
  X,
  FileCode,
  Layers,
  Download,
  RotateCcw,
  LifeBuoy,
  Database,
  ArrowUpRight,
  ArrowDownLeft,
  Clock,
  Radio,
  Share2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  FACILITY_COURTS,
  type FacilityCourt,
  type CourtStation,
  type QueueItem,
  getCourtStations,
  saveCourtStations,
  hydrateCourtStationsFromCloud,
  findMatchForCourtStation,
  auditDispatchSystem,
  autoHealDispatchAnomalies,
  forceCloudMasterReset,
  exportLiveSnapshot,
  type DispatchAuditResult,
  type DispatchAuditAnomaly,
} from "@/lib/court-dispatch";
import {
  type LiveMatch,
  getMatches,
  saveMatches,
  isMatchMatchingStation,
  updateMatch,
} from "@/lib/match-store";
import {
  dbGetCourtStations,
  dbGetRawCourtStations,
  getStationLocalWriteAt,
  getDispatchSyncTelemetry,
  dbGetMatches,
  dbSaveMatch,
  flushOfflineScoreJournal,
  getOfflineScoreJournal,
  getRecentScoreSyncEvents,
  subscribeScoreSyncEvents,
  measureScoreSyncLatency,
  type ScoreSyncEvent,
} from "@/lib/supabase-service";

interface DispatchDebugStationProps {
  isOpen: boolean;
  onClose: () => void;
  tournamentSlug?: string;
  onStateRepaired?: () => void;
  initialTab?: DebugTab;
}

export type DebugTab = "score_sync" | "stations" | "audit" | "contingency" | "realtime" | "raw_json";

export function DispatchDebugStation({
  isOpen,
  onClose,
  tournamentSlug,
  onStateRepaired,
  initialTab = "score_sync",
}: DispatchDebugStationProps) {
  const [activeTab, setActiveTab] = useState<DebugTab>(initialTab);
  const [localStations, setLocalStations] = useState<Record<FacilityCourt, CourtStation>>(() => getCourtStations());
  const [cloudStations, setCloudStations] = useState<Record<FacilityCourt, CourtStation> | null>(null);
  const [rawCloudRows, setRawCloudRows] = useState<any[]>([]);
  const [inMemoryMatches, setInMemoryMatches] = useState<LiveMatch[]>(() => getMatches());
  const [cloudMatches, setCloudMatches] = useState<LiveMatch[]>([]);
  const [scoreEvents, setScoreEvents] = useState<ScoreSyncEvent[]>(() => getRecentScoreSyncEvents());
  const [latencyResult, setLatencyResult] = useState<{ latencyMs: number; ok: boolean; error?: string | undefined } | null>(null);
  const [isTestingLatency, setIsTestingLatency] = useState(false);
  const [expandedRalliesCourt, setExpandedRalliesCourt] = useState<FacilityCourt | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [lastAuditResult, setLastAuditResult] = useState<DispatchAuditResult | null>(null);
  const [confirmResetStep, setConfirmResetStep] = useState(false);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  const notify = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 3500);
  };

  // Fresh data loader from both local storage and Supabase
  const loadTelemetry = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const curLocalStations = getCourtStations();
      setLocalStations(curLocalStations);

      const curMatches = getMatches();
      setInMemoryMatches(curMatches);

      const [cloudSt, rawRows, cloudM] = await Promise.all([
        dbGetCourtStations().catch(() => ({})),
        dbGetRawCourtStations().catch(() => []),
        dbGetMatches(tournamentSlug).catch(() => []),
      ]);
      setCloudStations(cloudSt as Record<FacilityCourt, CourtStation>);
      setRawCloudRows(rawRows);
      setCloudMatches(cloudM);
      setScoreEvents(getRecentScoreSyncEvents());

      // Perform audit
      let queue: QueueItem[] = [];
      try {
        const rawQ = localStorage.getItem("dv_dispatch_queue");
        if (rawQ) queue = JSON.parse(rawQ);
      } catch {}

      const audit = auditDispatchSystem(
        curLocalStations,
        curMatches,
        queue,
        cloudSt as Record<FacilityCourt, CourtStation>
      );
      setLastAuditResult(audit);
    } catch (err) {
      console.warn("[DebugStation] Error loading telemetry:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [tournamentSlug]);

  useEffect(() => {
    if (!isOpen) return;
    loadTelemetry();
    const unsub = subscribeScoreSyncEvents((evt) => {
      setScoreEvents((prev) => [evt, ...prev.slice(0, 49)]);
    });
    const interval = setInterval(() => {
      loadTelemetry();
    }, 3500);
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [isOpen, loadTelemetry]);

  // Telemetry metrics from supabase-service
  const syncTelemetry = useMemo(() => {
    return getDispatchSyncTelemetry();
  }, [localStations, isRefreshing]);

  // Execute Auto-Heal & Purge
  const handleAutoHeal = () => {
    const { repairedCount } = autoHealDispatchAnomalies(localStations, inMemoryMatches);
    loadTelemetry();
    if (onStateRepaired) onStateRepaired();
    notify(repairedCount > 0 ? `Repaired and cleared ${repairedCount} dispatch anomalies.` : "All stations already healthy.");
  };

  // Force Cloud Re-sync
  const handleForceCloudResync = async () => {
    setIsRefreshing(true);
    try {
      await hydrateCourtStationsFromCloud();
      await dbGetMatches(tournamentSlug);
      await loadTelemetry();
      if (onStateRepaired) onStateRepaired();
      notify("Force re-synced all stations and matches with cloud.");
    } catch {
      notify("Re-sync encountered network delay.");
    } finally {
      setIsRefreshing(false);
    }
  };

  // Copy Complete Telemetry Report
  const handleCopyTelemetryReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      tournamentSlug: tournamentSlug || "all",
      healthScore: lastAuditResult?.score ?? 100,
      anomalies: lastAuditResult?.anomalies ?? [],
      localStations,
      cloudStations,
      rawCloudRows,
      syncTelemetry,
      activeCourtMatches: FACILITY_COURTS.map((c) => ({
        court: c,
        match: findMatchForCourtStation(c, localStations[c], inMemoryMatches),
      })),
    };
    navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    notify("Full diagnostic telemetry copied to clipboard.");
  };

  // Disaster Recovery: Hard Cloud Master Reset
  const handleForceCloudMasterReset = async () => {
    setIsRefreshing(true);
    try {
      const res = await forceCloudMasterReset(tournamentSlug);
      await loadTelemetry();
      if (onStateRepaired) onStateRepaired();
      if (res.success) {
        notify(`Master Reset Complete: Re-anchored to cloud ground-truth with ${res.matchesCount} matches.`);
      } else {
        notify("Master reset completed with local defaults.");
      }
    } catch {
      notify("Master reset encountered an error.");
    } finally {
      setIsRefreshing(false);
      setConfirmResetStep(false);
    }
  };

  // Disaster Recovery: Export Live Snapshot
  const handleExportSnapshot = () => {
    exportLiveSnapshot(tournamentSlug);
    notify("Disaster recovery snapshot downloaded as JSON.");
  };

  // Replay Offline Score Journal
  const handleFlushOfflineJournal = async () => {
    setIsRefreshing(true);
    try {
      const count = await flushOfflineScoreJournal();
      await loadTelemetry();
      if (count > 0) {
        notify(`Successfully replayed ${count} offline score updates to Supabase.`);
      } else {
        notify("Offline score journal is empty. All scores are current.");
      }
    } catch {
      notify("Failed to replay offline score journal.");
    } finally {
      setIsRefreshing(false);
    }
  };

  // Score Sync comparison matrix for Courts 1-4
  const courtScoreSyncMatrix = useMemo(() => {
    return FACILITY_COURTS.map((court) => {
      const locSt = localStations[court];
      const cldSt = cloudStations ? cloudStations[court] : undefined;

      const localMatch = findMatchForCourtStation(court, locSt, inMemoryMatches);
      const cloudMatch =
        findMatchForCourtStation(court, cldSt, cloudMatches) ||
        (localMatch ? cloudMatches.find((m) => m.id === localMatch.id) : null);

      const hasActiveMatch = Boolean(localMatch || cloudMatch);
      const match = localMatch || cloudMatch;

      const locScoreA = localMatch?.score?.teamAScore ?? 0;
      const locScoreB = localMatch?.score?.teamBScore ?? 0;
      const locServer = localMatch?.score?.serverNumber ?? 1;
      const locServing = localMatch?.score?.servingTeam ?? "A";
      const locRallies = localMatch?.score?.rallies?.length ?? 0;

      const cldScoreA = cloudMatch?.score?.teamAScore ?? 0;
      const cldScoreB = cloudMatch?.score?.teamBScore ?? 0;
      const cldServer = cloudMatch?.score?.serverNumber ?? 1;
      const cldServing = cloudMatch?.score?.servingTeam ?? "A";
      const cldRallies = cloudMatch?.score?.rallies?.length ?? 0;

      const scoreDiffers = Boolean(hasActiveMatch && (locScoreA !== cldScoreA || locScoreB !== cldScoreB));
      const serverDiffers = Boolean(hasActiveMatch && (locServer !== cldServer || locServing !== cldServing));
      const statusDiffers = Boolean(hasActiveMatch && localMatch?.status !== cloudMatch?.status);
      const ralliesDiffers = Boolean(hasActiveMatch && Math.abs(locRallies - cldRallies) > 0);

      const isDesynced = scoreDiffers || serverDiffers || statusDiffers;

      return {
        court,
        hasActiveMatch,
        match,
        localMatch,
        cloudMatch,
        locScoreA,
        locScoreB,
        locServer,
        locServing,
        locRallies,
        cldScoreA,
        cldScoreB,
        cldServer,
        cldServing,
        cldRallies,
        scoreDiffers,
        serverDiffers,
        statusDiffers,
        ralliesDiffers,
        isDesynced,
        officiatedBy: localMatch?.officiatedBy || cloudMatch?.officiatedBy || locSt.assignedUmpire || "Unassigned",
      };
    });
  }, [localStations, cloudStations, inMemoryMatches, cloudMatches]);

  const desyncedCourtCount = useMemo(() => {
    return courtScoreSyncMatrix.filter((c) => c.hasActiveMatch && c.isDesynced).length;
  }, [courtScoreSyncMatrix]);

  const handlePullCloudScoreToLocal = (court: FacilityCourt, cldMatch: LiveMatch) => {
    updateMatch(cldMatch.id, () => cldMatch);
    loadTelemetry();
    if (onStateRepaired) onStateRepaired();
    notify(`Pulled Cloud score (${cldMatch.score.teamAScore}-${cldMatch.score.teamBScore}) on ${court} to Admin.`);
  };

  const handlePushLocalScoreToCloud = async (court: FacilityCourt, locMatch: LiveMatch) => {
    setIsRefreshing(true);
    try {
      await dbSaveMatch(locMatch, tournamentSlug);
      await loadTelemetry();
      notify(`Pushed Admin score (${locMatch.score.teamAScore}-${locMatch.score.teamBScore}) on ${court} to Cloud.`);
    } catch {
      notify("Failed to push score to Cloud.");
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleFlushOfflineScores = async () => {
    const count = await flushOfflineScoreJournal();
    loadTelemetry();
    notify(count > 0 ? `Flushed ${count} offline score entries to Supabase.` : "Offline journal is already clean.");
  };

  const handleTestLatency = async () => {
    setIsTestingLatency(true);
    try {
      const res = await measureScoreSyncLatency();
      setLatencyResult(res);
      notify(`Supabase latency: ${res.latencyMs}ms (${res.ok ? "Healthy" : "Degraded"}).`);
    } finally {
      setIsTestingLatency(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto">
      <div className="surface-card bg-charcoal border-2 border-pickle/50 text-sand w-full max-w-6xl max-h-[92vh] flex flex-col shadow-2xl rounded-none overflow-hidden my-auto">
        {/* ── Header ── */}
        <div className="px-4 sm:px-6 py-4 border-b border-border bg-charcoal/90 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 bg-pickle/20 border border-pickle/40 flex items-center justify-center flex-shrink-0">
              <Terminal size={18} className="text-pickle" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[0.65rem] font-bold uppercase tracking-[0.28em] text-pickle font-mono">
                  Diagnostics &amp; Telemetry
                </span>
                {lastAuditResult && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border ${
                      lastAuditResult.healthy
                        ? "bg-pickle/20 border-pickle text-pickle"
                        : lastAuditResult.score > 60
                        ? "bg-amber-500/20 border-amber-500 text-amber-300"
                        : "bg-brick/20 border-brick text-brick"
                    }`}
                  >
                    {lastAuditResult.healthy ? (
                      <CheckCircle2 size={11} />
                    ) : (
                      <AlertTriangle size={11} />
                    )}
                    <span>Health: {lastAuditResult.score}%</span>
                    <span>({lastAuditResult.anomalies.length} alerts)</span>
                  </span>
                )}
              </div>
              <h3 className="font-display text-xl sm:text-2xl text-foreground mt-0.5">
                Dispatch Debug Station
              </h3>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleForceCloudResync}
              disabled={isRefreshing}
              title="Force re-fetch from Supabase cloud database"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw size={12} className={isRefreshing ? "animate-spin text-pickle" : ""} />
              <span>Poll Cloud</span>
            </button>

            <button
              onClick={handleAutoHeal}
              title="Repair orphaned matches, clear ghost court claims, and reconcile"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/50 hover:bg-pickle/30 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Zap size={12} />
              <span>Auto-Heal Ghosts</span>
            </button>

            <button
              onClick={handleCopyTelemetryReport}
              title="Copy complete JSON telemetry report to clipboard"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Copy size={12} />
              <span>Copy Report</span>
            </button>

            <button
              onClick={handleExportSnapshot}
              title="Export complete disaster recovery snapshot (JSON)"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Download size={12} />
              <span>Export Snapshot</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 text-sand/70 hover:text-sand border border-border hover:border-brick/50 hover:bg-brick/20 transition-colors cursor-pointer"
              title="Close Debug Station"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ── Status Toast Notice ── */}
        {actionNotice && (
          <div className="bg-pickle/15 border-b border-pickle/40 px-4 py-2 text-xs font-bold text-pickle flex items-center justify-between font-mono animate-fadeIn">
            <span>{actionNotice}</span>
            <button onClick={() => setActionNotice(null)} className="text-pickle hover:underline cursor-pointer">
              Dismiss
            </button>
          </div>
        )}

        {/* ── Tab Bar ── */}
        <div className="flex border-b border-border bg-charcoal/50 px-4 sm:px-6 overflow-x-auto gap-2">
          <button
            onClick={() => setActiveTab("score_sync")}
            className={`py-3 px-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === "score_sync"
                ? "border-pickle text-pickle"
                : "border-transparent text-sand/70 hover:text-sand"
            }`}
          >
            <Activity size={13} />
            <span>Score Synchrony Telemetry</span>
            {desyncedCourtCount > 0 ? (
              <span className="px-1.5 py-0.2 text-[0.6rem] bg-brick text-sand font-mono font-bold rounded-xs animate-pulse">
                {desyncedCourtCount} Desync
              </span>
            ) : (
              <span className="px-1.5 py-0.2 text-[0.6rem] bg-pickle/20 text-pickle font-mono font-bold rounded-xs">
                In Sync
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("stations")}
            className={`py-3 px-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === "stations"
                ? "border-pickle text-pickle"
                : "border-transparent text-sand/70 hover:text-sand"
            }`}
          >
            <Layers size={13} />
            <span>Courts 1–4 Telemetry Matrix</span>
          </button>

          <button
            onClick={() => setActiveTab("audit")}
            className={`py-3 px-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === "audit"
                ? "border-pickle text-pickle"
                : "border-transparent text-sand/70 hover:text-sand"
            }`}
          >
            <ShieldCheck size={13} />
            <span>Audit &amp; Anomaly Pinpointer ({lastAuditResult?.anomalies.length ?? 0})</span>
          </button>

          <button
            onClick={() => setActiveTab("contingency")}
            className={`py-3 px-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === "contingency"
                ? "border-pickle text-pickle"
                : "border-transparent text-sand/70 hover:text-sand"
            }`}
          >
            <LifeBuoy size={13} />
            <span>Contingency &amp; Fallback</span>
          </button>

          <button
            onClick={() => setActiveTab("realtime")}
            className={`py-3 px-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === "realtime"
                ? "border-pickle text-pickle"
                : "border-transparent text-sand/70 hover:text-sand"
            }`}
          >
            <Wifi size={13} />
            <span>Realtime Socket &amp; Schedulers</span>
          </button>

          <button
            onClick={() => setActiveTab("raw_json")}
            className={`py-3 px-4 text-xs font-bold uppercase tracking-widest border-b-2 transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === "raw_json"
                ? "border-pickle text-pickle"
                : "border-transparent text-sand/70 hover:text-sand"
            }`}
          >
            <FileCode size={13} />
            <span>Raw Cloud DB Inspector</span>
          </button>
        </div>

        {/* ── Main Tab Content Area ── */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* TAB 0: Umpire <-> Admin Live Score Sync Telemetry */}
          {activeTab === "score_sync" && (
            <div className="space-y-6">
              {/* Header metrics strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                {/* 1. Sync Health Card */}
                <div className={`p-4 border-2 bg-charcoal/90 flex flex-col justify-between ${
                  desyncedCourtCount > 0
                    ? "border-brick/70 shadow-md shadow-brick/10"
                    : "border-pickle/60 shadow-md shadow-pickle/10"
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground font-mono">
                      Umpire / Admin Sync
                    </span>
                    {desyncedCourtCount > 0 ? (
                      <AlertTriangle size={15} className="text-brick animate-pulse" />
                    ) : (
                      <CheckCircle2 size={15} className="text-pickle" />
                    )}
                  </div>
                  <div className="mt-2">
                    <div className={`font-display text-2xl ${desyncedCourtCount > 0 ? "text-brick" : "text-pickle"}`}>
                      {desyncedCourtCount > 0 ? `${desyncedCourtCount} Desynced Court(s)` : "All Courts In Sync"}
                    </div>
                    <span className="text-xs text-sand/70 block mt-0.5">
                      {desyncedCourtCount > 0
                        ? "Score or server divergence between Umpire phone and Admin console."
                        : "Umpire cloud scores perfectly match Admin display scores."}
                    </span>
                  </div>
                </div>

                {/* 2. Realtime WebSocket Channel */}
                <div className="p-4 border-2 border-border bg-charcoal/90 flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground font-mono">
                      Realtime Channel
                    </span>
                    <Radio size={14} className={syncTelemetry.sharedChannelConnected ? "text-pickle animate-pulse" : "text-brick"} />
                  </div>
                  <div className="mt-2">
                    <div className="font-display text-xl text-sand flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${syncTelemetry.sharedChannelConnected ? "bg-pickle animate-pulse" : "bg-brick"}`} />
                      <span>{syncTelemetry.sharedChannelConnected ? "Connected" : "Disconnected"}</span>
                    </div>
                    <span className="text-xs text-sand/60 font-mono block mt-0.5">
                      channel: dink-valley-live-pubsub
                    </span>
                  </div>
                </div>

                {/* 3. Roundtrip Latency Ping */}
                <div className="p-4 border-2 border-border bg-charcoal/90 flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground font-mono">
                      Cloud Latency (RTT)
                    </span>
                    <Clock size={14} className="text-sand/60" />
                  </div>
                  <div className="mt-2">
                    <div className="font-display text-xl text-sand flex items-center justify-between">
                      <span>{latencyResult ? `${latencyResult.latencyMs} ms` : "Untested"}</span>
                      <button
                        type="button"
                        onClick={handleTestLatency}
                        disabled={isTestingLatency}
                        className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal border border-border hover:border-pickle text-sand hover:text-pickle transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {isTestingLatency ? "Pinging..." : "Test Ping"}
                      </button>
                    </div>
                    <span className="text-xs text-sand/60 block mt-0.5">
                      {latencyResult
                        ? latencyResult.ok
                          ? "Supabase database response time"
                          : `Error: ${latencyResult.error}`
                        : "Click Test Ping to measure roundtrip"}
                    </span>
                  </div>
                </div>

                {/* 4. Offline Score Journal */}
                <div className="p-4 border-2 border-border bg-charcoal/90 flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground font-mono">
                      Offline Score Queue
                    </span>
                    <Database size={14} className={syncTelemetry.offlineJournalCount > 0 ? "text-amber-400" : "text-sand/60"} />
                  </div>
                  <div className="mt-2">
                    <div className="font-display text-xl text-sand flex items-center justify-between">
                      <span className={syncTelemetry.offlineJournalCount > 0 ? "text-amber-400 font-bold" : ""}>
                        {syncTelemetry.offlineJournalCount} pending
                      </span>
                      {syncTelemetry.offlineJournalCount > 0 && (
                        <button
                          type="button"
                          onClick={handleFlushOfflineScores}
                          className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors cursor-pointer"
                        >
                          Flush Now
                        </button>
                      )}
                    </div>
                    <span className="text-xs text-sand/60 block mt-0.5">
                      {syncTelemetry.offlineJournalCount > 0
                        ? "Scores queued on device awaiting network upload"
                        : "All scores successfully persisted to cloud"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Courts 1-4 Synchrony Matrix */}
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/80 pb-2">
                  <div>
                    <h3 className="font-display text-lg text-sand font-bold uppercase tracking-wider">
                      Live Courts 1–4 Score Synchrony Matrix
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Real-time side-by-side comparison between Umpire phone scores in Supabase and the Admin scoreboard.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleForceCloudResync()}
                      disabled={isRefreshing}
                      className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/40 hover:border-pickle hover:text-pickle transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
                      <span>Force Re-fetch All</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                  {courtScoreSyncMatrix.map((item) => {
                    const isExpanded = expandedRalliesCourt === item.court;
                    const ralliesList = (item.cloudMatch?.score?.rallies || item.localMatch?.score?.rallies || []) as any[];

                    return (
                      <div
                        key={item.court}
                        className={`p-4 border-2 bg-charcoal/95 flex flex-col justify-between space-y-3.5 transition-all ${
                          item.isDesynced
                            ? "border-brick/80 shadow-md shadow-brick/20"
                            : item.hasActiveMatch
                            ? "border-pickle/80 shadow-md shadow-pickle/10"
                            : "border-border/60"
                        }`}
                      >
                        {/* Court Header */}
                        <div className="flex items-center justify-between border-b border-border/80 pb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-display text-xl text-sand font-bold">{item.court}</span>
                          </div>
                          <div>
                            {item.isDesynced ? (
                              <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-brick/20 border border-brick text-brick flex items-center gap-1 animate-pulse">
                                <AlertTriangle size={10} />
                                <span>Desync</span>
                              </span>
                            ) : item.hasActiveMatch ? (
                              <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 border border-pickle text-pickle flex items-center gap-1">
                                <CheckCircle2 size={10} />
                                <span>In Sync</span>
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal border border-border text-sand/60">
                                Open
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Match Details */}
                        <div className="space-y-1">
                          {item.match ? (
                            <>
                              <div className="font-bold text-sm text-foreground truncate">
                                {item.match.teamAName} <span className="text-muted-foreground font-normal">vs</span> {item.match.teamBName}
                              </div>
                              <div className="flex items-center justify-between text-[0.65rem] text-muted-foreground">
                                <span className="truncate">{item.match.stage || "Facility Match"}</span>
                                <span className="text-pickle font-mono truncate">{item.officiatedBy}</span>
                              </div>
                            </>
                          ) : (
                            <div className="py-4 text-center text-xs text-muted-foreground italic">
                              No match currently assigned to this court.
                            </div>
                          )}
                        </div>

                        {/* Side-by-Side Comparison */}
                        {item.hasActiveMatch && (
                          <div className="space-y-2 pt-1 border-t border-border/60">
                            <div className="grid grid-cols-2 gap-2 text-center">
                              {/* Cloud / Umpire */}
                              <div className="p-2.5 bg-black/40 border border-white/5 rounded-xs space-y-1">
                                <span className="text-[0.6rem] font-bold uppercase tracking-wider text-sand/60 block">
                                  Umpire / Cloud
                                </span>
                                <div className="font-mono text-xl font-bold text-pickle">
                                  {item.cldScoreA} - {item.cldScoreB}
                                </div>
                                <span className="text-[0.6rem] text-sand/70 block">
                                  Tm {item.cldServing} #{item.cldServer} &bull; {item.cldRallies}r
                                </span>
                              </div>

                              {/* Local / Admin */}
                              <div className="p-2.5 bg-black/40 border border-white/5 rounded-xs space-y-1">
                                <span className="text-[0.6rem] font-bold uppercase tracking-wider text-sand/60 block">
                                  Admin Console
                                </span>
                                <div className={`font-mono text-xl font-bold ${
                                  item.scoreDiffers ? "text-brick animate-pulse" : "text-pickle"
                                }`}>
                                  {item.locScoreA} - {item.locScoreB}
                                </div>
                                <span className="text-[0.6rem] text-sand/70 block">
                                  Tm {item.locServing} #{item.locServer} &bull; {item.locRallies}r
                                </span>
                              </div>
                            </div>

                            {/* Desync Alert details if divergent */}
                            {item.isDesynced && (
                              <div className="p-2 bg-brick/15 border border-brick/40 text-[0.65rem] text-brick space-y-0.5">
                                <div className="font-bold flex items-center gap-1">
                                  <AlertTriangle size={11} />
                                  <span>Score / Server Mismatch:</span>
                                </div>
                                <div>
                                  Cloud: {item.cldScoreA}-{item.cldScoreB} (Team {item.cldServing} #{item.cldServer})
                                </div>
                                <div>
                                  Admin: {item.locScoreA}-{item.locScoreB} (Team {item.locServing} #{item.locServer})
                                </div>
                              </div>
                            )}

                            {/* Actions per Court */}
                            <div className="space-y-1.5 pt-1">
                              {item.cloudMatch && (
                                <button
                                  type="button"
                                  onClick={() => handlePullCloudScoreToLocal(item.court, item.cloudMatch!)}
                                  className="w-full py-1 px-2 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/40 hover:border-pickle hover:text-pickle transition-colors cursor-pointer flex items-center justify-center gap-1"
                                  title="Pull cloud score to local admin state"
                                >
                                  <ArrowDownLeft size={11} />
                                  <span>Pull Cloud Score to Admin</span>
                                </button>
                              )}

                              {item.localMatch && (
                                <button
                                  type="button"
                                  onClick={() => handlePushLocalScoreToCloud(item.court, item.localMatch!)}
                                  className="w-full py-1 px-2 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand/80 border border-border hover:border-sand hover:text-sand transition-colors cursor-pointer flex items-center justify-center gap-1"
                                  title="Push local admin score to cloud"
                                >
                                  <ArrowUpRight size={11} />
                                  <span>Push Admin Score to Cloud</span>
                                </button>
                              )}

                              {ralliesList.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setExpandedRalliesCourt(isExpanded ? null : item.court)}
                                  className="w-full py-1 text-[0.6rem] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center justify-center gap-1"
                                >
                                  <span>{isExpanded ? "Hide Rally Log" : `View ${ralliesList.length} Rallies Log`}</span>
                                  {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                </button>
                              )}

                              {isExpanded && ralliesList.length > 0 && (
                                <div className="p-2 bg-black/50 border border-border/60 max-h-36 overflow-y-auto space-y-1 text-[0.6rem] font-mono">
                                  {ralliesList.slice().reverse().map((r, rIdx) => (
                                    <div key={rIdx} className="flex items-center justify-between border-b border-white/5 pb-0.5">
                                      <span className="text-sand/60">Rally #{ralliesList.length - rIdx}</span>
                                      <span className="font-bold text-pickle">
                                        Point: {r.pointScoredBy === "A" ? (item.match?.teamAName || "Team A") : (item.match?.teamBName || "Team B")}
                                      </span>
                                      <span className="text-muted-foreground">
                                        ({r.scoreBeforeA}-{r.scoreBeforeB} &rarr; {r.scoreAfterA}-{r.scoreAfterB})
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Live Score Synchronization Event Stream (Log) */}
              <div className="surface-card p-4 sm:p-5 border border-border space-y-3 bg-charcoal/95">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/80 pb-2">
                  <div className="flex items-center gap-2">
                    <Terminal size={15} className="text-pickle" />
                    <h4 className="font-display text-base text-sand font-bold uppercase tracking-wider">
                      Real-time Score Synchronization Event Stream ({scoreEvents.length})
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setScoreEvents([])}
                      className="px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand/70 border border-border hover:border-sand hover:text-sand transition-colors cursor-pointer"
                    >
                      Clear Stream
                    </button>
                  </div>
                </div>

                {scoreEvents.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground italic font-mono">
                    No score events captured in this session yet. When an umpire scores or an admin updates a match, live sync events stream here instantly.
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto divide-y divide-border/60 font-mono text-xs space-y-1">
                    {scoreEvents.map((evt) => (
                      <div key={evt.id} className="py-2 px-1 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 hover:bg-white/5 transition-colors">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span className="text-[0.65rem] text-muted-foreground">
                            {new Date(evt.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </span>
                          <span className={`px-1.5 py-0.2 text-[0.6rem] font-bold uppercase tracking-wider border rounded-xs ${
                            evt.source === "realtime"
                              ? "bg-blue-500/20 border-blue-500/40 text-blue-300"
                              : evt.source === "local_save"
                              ? "bg-pickle/20 border-pickle/40 text-pickle"
                              : "bg-amber-500/20 border-amber-500/40 text-amber-300"
                          }`}>
                            {evt.source === "realtime" ? "Realtime Socket" : evt.source === "local_save" ? "Umpire Save" : "Offline Replay"}
                          </span>
                          {evt.court && (
                            <span className="px-1.5 py-0.2 text-[0.6rem] bg-charcoal border border-border text-sand font-bold">
                              {evt.court}
                            </span>
                          )}
                          <span className="font-semibold text-foreground truncate max-w-xs sm:max-w-none">
                            {evt.teams}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                          <span className="font-bold text-pickle text-sm">
                            {evt.scoreA} - {evt.scoreB}
                          </span>
                          <span className="text-[0.65rem] text-sand/60">
                            Server {evt.servingTeam}#{evt.serverNumber}
                          </span>
                          {evt.officiatedBy && (
                            <span className="text-[0.65rem] text-muted-foreground">
                              Official: {evt.officiatedBy}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 1: Stations Matrix */}
          {activeTab === "stations" && (
            <div className="space-y-4">
              <div className="text-xs text-sand/80 font-medium">
                Live side-by-side inspection of all 4 Facility Courts comparing Local Storage, Cloud Database row, and Resolved Match object.
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                {FACILITY_COURTS.map((court) => {
                  const loc = localStations[court];
                  const cld = cloudStations ? cloudStations[court] : null;
                  const activeMatch = findMatchForCourtStation(court, loc, inMemoryMatches);
                  const now = Date.now();
                  const sinceLocalWrite = now - getStationLocalWriteAt(court);
                  const isWriteProtected = sinceLocalWrite < 6000;

                  // Divergence checks
                  const statusDiffers = cld && loc && cld.status !== loc.status;
                  const matchDiffers = cld && loc && (cld.currentMatchId ?? null) !== (loc.currentMatchId ?? null);
                  const hasDivergence = statusDiffers || matchDiffers;

                  return (
                    <div
                      key={court}
                      className={`p-4 border-2 flex flex-col justify-between space-y-3 bg-charcoal/90 ${
                        hasDivergence
                          ? "border-amber-500/80 shadow-md shadow-amber-500/10"
                          : activeMatch?.status === "live"
                          ? "border-pickle/80 shadow-md shadow-pickle/10"
                          : "border-border"
                      }`}
                    >
                      {/* Court Header */}
                      <div className="flex items-center justify-between border-b border-border/80 pb-2">
                        <span className="font-display text-xl text-sand font-bold">{court}</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {isWriteProtected && (
                            <span className="text-[0.6rem] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-blue-500/20 text-blue-300 border border-blue-500/40">
                              Lock: {Math.round((6000 - sinceLocalWrite) / 1000)}s
                            </span>
                          )}
                          <span
                            className={`text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 border ${
                              loc.status === "live"
                                ? "bg-pickle/20 text-pickle border-pickle"
                                : loc.status === "warmup"
                                ? "bg-amber-500/20 text-amber-300 border-amber-500"
                                : loc.status === "maintenance"
                                ? "bg-brick/20 text-brick border-brick"
                                : "bg-charcoal text-sand/70 border-border"
                            }`}
                          >
                            {loc.status}
                          </span>
                        </div>
                      </div>

                      {/* State Details */}
                      <div className="space-y-2 text-xs font-mono">
                        {/* Local vs Cloud Match ID */}
                        <div className="bg-black/30 p-2 border border-white/5 space-y-1">
                          <span className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 block">
                            Assigned Match ID:
                          </span>
                          <div className="text-[0.7rem] break-all">
                            <span className="text-sand/50">Local: </span>
                            <span className={loc.currentMatchId ? "text-pickle font-bold" : "text-sand/60"}>
                              {loc.currentMatchId || "null (idle)"}
                            </span>
                          </div>
                          <div className="text-[0.7rem] break-all">
                            <span className="text-sand/50">Cloud: </span>
                            <span className={cld?.currentMatchId ? "text-pickle font-bold" : "text-sand/60"}>
                              {cld ? cld.currentMatchId || "null (idle)" : "fetching..."}
                            </span>
                          </div>
                        </div>

                        {/* Resolved Match Details */}
                        <div className="bg-black/30 p-2 border border-white/5 space-y-1">
                          <span className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 block">
                            Resolved Match Object:
                          </span>
                          {activeMatch ? (
                            <div className="space-y-1 text-[0.7rem]">
                              <div className="font-bold text-sand truncate">
                                {activeMatch.teamAName} vs {activeMatch.teamBName}
                              </div>
                              <div className="text-sand/70 flex items-center justify-between">
                                <span>Score: {activeMatch.score.teamAScore} - {activeMatch.score.teamBScore}</span>
                                <span>Rallies: {activeMatch.score.rallies?.length ?? 0}</span>
                              </div>
                              <div className="text-sand/60 text-[0.65rem] flex items-center justify-between">
                                <span>Stage: {activeMatch.stage || "None"}</span>
                                <span>Status: {activeMatch.status}</span>
                              </div>
                              {activeMatch.officiatedBy && (
                                <div className="text-pickle text-[0.65rem]">
                                  Official: {activeMatch.officiatedBy}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-[0.7rem] text-sand/50 italic">
                              No match resolved (Court clear)
                            </div>
                          )}
                        </div>

                        {/* On-Deck / Maintenance */}
                        <div className="text-[0.65rem] text-sand/60 space-y-0.5">
                          <div>On-Deck: {loc.onDeckMatchId || "none"}</div>
                          <div>Official: {loc.assignedUmpire || "unassigned"}</div>
                          {loc.maintenanceNote && (
                            <div className="text-brick font-medium">Note: {loc.maintenanceNote}</div>
                          )}
                        </div>
                      </div>

                      {/* Quick Court Actions */}
                      <div className="pt-2 border-t border-border/80 flex items-center gap-2">
                        {hasDivergence && (
                          <span className="text-[0.6rem] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-1.5 py-0.5 border border-amber-500/30">
                            Cloud Divergence
                          </span>
                        )}
                        {!activeMatch && loc.status === "available" && (
                          <span className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono">
                            Verified Idle
                          </span>
                        )}
                        {activeMatch && loc.status === "live" && !hasDivergence && (
                          <span className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono">
                            Verified Live
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: Audit & Anomaly Pinpointer */}
          {activeTab === "audit" && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-3">
                <div>
                  <h4 className="font-display text-lg text-sand font-bold">
                    Automated Integrity Scanner
                  </h4>
                  <p className="text-xs text-sand/70">
                    Pins down ghost match claims, orphaned assignments, simultaneous play conflicts, and status divergence.
                  </p>
                </div>
                <button
                  onClick={loadTelemetry}
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal border border-border hover:border-pickle text-sand transition-colors cursor-pointer flex items-center gap-1.5 self-start"
                >
                  <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
                  <span>Re-scan Now</span>
                </button>
              </div>

              {lastAuditResult && lastAuditResult.anomalies.length === 0 ? (
                <div className="p-8 border border-pickle/40 bg-pickle/10 text-center space-y-2">
                  <CheckCircle2 size={32} className="text-pickle mx-auto" />
                  <span className="font-display text-xl text-sand font-bold block">
                    Zero Anomalies Detected
                  </span>
                  <p className="text-xs text-sand/80 max-w-md mx-auto">
                    All court stations, memory matches, and queue items are completely synchronized and conflict-free.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {lastAuditResult?.anomalies.map((a) => (
                    <div
                      key={a.id}
                      className={`p-4 border-l-4 border bg-black/40 space-y-2 ${
                        a.severity === "error"
                          ? "border-l-brick border-white/10"
                          : a.severity === "warning"
                          ? "border-l-amber-500 border-white/10"
                          : "border-l-pickle border-white/10"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider font-mono border ${
                              a.severity === "error"
                                ? "bg-brick/20 border-brick text-brick"
                                : a.severity === "warning"
                                ? "bg-amber-500/20 border-amber-500 text-amber-300"
                                : "bg-pickle/20 border-pickle text-pickle"
                            }`}
                          >
                            {a.severity}
                          </span>
                          <span className="text-xs font-bold uppercase tracking-wider text-sand">
                            {a.title}
                          </span>
                          {a.court && (
                            <span className="text-[0.65rem] font-mono px-1.5 py-0.2 bg-charcoal text-sand border border-border">
                              {a.court}
                            </span>
                          )}
                        </div>
                        {a.fixable && (
                          <button
                            onClick={handleAutoHeal}
                            className="px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 hover:bg-pickle/30 cursor-pointer"
                          >
                            Auto-Resolve
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-sand/80 font-medium">{a.description}</p>
                      {a.matchId && (
                        <div className="text-[0.65rem] font-mono text-sand/60">
                          Target Match ID: <span className="text-sand">{a.matchId}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Contingency & Fallback */}
          {activeTab === "contingency" && (
            <div className="space-y-6">
              <div className="text-xs text-sand/80 font-medium">
                Contingency fail-safes and disaster recovery mechanisms to prevent hallucinated states and recover from network partition or browser drift.
              </div>

              {/* Section 1: One-Click Cloud Master Reset */}
              <div className="p-5 bg-charcoal border-2 border-brick/40 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <RotateCcw size={16} className="text-brick" />
                      <span className="font-display text-lg text-sand font-bold">
                        Hard Cloud Master Reset
                      </span>
                    </div>
                    <p className="text-xs text-sand/70 max-w-2xl leading-relaxed">
                      Instantly clears local browser storage drift (offline journals, cached station slots, lingering ghost matches) and forces a fresh, authoritative reload directly from the Supabase cloud master database.
                    </p>
                  </div>

                  {!confirmResetStep ? (
                    <button
                      onClick={() => setConfirmResetStep(true)}
                      className="px-4 py-2 bg-brick/20 text-brick border border-brick hover:bg-brick hover:text-white transition-colors text-xs font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer flex items-center gap-1.5 self-start"
                    >
                      <RotateCcw size={13} />
                      <span>Purge &amp; Restore Master</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 self-start flex-wrap">
                      <button
                        onClick={handleForceCloudMasterReset}
                        disabled={isRefreshing}
                        className="px-4 py-2 bg-brick text-white hover:bg-brick/90 transition-colors text-xs font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer flex items-center gap-1.5"
                      >
                        <RotateCcw size={13} className={isRefreshing ? "animate-spin" : ""} />
                        <span>Confirm Hard Reset</span>
                      </button>
                      <button
                        onClick={() => setConfirmResetStep(false)}
                        className="px-3 py-2 bg-charcoal text-sand/70 border border-border hover:text-sand text-xs font-bold uppercase tracking-wider cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>

                {confirmResetStep && (
                  <div className="p-3 bg-brick/10 border border-brick/30 text-xs font-mono text-brick">
                    Warning: This action purges all local un-synced cache entries on this device and re-initializes from cloud truth. All open tabs on this browser will be broadcast to re-sync.
                  </div>
                )}
              </div>

              {/* Section 2: Disaster Recovery Live Snapshot Export */}
              <div className="p-5 bg-charcoal border border-border space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Download size={16} className="text-pickle" />
                      <span className="font-display text-lg text-sand font-bold">
                        Disaster Recovery Snapshot Export
                      </span>
                    </div>
                    <p className="text-xs text-sand/70 max-w-2xl leading-relaxed">
                      Download a complete, portable JSON snapshot of current facility court stations, active matches, live scores, queue records, and offline journals. Useful as a physical event log or emergency restore state.
                    </p>
                  </div>

                  <button
                    onClick={handleExportSnapshot}
                    className="px-4 py-2 bg-pickle/20 text-pickle border border-pickle hover:bg-pickle hover:text-charcoal transition-colors text-xs font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer flex items-center gap-1.5 self-start"
                  >
                    <Download size={13} />
                    <span>Export JSON Snapshot</span>
                  </button>
                </div>
              </div>

              {/* Section 3: Offline Score Journal & Replay Engine */}
              <div className="p-5 bg-charcoal border border-border space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Database size={16} className="text-blue-400" />
                      <span className="font-display text-lg text-sand font-bold">
                        Offline Score Journal &amp; Replay Engine
                      </span>
                    </div>
                    <p className="text-xs text-sand/70 max-w-2xl leading-relaxed">
                      If an umpire scores points while Wi-Fi drops or during transient network timeouts, scores are automatically cached into the browser offline journal. When connection restores or the device tab awakens, scores automatically replay to Supabase.
                    </p>
                  </div>

                  <div className="flex items-center gap-3 self-start flex-wrap">
                    <div className="px-3 py-2 bg-black/40 border border-border font-mono text-xs">
                      <span className="text-sand/60">Queued Scores: </span>
                      <span className={`font-bold ${syncTelemetry.offlineJournalCount > 0 ? "text-amber-300" : "text-pickle"}`}>
                        {syncTelemetry.offlineJournalCount}
                      </span>
                    </div>
                    <button
                      onClick={handleFlushOfflineJournal}
                      disabled={isRefreshing || syncTelemetry.offlineJournalCount === 0}
                      className="px-4 py-2 bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle disabled:opacity-40 transition-colors text-xs font-bold uppercase tracking-wider whitespace-nowrap cursor-pointer flex items-center gap-1.5"
                    >
                      <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
                      <span>Replay To Cloud Now</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Section 4: 5 Pillars Anti-Hallucination Architecture Status */}
              <div className="p-5 bg-black/30 border border-border space-y-3">
                <span className="text-xs font-bold uppercase tracking-wider text-sand block font-mono">
                  Anti-Hallucination Safeguards &middot; System Invariants
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs font-mono">
                  <div className="p-3 bg-charcoal border border-border space-y-1">
                    <div className="flex items-center gap-2 text-pickle font-bold">
                      <CheckCircle2 size={13} />
                      <span>1. Station Contract Truth</span>
                    </div>
                    <p className="text-[0.7rem] text-sand/70 leading-normal">
                      Courts exclusively render matches where station.currentMatchId matches. Vacated courts never inherit stale scheduled matches.
                    </p>
                  </div>

                  <div className="p-3 bg-charcoal border border-border space-y-1">
                    <div className="flex items-center gap-2 text-pickle font-bold">
                      <CheckCircle2 size={13} />
                      <span>2. Write-Lock Precedence</span>
                    </div>
                    <p className="text-[0.7rem] text-sand/70 leading-normal">
                      6000ms write echo protection window guards local dispatches from being overwritten by delayed cloud polls.
                    </p>
                  </div>

                  <div className="p-3 bg-charcoal border border-border space-y-1">
                    <div className="flex items-center gap-2 text-pickle font-bold">
                      <CheckCircle2 size={13} />
                      <span>3. Atomic Dispatch Sequencing</span>
                    </div>
                    <p className="text-[0.7rem] text-sand/70 leading-normal">
                      Match row is persisted to DB before station alert broadcast, preventing umpires from receiving alerts for non-existent matches.
                    </p>
                  </div>

                  <div className="p-3 bg-charcoal border border-border space-y-1">
                    <div className="flex items-center gap-2 text-pickle font-bold">
                      <CheckCircle2 size={13} />
                      <span>4. Offline Journal &amp; Wake Sync</span>
                    </div>
                    <p className="text-[0.7rem] text-sand/70 leading-normal">
                      Point events are buffered in localStorage when offline and flushed immediately upon tab visibility change or online reconnect.
                    </p>
                  </div>

                  <div className="p-3 bg-charcoal border border-border space-y-1">
                    <div className="flex items-center gap-2 text-pickle font-bold">
                      <CheckCircle2 size={13} />
                      <span>5. Cloud Master Fallback</span>
                    </div>
                    <p className="text-[0.7rem] text-sand/70 leading-normal">
                      One-click recovery purges all local browser storage drift and re-hydrates true state directly from Supabase.
                    </p>
                  </div>

                  <div className="p-3 bg-charcoal border border-border space-y-1">
                    <div className="flex items-center gap-2 text-pickle font-bold">
                      <CheckCircle2 size={13} />
                      <span>In-Flight Save Queue</span>
                    </div>
                    <p className="text-[0.7rem] text-sand/70 leading-normal">
                      Rapid point clicks during network transit are batched into a pending queue rather than dropped or overwritten.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Realtime Socket & Schedulers */}
          {activeTab === "realtime" && (
            <div className="space-y-4">
              <div className="text-xs text-sand/80 font-medium">
                Live metrics from the multiplexed Supabase Realtime channel and in-flight queue buffers.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 bg-black/40 border border-border space-y-1">
                  <span className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 block font-mono">
                    Supabase Shared Channel
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
                    <span className="text-sm font-bold text-sand font-mono">dink-valley-live-pubsub</span>
                  </div>
                  <span className="text-xs text-pickle font-medium">Channel Active &amp; Subscribed</span>
                </div>

                <div className="p-4 bg-black/40 border border-border space-y-1">
                  <span className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 block font-mono">
                    Multiplexed Active Subscribers
                  </span>
                  <span className="text-2xl font-bold font-mono text-sand">
                    {syncTelemetry.activeSubscribers}
                  </span>
                  <span className="text-[0.65rem] text-sand/70 block">
                    Components receiving debounced broadcasts (120ms window)
                  </span>
                </div>

                <div className="p-4 bg-black/40 border border-border space-y-1">
                  <span className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 block font-mono">
                    In-Flight Match Saves Queue
                  </span>
                  <div className="flex items-center gap-3 font-mono">
                    <span className="text-2xl font-bold text-sand">
                      {syncTelemetry.inFlightMatchSavesCount}
                    </span>
                    <span className="text-xs text-sand/70">
                      ({syncTelemetry.pendingMatchSavesCount} pending next)
                    </span>
                  </div>
                  <span className="text-[0.65rem] text-sand/70 block">
                    Prevents point-click drops during network transit
                  </span>
                </div>

                <div className="p-4 bg-black/40 border border-border space-y-1">
                  <span className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 block font-mono">
                    Offline Score Journal
                  </span>
                  <div className="flex items-center gap-3 font-mono">
                    <span className="text-2xl font-bold text-sand">
                      {syncTelemetry.offlineJournalCount}
                    </span>
                    {syncTelemetry.offlineJournalCount > 0 ? (
                      <span className="text-xs text-amber-300 font-bold">
                        Pending Replay
                      </span>
                    ) : (
                      <span className="text-xs text-pickle font-medium">
                        Clean (0 queued)
                      </span>
                    )}
                  </div>
                  <span className="text-[0.65rem] text-sand/70 block">
                    Buffered in localStorage when offline; auto-replayed on reconnect
                  </span>
                </div>
              </div>

              {/* Local Write Protection Timers */}
              <div className="p-4 bg-black/40 border border-border space-y-3">
                <span className="text-xs font-bold uppercase tracking-wider text-sand block font-mono">
                  Local Write Echo Protection Window (6000ms threshold)
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  {FACILITY_COURTS.map((court) => {
                    const elapsed = Date.now() - getStationLocalWriteAt(court);
                    const isProtected = elapsed < 6000;
                    return (
                      <div key={court} className="p-2.5 bg-charcoal border border-white/5 space-y-1">
                        <span className="text-sand/70 font-bold block">{court}</span>
                        <div className="text-[0.7rem]">
                          {isProtected ? (
                            <span className="text-blue-400 font-bold">
                              Protected ({Math.round((6000 - elapsed) / 1000)}s left)
                            </span>
                          ) : (
                            <span className="text-sand/50">Unlocked ({Math.round(elapsed / 1000)}s ago)</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: Raw Cloud DB Inspector */}
          {activeTab === "raw_json" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-sand/80 font-medium">
                  Direct raw query from Supabase <code className="bg-charcoal px-1.5 py-0.5 border border-border text-pickle font-mono">court_stations</code> table.
                </span>
                <span className="text-xs font-mono text-sand/60">
                  {rawCloudRows.length} rows returned
                </span>
              </div>

              <div className="bg-black/60 p-4 border border-border text-xs font-mono text-sand overflow-x-auto max-h-[50vh]">
                <pre>{JSON.stringify(rawCloudRows, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-4 sm:px-6 py-3 border-t border-border bg-charcoal/90 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs font-mono text-sand/60">
          <div>
            Auto-polling every 5 seconds &middot; Ready for pinpoint diagnostic inspection.
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-sand text-charcoal font-bold uppercase tracking-wider hover:opacity-90 transition-opacity self-end sm:self-auto cursor-pointer"
          >
            Close Station
          </button>
        </div>
      </div>
    </div>
  );
}
