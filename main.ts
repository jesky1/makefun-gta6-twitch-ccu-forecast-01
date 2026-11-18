// gta6-twitch-ccu-forecast-01 entry: a comparable-launch forecaster for the Twitch viewer
// count of Grand Theft Auto VI, hour by hour over its release day (2026-11-19, UTC).
//
// The idea: the case file itself ships the release-day curves of dozens of past big
// launches (its `comparables`). A launch day, divided by its own first hour, has a
// recognisable shape — a sag in the small hours while later time zones are still locked,
// a step up when the US unlocks, a quiet morning, then a long climb into the evening —
// but the size of the climb depends on how the rollout stood at the checkpoint. So this
// program rebuilds that shape at run time from the launches most like the case at hand:
//
//   1. Pool: comparables whose release day is complete enough to read, keeping only the
//      ones whose first hour already held between 5% and 85% of their day's peak. Below
//      5% the game had not really unlocked yet (a single global unlock hour later in the
//      day makes the ratios explode); above 85% nothing was left to unlock, so the day
//      can only sag. Launches whose unlock note describes a rolling local-midnight
//      release — GTA VI's own pattern, and every practice launch's — are preferred when
//      at least eight of them survive the share filter.
//   2. Similarity: one number is read off the hours before the checkpoint, the log of
//      (the busiest of the 8 hours before the day began) / (hour 1's count). It says how
//      much of the pre-midnight audience hour 1 kept, and it separates launches that
//      were still gathering (a low hour 1 against a busy evening before it) from ones
//      that had already crested. Pool members are weighted by a Laplace kernel on that
//      number, exp(-3 x |a_member - a_case|).
//   3. Forecast: for each hour, the five scored quantiles are the weighted quantiles of
//      the pool's log-ratios ln(viewers_h / viewers_1) at that hour, with the spread
//      around the median scaled by 0.9 (the raw cross-launch spread is a touch wide:
//      part of it is unlock-hour jitter between countries, which the kernel has already
//      partly explained). Quantile = hour 1's count x exp(quantile of log-ratio).
//
// Tuned and checked by leave-one-out over the kit's launches: on the four practice cases
// this scores a mean pinball loss of about 0.20 against the house baseline's 0.387, and
// about 0.29 in leave-one-out over the comparable launches of the same midnight-rolling
// class. The program is deterministic, standard library only, no network: everything it
// knows is in the case file it is given.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantiles at those levels; only the fallback forecast uses them. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** A pool launch's hour 1 must hold at least this share of its own day's peak... */
const MIN_SHARE = 0.05;
/** ...and at most this share, or its day had nothing left to unlock. */
const MAX_SHARE = 0.85;
/** The midnight-rolling subset is used on its own only when at least this many remain. */
const MIN_POOL = 8;
/** Laplace kernel strength on the pre-midnight feature, per unit of log distance. */
const KERNEL_W = 3;
/** The cross-launch spread around the median is scaled by this before it is written. */
const SPREAD = 0.9;
/** A comparable's release day needs at least this many of its 24 hours to be usable. */
const MIN_DAY_HOURS = 20;
/** Milliseconds in an hour, for turning timestamps into hour indices. */
const HOUR_MS = 3600e3;

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: HourlyPoint[];
}

interface Case {
  levels: number[];
  day_start: string;
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly: HourlyPoint[];
  comparables: Comparable[];
}

/** One comparable's release day, digested: hour (1..24) -> viewers, plus derived facts. */
interface LaunchDay {
  byHour: Map<number, number>;
  first: number;
  share: number;
  feature: number;
  midnight: boolean;
}

/** x rounded to 2 decimals (half up), the same rounding the house baseline writes. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * The pre-midnight feature: ln(busiest of the 8 hours before the day began / hour 1).
 * `points` is any hourly series covering the window (a comparable's own curve, or the
 * case's history_hourly); points at or after the day's start do not count, and hour 1
 * itself never counts — the feature must be computable at the checkpoint, so it reads
 * only what was already true when the day began, set against the hour-1 count.
 */
function preMidnightFeature(points: HourlyPoint[], dayStartMs: number, first: number): number {
  let busiest = 0;
  for (const pt of points) {
    const t = Date.parse(pt.from);
    if (t >= dayStartMs - 8 * HOUR_MS && t < dayStartMs && pt.viewers > busiest) busiest = pt.viewers;
  }
  return Math.log(Math.max(busiest, 1) / Math.max(first, 1));
}

