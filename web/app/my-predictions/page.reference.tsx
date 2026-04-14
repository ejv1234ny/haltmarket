"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase-client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

// ============================================================================
// TYPES
// ============================================================================

interface Prediction {
  id: string;
  halt_id: string;
  symbol: string;
  halt_price: number;
  predicted_price: number;
  direction_prediction: string | null;
  actual_reopen_price: number | null;
  was_direction_correct: boolean | null;
  was_exact_match: boolean | null;
  elo_before: number | null;
  elo_after: number | null;
  elo_change: number | null;
  resolved_at: string | null;
  created_at: string;
}

interface LeaderboardStats {
  total_predictions: number;
  correct_directions: number;
  direction_accuracy: number;
  current_streak: number;
  best_streak: number;
  avg_price_error: number | null;
  best_price_error: number | null;
  elo_rating: number | null;
  elo_peak: number | null;
  elo_games_played: number | null;
}

interface EloHistoryEntry {
  elo_after: number;
  elo_change: number;
  was_correct: boolean;
  went_against_crowd: boolean;
  symbol: string;
  created_at: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function computePredictedDirection(p: Prediction): "UP" | "DOWN" | "FLAT" {
  const predicted = Number(p.predicted_price);
  const halt = Number(p.halt_price);
  if (!Number.isFinite(predicted) || !Number.isFinite(halt) || halt === 0) return "FLAT";
  const diff = predicted - halt;
  if (Math.abs(diff) / halt < 0.001) return "FLAT";
  return diff > 0 ? "UP" : "DOWN";
}

function eloTier(elo: number): { name: string; color: string } {
  if (elo >= 1200) return { name: "Expert", color: "text-cyan-400" };
  if (elo >= 1000) return { name: "Pro", color: "text-emerald-400" };
  return { name: "Rookie", color: "text-slate-400" };
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export default function MyPredictionsPage() {
  const [user, setUser] = useState<{ id: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [stats, setStats] = useState<LeaderboardStats | null>(null);
  const [eloHistory, setEloHistory] = useState<EloHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) {
        setUser({ id: data.user.id });
      }
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) return;

    const supabase = createClient();

    supabase
      .from("user_predictions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) setPredictions(data as Prediction[]);
        setLoading(false);
      });

    supabase
      .from("prediction_leaderboard")
      .select("*")
      .eq("user_id", user.id)
      .single()
      .then(({ data }) => {
        if (data) setStats(data as LeaderboardStats);
      });