/** A comparable's release day digested, or null when the day is too thin to learn from. */
function digestComparable(comp: Comparable): LaunchDay | null {
  const t0 = Date.parse(comp.day_start);
  const byHour = new Map<number, number>();
  for (const pt of comp.hourly) {
    const h = Math.round((Date.parse(pt.from) - t0) / HOUR_MS) + 1;
    if (h >= 1 && h <= 24 && pt.viewers > 0) byHour.set(h, pt.viewers);
  }
  const first = byHour.get(1);
  if (first === undefined || byHour.size < MIN_DAY_HOURS) return null;
  let peak = 0;
  for (const v of byHour.values()) if (v > peak) peak = v;
  return {
    byHour,
    first,
    share: first / peak,
    feature: preMidnightFeature(comp.hourly, t0, first),
    midnight: /midnight/i.test(comp.unlock ?? ''),
  };
}

/**
 * The weighted q-quantile of [value, weight] pairs sorted by value: each pair sits at
 * the midpoint of its own slice of the total weight, and the quantile is read off by
 * linear interpolation between neighbouring midpoints (clamped at the ends). With all
 * weights equal this is the usual interpolated sample quantile.
 */
function weightedQuantile(sorted: Array<[number, number]>, q: number): number {
  let total = 0;
  for (const [, w] of sorted) total += w;
  let acc = 0;
  let prevPos = 0;
  let prevVal = (sorted[0] as [number, number])[0];
  for (const [v, w] of sorted) {
    const pos = (acc + w / 2) / total;
    if (q <= pos) {
      if (pos === prevPos) return v;
      return prevVal + (v - prevVal) * ((q - prevPos) / (pos - prevPos));
    }
    acc += w;
    prevPos = pos;
    prevVal = v;
  }
  return prevVal;
}

/**
 * The fallback forecast of one hour, the house baseline's shape: hour 1's count with a
 * log spread widening like sqrt(hours ahead). Used only when a case gives no usable
 * pool at all, or for a single hour no pool member recorded.
 */
function fallbackQuantiles(first: number, h: number): number[] {
  return Z.map((z) => round2(first * Math.exp(z * 0.15 * Math.sqrt(h - 1))));
}

/** The forecast of one case: 23 rows, one per hour the case asks for. */
function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const firstRow = c.known.find((k) => k.hour === 1);
  if (firstRow === undefined) throw new Error('case has no hour-1 print');
  const first = Math.max(1, firstRow.viewers);
  const dayStartMs = Date.parse(c.day_start);
  // A case short on history or comparables must degrade to the fallback forecast,
  // never crash: a crashed run is an invalid case, the worst outcome on the board.
  const caseFeature = preMidnightFeature(c.history_hourly ?? [], dayStartMs, first);

  // The pool: digested comparables inside the share band, narrowed to the rolling
  // local-midnight releases when that subset is big enough to stand on its own.
  const digested: LaunchDay[] = [];
  for (const comp of c.comparables ?? []) {
    const d = digestComparable(comp);
    if (d !== null && d.share >= MIN_SHARE && d.share <= MAX_SHARE) digested.push(d);
  }
  const midnightPool = digested.filter((d) => d.midnight);
  const pool = midnightPool.length >= MIN_POOL ? midnightPool : digested;

  const rows: Array<{ hour: number; q: number[] }> = [];
  for (const { hour } of c.forecast) {
    if (pool.length === 0) {
      rows.push({ hour, q: fallbackQuantiles(first, hour) });
      continue;
    }
    // This hour's evidence: each pool member's log-ratio to its own hour 1, weighted
    // by how closely its pre-midnight feature matches the case's.
    const pairs: Array<[number, number]> = [];
    for (const d of pool) {
      const v = d.byHour.get(hour);
      if (v === undefined) continue;
      const w = Math.exp(-KERNEL_W * Math.abs(d.feature - caseFeature));
      pairs.push([Math.log(v / d.first), w]);
    }
    if (pairs.length === 0) {
      rows.push({ hour, q: fallbackQuantiles(first, hour) });
      continue;
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const raw = LEVELS.map((tau) => weightedQuantile(pairs, tau));
    const med = (raw[2] as number);
    const q = raw.map((v) => {
      const lr = med + (v - med) * SPREAD;
      return Math.min(1e9, Math.max(0.01, round2(first * Math.exp(lr))));
    });
    // Quantiles must be non-decreasing in every row; the construction already orders
    // them, but rounding to 2 decimals is only trusted once the row is swept.
    for (let j = 1; j < q.length; j++) {
      if ((q[j] as number) < (q[j - 1] as number)) q[j] = q[j - 1] as number;
    }
    rows.push({ hour, q });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