    supabase
      .from("elo_history")
      .select("elo_after, elo_change, was_correct, went_against_crowd, symbol, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) setEloHistory(data.reverse() as EloHistoryEntry[]);
      });
  }, [user]);

  // Derived stats (authoritative: compute from predictions array)
  const totalCalls = predictions.length;
  const scoredCalls = predictions.filter((p) => p.was_direction_correct !== null).length;
  const correctCalls = predictions.filter((p) => p.was_direction_correct === true).length;
  const directionAccuracy = scoredCalls > 0 ? (correctCalls / scoredCalls) * 100 : null;
  const pendingCount = predictions.filter((p) => p.was_direction_correct === null).length;

  let currentStreak = 0;
  for (const p of predictions) {
    if (p.was_direction_correct === null) continue;
    if (p.was_direction_correct === true) currentStreak++;
    else break;
  }
  const resolvedStreak = Math.max(currentStreak, stats?.current_streak ?? 0);
  const bestStreak = stats?.best_streak ?? currentStreak;

  const currentElo =
    eloHistory.length > 0
      ? eloHistory[eloHistory.length - 1].elo_after
      : stats?.elo_rating ?? 1000;
  const peakElo = stats?.elo_peak ?? currentElo;
  const tier = eloTier(currentElo);

  const chartData = eloHistory.map((e, i) => ({
    x: i + 1,
    date: formatDate(e.created_at),
    elo: e.elo_after,
  }));

  if (authLoading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8 text-center text-sm font-mono text-white/40">
        Loading...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-20 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-2xl font-bold text-white mb-2">Log in to view your predictions</h2>
        <p className="text-white/40 mb-6">
          Track your accuracy, streaks, and call history.
        </p>
        <Link
          href="/login"
          className="inline-block px-8 py-3 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-black font-bold text-sm tracking-wider font-mono"
        >
          LOG IN
        </Link>
      </div>
    );
  }

  const accuracyColor =
    directionAccuracy == null
      ? "text-cyan-400"
      : directionAccuracy > 50
        ? "text-emerald-400"
        : directionAccuracy < 50
          ? "text-rose-400"
          : "text-white";

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Section 1: Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-1">My Predictions</h1>
        <p className="text-white/50 text-sm">Your call history and performance stats</p>
      </div>

      {/* Section 2: Four stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard label="Total Calls" value={String(totalCalls)} valueColor="text-white" />
        <StatCard
          label="Direction Accuracy"
          value={directionAccuracy == null ? "—" : `${directionAccuracy.toFixed(1)}%`}
          valueColor={accuracyColor}
        />
        <StatCard
          label="Current Streak"
          value={String(resolvedStreak)}
          valueColor={resolvedStreak >= 3 ? "text-amber-400" : "text-white"}
        />
        <StatCard
          label="Best Streak"
          value={String(bestStreak)}
          valueColor="text-cyan-400"
        />
      </div>

      {/* Section 3: Three detail cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* ELO Rating */}
        <div className="bg-white/[0.02] border border-white/10 rounded-lg p-5">
          <div className="text-[10px] font-mono tracking-widest text-white/30 uppercase mb-2">
            ELO Rating
          </div>
          <div className="flex items-baseline gap-3 mb-3">
            <div className="text-4xl font-bold text-white">{currentElo}</div>
            <div className={`text-xs font-mono font-bold px-2 py-1 rounded bg-white/5 ${tier.color}`}>
              {tier.name}
            </div>
          </div>
          {chartData.length >= 2 ? (
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <XAxis dataKey="date" hide />
                  <YAxis hide domain={["dataMin - 5", "dataMax + 5"]} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "rgba(10, 14, 26, 0.95)",
                      border: "1px solid rgba(0, 245, 212, 0.3)",
                      borderRadius: "6px",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: "11px",
                    }}
                    labelStyle={{ color: "rgba(255,255,255,0.5)" }}
                    itemStyle={{ color: "#00f5d4" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="elo"
                    stroke="#00f5d4"
                    strokeWidth={2}
                    dot={{ r: 2, fill: "#00f5d4" }}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-24 flex items-center justify-center text-[11px] font-mono text-white/25">
              Not enough games for chart
            </div>
          )}
          <div className="text-[10px] font-mono text-white/40 mt-2">
            Peak: <span className="text-white/70">{peakElo}</span>
          </div>
        </div>

        {/* Your Rank */}
        <div className="bg-white/[0.02] border border-white/10 rounded-lg p-5">
          <div className="text-[10px] font-mono tracking-widest text-white/30 uppercase mb-3">
            Your Rank
          </div>
          {scoredCalls < 5 ? (
            <>
              <div className="text-sm text-white/70 mb-2">
                {scoredCalls}/5 calls to rank
              </div>
              <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden mb-4">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all"
                  style={{ width: `${Math.min(100, (scoredCalls / 5) * 100)}%` }}
                />
              </div>
              <p className="text-[11px] text-white/40">
                Get scored on 5 predictions to unlock your global rank.
              </p>
            </>
          ) : (
            <>
              <div className="text-xl font-bold text-white mb-1">Ranked</div>
              <p className="text-[11px] text-white/40 mb-4">
                Check the leaderboard for your position.
              </p>
            </>
          )}
          <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/5">
            <div>
              <div className="text-[10px] font-mono tracking-wider text-white/30 uppercase">Current</div>
              <div className="text-2xl font-bold text-amber-400">{resolvedStreak}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono tracking-wider text-white/30 uppercase">Best</div>
              <div className="text-2xl font-bold text-cyan-400">{bestStreak}</div>
            </div>
          </div>
        </div>

        {/* AI vs You */}
        <div className="bg-white/[0.02] border border-white/10 rounded-lg p-5">
          <div className="text-[10px] font-mono tracking-widest text-white/30 uppercase mb-3">
            AI vs You
          </div>
          {scoredCalls === 0 ? (
            <p className="text-sm text-white/40 py-8 text-center">
              Make predictions to see your stats
            </p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-3 text-[10px] font-mono tracking-wider text-white/30 uppercase pb-2 border-b border-white/5">
                <span></span>
                <span className="text-right">You</span>
                <span className="text-right">AI</span>
              </div>
              <VsRow label="30-Day Acc" you={directionAccuracy} ai={54.4} />
              <VsRow label="All-Time" you={directionAccuracy} ai={55.9} />
            </div>
          )}
        </div>
      </div>

      {/* Section 4: Predictions history table */}
      <div className="bg-white/[0.02] border border-white/10 rounded-lg overflow-hidden">
        {loading ? (
          <div className="text-center py-16 text-sm font-mono text-white/40">
            Loading calls...
          </div>
        ) : predictions.length === 0 ? (
          <div className="text-center py-16 px-6">
            <div className="text-4xl mb-3">📊</div>
            <h3 className="text-lg font-bold text-white mb-1">No predictions yet</h3>
            <p className="text-sm text-white/40 mb-5">
              Go to Live Feed to make your first call
            </p>
            <Link
              href="/dashboard"
              className="inline-block px-5 py-2 rounded-md bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-xs font-bold tracking-wider hover:bg-cyan-500/20 transition-colors"
            >
              GO TO LIVE FEED →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-white/10 text-[10px] font-mono tracking-wider text-white/30 uppercase">
                  <th className="text-left font-normal py-3 px-4">Symbol</th>
                  <th className="text-left font-normal py-3 px-2">Halt#</th>
                  <th className="text-left font-normal py-3 px-2">Your Call</th>
                  <th className="text-left font-normal py-3 px-2">Result</th>
                  <th className="text-right font-normal py-3 px-2">Gap%</th>
                  <th className="text-right font-normal py-3 px-2">ELO Δ</th>
                  <th className="text-right font-normal py-3 px-4">Date</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((p) => {
                  const haltNum = p.halt_id?.split("-").pop() || "1";
                  const userDir = computePredictedDirection(p);
                  const isResolved = p.was_direction_correct !== null;
                  const gap =
                    p.actual_reopen_price != null && p.halt_price
                      ? ((Number(p.actual_reopen_price) - Number(p.halt_price)) /
                          Number(p.halt_price)) *
                        100
                      : null;
                  const eloDelta = p.elo_change;

                  const rowBg = !isResolved
                    ? ""
                    : p.was_direction_correct
                      ? "bg-emerald-500/[0.03] hover:bg-emerald-500/[0.07]"
                      : "bg-rose-500/[0.03] hover:bg-rose-500/[0.07]";

                  return (
                    <tr
                      key={p.id}
                      className={`border-b border-white/5 last:border-0 transition-colors ${rowBg} hover:bg-white/5`}
                    >
                      <td className="py-3 px-4">
                        <Link
                          href={`/halt/${p.symbol}`}
                          className="font-mono font-bold text-white hover:text-cyan-400"
                        >
                          {p.symbol}
                        </Link>
                      </td>
                      <td className="py-3 px-2 text-xs font-mono text-white/50">
                        H{haltNum}
                      </td>
                      <td className="py-3 px-2">
                        {userDir === "UP" && (
                          <span className="inline-flex items-center gap-1 text-xs font-mono font-bold text-emerald-400">
                            ↑ UP
                          </span>
                        )}
                        {userDir === "DOWN" && (
                          <span className="inline-flex items-center gap-1 text-xs font-mono font-bold text-rose-400">
                            ↓ DOWN
                          </span>
                        )}
                        {userDir === "FLAT" && (
                          <span className="inline-flex items-center gap-1 text-xs font-mono font-bold text-amber-400">
                            → FLAT
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-2">
                        {p.was_direction_correct === true && (
                          <span className="text-xs font-mono font-bold text-emerald-400">
                            ✅ Correct
                          </span>
                        )}
                        {p.was_direction_correct === false && (
                          <span className="text-xs font-mono font-bold text-rose-400">
                            ❌ Wrong
                          </span>
                        )}
                        {p.was_direction_correct === null && (
                          <span className="text-xs font-mono text-white/30">
                            ⏳ Pending
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono text-xs ${
                          gap == null
                            ? "text-white/25"
                            : gap > 0
                              ? "text-emerald-400"
                              : gap < 0
                                ? "text-rose-400"
                                : "text-white/50"
                        }`}
                      >
                        {gap == null ? "--" : `${gap > 0 ? "+" : ""}${gap.toFixed(1)}%`}
                      </td>
                      <td
                        className={`py-3 px-2 text-right font-mono text-xs font-bold ${
                          eloDelta == null
                            ? "text-white/25"
                            : eloDelta > 0
                              ? "text-emerald-400"
                              : "text-rose-400"
                        }`}
                      >
                        {eloDelta == null ? "--" : `${eloDelta > 0 ? "+" : ""}${eloDelta}`}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs text-white/40">
                        {formatDate(p.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pendingCount > 0 && (
        <div className="mt-4 text-center text-xs font-mono text-white/40">
          {pendingCount} prediction{pendingCount === 1 ? "" : "s"} pending resolution
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function StatCard({
  label,
  value,
  valueColor = "text-white",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-white/[0.02] border border-white/10 rounded-lg p-5 text-center">
      <div className={`text-3xl font-bold leading-none mb-2 ${valueColor}`}>{value}</div>
      <div className="text-[10px] font-mono tracking-widest text-white/30 uppercase">
        {label}
      </div>
    </div>
  );
}

function VsRow({
  label,
  you,
  ai,
}: {
  label: string;
  you: number | null;
  ai: number;
}) {
  const youStr = you == null ? "--" : `${you.toFixed(1)}%`;
  const youColor =
    you == null
      ? "text-white/30"
      : you > ai
        ? "text-emerald-400"
        : you < ai
          ? "text-rose-400"
          : "text-white";
  return (
    <div className="grid grid-cols-3 items-center py-1.5 text-xs font-mono">
      <span className="text-white/50">{label}</span>
      <span className={`text-right font-bold ${youColor}`}>{youStr}</span>
      <span className="text-right text-cyan-400">{ai.toFixed(1)}%</span>
    </div>
  );
}
