// ─────────────────────────────────────────────────────────────────────────────
// Scottish STV tabulation algorithm
// Implements spec Section 7 (Weighted Inclusive Gregory method).
// Supports exact (bigint rational) and order2007 (scaled integer) arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Round, Winner, Transfers, AggregateTransfer, BallotLevelTransfer,
  UnusualOutcome, Rational, StvArithmetic,
} from './types.js';
import type { ResolvedCandidate, ResolvedBallot } from './validate.js';
import type { TieBreakerFn } from './tiebreak.js';
import {
  IR, fromInt, add, sub, mul, div, ZERO, ONE, toRational,
  eq, lt, gte, cmp, sum, floor,
} from './rational.js';

// ---------------------------------------------------------------------------
// STV result type (internal)
// ---------------------------------------------------------------------------

export interface StvResult {
  rounds: Round[];
  winners: Winner[];
}

// ---------------------------------------------------------------------------
// Internal ballot state
// ---------------------------------------------------------------------------

interface BallotState {
  id: string;
  rankings: string[];
  value: IR; // current transfer value
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function tabulateStv(
  candidates: ResolvedCandidate[],
  ballots: ResolvedBallot[],
  seats: number,
  quotaMode: 'static' | 'dynamic',
  arithmetic: StvArithmetic,
  tieBreaker: TieBreakerFn,
  trackBallotTransfers: boolean,
): StvResult {
  const activeCandidates = new Set<string>(candidates.map(c => c.id));
  const elected: string[] = [];
  const eliminated = new Set<string>();

  // Initialize ballot states
  const ballotStates: BallotState[] = ballots.map(b => ({
    id: b.id,
    rankings: b.rankings,
    value: ONE,
  }));
  const exhaustedBallotIds = new Set<string>();

  // For order2007: scale factor is 100000
  const SCALE = 100000n;

  // Init order2007: all values start at SCALE (representing 1 whole vote)
  if (arithmetic === 'order2007') {
    for (const bs of ballotStates) {
      bs.value = fromInt(SCALE);
    }
  }

  const rounds: Round[] = [];
  const allUnusualOutcomes: UnusualOutcome[] = [];

  // Compute static Droop quota once
  const totalBallots = BigInt(ballots.length);
  const seatsBig = BigInt(seats);
  const staticQuota = fromInt(totalBallots / (seatsBig + 1n) + 1n);

  // --- Round loop ---
  while (true) {
    // Count the round
    const { tally, newlyExhausted } = countRound(ballotStates, activeCandidates, exhaustedBallotIds);
    for (const id of newlyExhausted) exhaustedBallotIds.add(id);

    // Compute threshold
    const seatsRemaining = BigInt(seats - elected.length);
    let threshold: IR;
    if (quotaMode === 'static') {
      threshold = arithmetic === 'order2007'
        ? fromInt((totalBallots * SCALE) / (seatsBig + 1n) + 1n)
        : staticQuota;
    } else {
      // Dynamic: based on current active ballot weight
      const activeWeight = sumActiveWeight(ballotStates, exhaustedBallotIds, arithmetic, SCALE);
      threshold = arithmetic === 'order2007'
        ? fromInt(floor(div(activeWeight, fromInt(seatsRemaining + 1n))) + 1n)
        : fromInt(floor(div(activeWeight, fromInt(seatsRemaining + 1n))) + 1n);
    }

    const exhaustedThisRound = fromInt(newlyExhausted.size);
    const exhaustedTotal = fromInt(exhaustedBallotIds.size);

    // --- Step 1: Elect any candidates meeting or exceeding the quota ---
    const electedThisRound: string[] = [];
    for (const id of activeCandidates) {
      const t = tally.get(id) ?? ZERO;
      if (gte(t, threshold)) electedThisRound.push(id);
    }

    // Sort elected-this-round by descending tally (per spec: largest surplus transferred first)
    electedThisRound.sort((a, b) => {
      const ta = tally.get(a) ?? ZERO;
      const tb = tally.get(b) ?? ZERO;
      const c = cmp(tb, ta);
      return c < 0n ? -1 : c > 0n ? 1 : 0;
    });

    // Handle ties among elected-same-round: use tieBreaker on any groups with equal tallies
    const resolvedElectedOrder = resolveSameRoundElectedOrder(electedThisRound, tally, tieBreaker, rounds);

    if (resolvedElectedOrder.length > 0) {
      // Add them to the elected list and remove from active
      for (const id of resolvedElectedOrder) {
        elected.push(id);
        activeCandidates.delete(id);
      }

      const roundUnusual: UnusualOutcome[] = [];

      // Check termination (a): all seats filled
      if (elected.length === seats) {
        rounds.push({
          roundNumber: rounds.length + 1,
          tally: tallyToRecord(tally),
          threshold: toRational(normalizeThreshold(threshold, arithmetic, SCALE)),
          elected: resolvedElectedOrder,
          eliminated: [],
          transfers: { aggregate: [] },
          exhaustedThisRound: toRational(exhaustedThisRound),
          exhaustedTotal: toRational(exhaustedTotal),
        });
        const winners = buildWinners(candidates, elected, rounds, tally);
        return { rounds, winners };
      }

      // Check termination (b): election by remainder
      if (activeCandidates.size + elected.length === seats) {
        const remainder = [...activeCandidates];
        for (const id of remainder) {
          elected.push(id);
          activeCandidates.delete(id);
        }
        const unusual: UnusualOutcome = {
          code: 'ELECTED_BY_REMAINDER',
          description: `Remaining candidate(s) [${remainder.join(', ')}] elected by remainder — not enough remaining candidates to continue elimination.`,
          roundNumber: rounds.length + 1,
        };
        allUnusualOutcomes.push(unusual);
        rounds.push({
          roundNumber: rounds.length + 1,
          tally: tallyToRecord(tally),
          threshold: toRational(normalizeThreshold(threshold, arithmetic, SCALE)),
          elected: [...resolvedElectedOrder, ...remainder],
          eliminated: [],
          transfers: { aggregate: [] },
          exhaustedThisRound: toRational(exhaustedThisRound),
          exhaustedTotal: toRational(exhaustedTotal),
          unusualOutcomes: [unusual],
        });
        const winners = buildWinners(candidates, elected, rounds, tally);
        return { rounds, winners };
      }

      // Transfer the largest surplus (first in resolvedElectedOrder after sort)
      const surplusCandidate = resolvedElectedOrder[0]!;
      const surplusTally = tally.get(surplusCandidate)!;
      const surplus = sub(surplusTally, threshold);

      const { transfers, tieBreakEvent } = transferSurplus(
        surplusCandidate, surplus, surplusTally, threshold,
        ballotStates, activeCandidates, exhaustedBallotIds,
        arithmetic, SCALE, trackBallotTransfers, tieBreaker, rounds,
      );

      const round: Round = {
        roundNumber: rounds.length + 1,
        tally: tallyToRecord(tally),
        threshold: toRational(normalizeThreshold(threshold, arithmetic, SCALE)),
        elected: resolvedElectedOrder,
        eliminated: [],
        transfers,
        exhaustedThisRound: toRational(exhaustedThisRound),
        exhaustedTotal: toRational(exhaustedTotal),
      };
      if (tieBreakEvent) round.tieBreakApplied = tieBreakEvent;
      if (roundUnusual.length > 0) round.unusualOutcomes = roundUnusual;
      rounds.push(round);
      continue; // re-count from top
    }

    // --- Step 3: No one met quota — eliminate the lowest ---
    if (activeCandidates.size === 0) {
      const unusual: UnusualOutcome = {
        code: 'ALL_BALLOTS_EXHAUSTED',
        description: 'All remaining ballots exhausted before all seats could be filled.',
        roundNumber: rounds.length + 1,
      };
      allUnusualOutcomes.push(unusual);
      rounds.push({
        roundNumber: rounds.length + 1,
        tally: tallyToRecord(tally),
        threshold: toRational(normalizeThreshold(threshold, arithmetic, SCALE)),
        elected: [],
        eliminated: [],
        transfers: { aggregate: [] },
        exhaustedThisRound: toRational(exhaustedThisRound),
        exhaustedTotal: toRational(exhaustedTotal),
        unusualOutcomes: [unusual],
      });
      break;
    }

    // Check election by remainder before elimination
    if (activeCandidates.size + elected.length === seats) {
      const remainder = [...activeCandidates];
      for (const id of remainder) {
        elected.push(id);
        activeCandidates.delete(id);
      }
      const unusual: UnusualOutcome = {
        code: 'ELECTED_BY_REMAINDER',
        description: `Remaining candidate(s) [${remainder.join(', ')}] elected by remainder.`,
        roundNumber: rounds.length + 1,
      };
      allUnusualOutcomes.push(unusual);
      rounds.push({
        roundNumber: rounds.length + 1,
        tally: tallyToRecord(tally),
        threshold: toRational(normalizeThreshold(threshold, arithmetic, SCALE)),
        elected: remainder,
        eliminated: [],
        transfers: { aggregate: [] },
        exhaustedThisRound: toRational(exhaustedThisRound),
        exhaustedTotal: toRational(exhaustedTotal),
        unusualOutcomes: [unusual],
      });
      break;
    }

    // Eliminate lowest-voted candidate(s)
    const { toEliminate, tieBreakEvent: elimTieBreak, unusualOutcome: batchUnusual } =
      selectStvEliminations(tally, activeCandidates, tieBreaker, rounds, threshold);

    const { transfers: elimTransfers } = transferEliminated(
      toEliminate, ballotStates, activeCandidates, exhaustedBallotIds,
      trackBallotTransfers,
    );

    for (const id of toEliminate) {
      activeCandidates.delete(id);
      eliminated.add(id);
    }

    const roundUnusual: UnusualOutcome[] = [];
    if (batchUnusual) {
      roundUnusual.push(batchUnusual);
      allUnusualOutcomes.push(batchUnusual);
    }

    const elimRound: Round = {
      roundNumber: rounds.length + 1,
      tally: tallyToRecord(tally),
      threshold: toRational(normalizeThreshold(threshold, arithmetic, SCALE)),
      elected: [],
      eliminated: toEliminate,
      transfers: elimTransfers,
      exhaustedThisRound: toRational(exhaustedThisRound),
      exhaustedTotal: toRational(exhaustedTotal),
    };
    if (elimTieBreak) elimRound.tieBreakApplied = elimTieBreak;
    if (roundUnusual.length > 0) elimRound.unusualOutcomes = roundUnusual;
    rounds.push(elimRound);
  }

  // Build winner list from elected array
  const winners = buildWinners(candidates, elected, rounds, new Map());
  return { rounds, winners };
}

// ---------------------------------------------------------------------------
// Count round (STV: sums ballotValue[b] not just integer counts)
// ---------------------------------------------------------------------------

function countRound(
  ballotStates: BallotState[],
  activeCandidates: Set<string>,
  exhaustedBallotIds: Set<string>,
): { tally: Map<string, IR>; newlyExhausted: Set<string> } {
  const tally = new Map<string, IR>();
  for (const id of activeCandidates) tally.set(id, ZERO);

  const newlyExhausted = new Set<string>();
  for (const bs of ballotStates) {
    if (exhaustedBallotIds.has(bs.id)) continue;

    let found = false;
    for (const id of bs.rankings) {
      if (activeCandidates.has(id)) {
        tally.set(id, add(tally.get(id)!, bs.value));
        found = true;
        break;
      }
    }
    if (!found) newlyExhausted.add(bs.id);
  }

  return { tally, newlyExhausted };
}

// ---------------------------------------------------------------------------
// Surplus transfer (Weighted Inclusive Gregory)
// ---------------------------------------------------------------------------

function transferSurplus(
  candidateId: string,
  surplus: IR,
  candidateTotalTally: IR,
  _threshold: IR,
  ballotStates: BallotState[],
  activeCandidates: Set<string>, // already has candidateId removed
  exhaustedBallotIds: Set<string>,
  arithmetic: StvArithmetic,
  _SCALE: bigint,
  trackBallotTransfers: boolean,
  _tieBreaker: TieBreakerFn,
  _priorRounds: Round[],
): { transfers: Transfers; tieBreakEvent?: Round['tieBreakApplied'] } {
  // The ratio to apply to each ballot currently on this candidate
  // newValue = oldValue × (surplus / candidateTotalTally)
  // For order2007: scaled integer math

  const aggregate = new Map<string, { from: string; to: string | null; weight: IR; count: number }>();
  const ballotLevel: BallotLevelTransfer[] = [];

  for (const bs of ballotStates) {
    if (exhaustedBallotIds.has(bs.id)) continue;

    // Is this ballot currently sitting on the elected candidate?
    const topPref = bs.rankings.find(id => id === candidateId || activeCandidates.has(id));
    if (topPref !== candidateId) continue;

    // Find next active preference
    let nextPref: string | null = null;
    for (const id of bs.rankings) {
      if (activeCandidates.has(id)) {
        nextPref = id;
        break;
      }
    }

    const oldValue = bs.value;

    // Compute new value
    let newValue: IR;
    if (arithmetic === 'order2007') {
      // order2007: floor((oldScaled × surplusScaled) / candidateTotalScaled)
      // Values are already in SCALE units
      const surplusScaled = surplus.n; // surplus.d should be 1n
      const totalScaled = candidateTotalTally.n;
      const newScaled = (oldValue.n * surplusScaled) / totalScaled; // bigint floor division
      newValue = fromInt(newScaled);
    } else {
      // exact: multiply by surplus/candidateTotalTally
      newValue = mul(oldValue, div(surplus, candidateTotalTally));
    }

    bs.value = newValue;
    // After transfer, this ballot's top preference moves to nextPref
    // (candidateId is no longer in activeCandidates so it will skip it naturally in next count)

    if (nextPref === null) exhaustedBallotIds.add(bs.id);

    const key = `${candidateId}→${nextPref ?? 'null'}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.count++;
      existing.weight = add(existing.weight, newValue);
    } else {
      aggregate.set(key, { from: candidateId, to: nextPref, weight: newValue, count: 1 });
    }

    if (trackBallotTransfers) {
      ballotLevel.push({
        ballotId: bs.id,
        fromCandidateId: candidateId,
        toCandidateId: nextPref,
        weight: toRational(newValue),
      });
    }
  }

  const aggregateArr: AggregateTransfer[] = [...aggregate.values()].map(e => ({
    fromCandidateId: e.from,
    toCandidateId: e.to,
    weight: toRational(e.weight),
    ballotCount: e.count,
  }));

  return {
    transfers: {
      aggregate: aggregateArr,
      ...(trackBallotTransfers ? { ballotLevel } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Eliminated candidate transfer (at current ballot value, unmodified)
// ---------------------------------------------------------------------------

function transferEliminated(
  eliminatedIds: string[],
  ballotStates: BallotState[],
  activeCandidates: Set<string>, // already has eliminatedIds removed
  exhaustedBallotIds: Set<string>,
  trackBallotTransfers: boolean,
): { transfers: Transfers } {
  const eliminatedSet = new Set(eliminatedIds);
  // activeCandidates already has eliminated removed
  const aggregate = new Map<string, { from: string; to: string | null; weight: IR; count: number }>();
  const ballotLevel: BallotLevelTransfer[] = [];

  for (const bs of ballotStates) {
    if (exhaustedBallotIds.has(bs.id)) continue;

    // Find what the ballot's current preference was (may be one of the eliminated)
    const topPref = bs.rankings.find(id => eliminatedSet.has(id) || activeCandidates.has(id));
    if (!topPref || !eliminatedSet.has(topPref)) continue;

    // Find next preference from still-active set
    let nextPref: string | null = null;
    for (const id of bs.rankings) {
      if (activeCandidates.has(id)) {
        nextPref = id;
        break;
      }
    }

    if (nextPref === null) exhaustedBallotIds.add(bs.id);

    const key = `${topPref}→${nextPref ?? 'null'}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.count++;
      existing.weight = add(existing.weight, bs.value);
    } else {
      aggregate.set(key, { from: topPref, to: nextPref, weight: bs.value, count: 1 });
    }

    if (trackBallotTransfers) {
      ballotLevel.push({
        ballotId: bs.id,
        fromCandidateId: topPref,
        toCandidateId: nextPref,
        weight: toRational(bs.value),
      });
    }
  }

  const aggregateArr: AggregateTransfer[] = [...aggregate.values()].map(e => ({
    fromCandidateId: e.from,
    toCandidateId: e.to,
    weight: toRational(e.weight),
    ballotCount: e.count,
  }));

  return {
    transfers: {
      aggregate: aggregateArr,
      ...(trackBallotTransfers ? { ballotLevel } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Select elimination candidates for STV (same as IRV batch logic, stricter)
// ---------------------------------------------------------------------------

function selectStvEliminations(
  tally: Map<string, IR>,
  activeCandidates: Set<string>,
  tieBreaker: TieBreakerFn,
  priorRounds: Round[],
  smallestSurplus: IR | null,
): {
  toEliminate: string[];
  tieBreakEvent?: Round['tieBreakApplied'];
  unusualOutcome?: UnusualOutcome;
} {
  const sorted = [...activeCandidates]
    .map(id => ({ id, tally: tally.get(id) ?? ZERO }))
    .sort((a, b) => {
      const c = cmp(a.tally, b.tally);
      return c < 0n ? -1 : c > 0n ? 1 : 0;
    });

  // STV batch: both conditions must hold
  // 1. sum(prefix) < min(rest)
  // 2. sum(prefix) < smallestSurplus OR no pending surpluses
  let batchSize = 1;
  for (let prefixLen = 2; prefixLen < sorted.length; prefixLen++) {
    const prefixSum = sum(sorted.slice(0, prefixLen).map(x => x.tally));
    const restMin = sorted[prefixLen]!.tally;
    const cond1 = lt(prefixSum, restMin);
    const cond2 = smallestSurplus === null || lt(prefixSum, smallestSurplus);
    if (cond1 && cond2) {
      batchSize = prefixLen;
    } else {
      break;
    }
  }

  if (batchSize > 1) {
    const toEliminate = sorted.slice(0, batchSize).map(x => x.id);
    const unusual: UnusualOutcome = {
      code: 'BATCH_ELIMINATION_APPLIED',
      description: `STV batch elimination: candidates [${toEliminate.join(', ')}] eliminated together.`,
      roundNumber: priorRounds.length + 1,
    };
    return { toEliminate, unusualOutcome: unusual };
  }

  // Single or tie-break
  const minTally = sorted[0]!.tally;
  const tied = sorted.filter(x => eq(x.tally, minTally)).map(x => x.id);

  if (tied.length === 1) return { toEliminate: [tied[0]!] };

  const { selected, event } = tieBreaker(tied, priorRounds, 'STV elimination tie');
  return { toEliminate: [selected], tieBreakEvent: event };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumActiveWeight(
  ballotStates: BallotState[],
  exhaustedBallotIds: Set<string>,
  _arithmetic: StvArithmetic,
  _SCALE: bigint,
): IR {
  let total = ZERO;
  for (const bs of ballotStates) {
    if (!exhaustedBallotIds.has(bs.id)) {
      total = add(total, bs.value);
    }
  }
  return total;
}

function normalizeThreshold(threshold: IR, arithmetic: StvArithmetic, SCALE: bigint): IR {
  if (arithmetic === 'order2007') {
    // Convert scaled threshold back to a rational for display
    return div(threshold, fromInt(SCALE));
  }
  return threshold;
}

function tallyToRecord(tally: Map<string, IR>): Record<string, Rational> {
  const rec: Record<string, Rational> = {};
  for (const [id, t] of tally) rec[id] = toRational(t);
  return rec;
}

function resolveSameRoundElectedOrder(
  electedIds: string[],
  tally: Map<string, IR>,
  tieBreaker: TieBreakerFn,
  priorRounds: Round[],
): string[] {
  // Already sorted by descending tally; handle equal-tally groups via tieBreaker
  if (electedIds.length <= 1) return electedIds;

  // Group into equal-tally runs and resolve ties within each group
  const result: string[] = [];
  let i = 0;
  while (i < electedIds.length) {
    const curTally = tally.get(electedIds[i]!)!;
    let j = i + 1;
    while (j < electedIds.length && eq(tally.get(electedIds[j]!)!, curTally)) j++;
    const group = electedIds.slice(i, j);
    if (group.length === 1) {
      result.push(group[0]!);
    } else {
      // Tie: use tieBreaker for ordering (the spec says break ties using tieBreak)
      const { selected } = tieBreaker(group, priorRounds, 'STV same-round election order tie');
      result.push(selected);
      // Put the rest at the end (order of surplus transfer)
      const rest = group.filter(id => id !== selected);
      result.push(...rest);
    }
    i = j;
  }
  return result;
}

function buildWinners(
  candidates: ResolvedCandidate[],
  electedIds: string[],
  rounds: Round[],
  finalTally: Map<string, IR>,
): Winner[] {
  const candidateMap = new Map(candidates.map(c => [c.id, c]));

  return electedIds.map((id) => {
    const c = candidateMap.get(id);
    // Find the round in which this candidate was elected
    let electedInRound = rounds.length;
    for (const r of rounds) {
      if (r.elected.includes(id)) {
        electedInRound = r.roundNumber;
        break;
      }
    }
    const tally = finalTally.get(id);
    return {
      candidateId: id,
      candidateName: c?.name ?? id,
      isWriteIn: c?.isWriteIn ?? false,
      electedInRound,
      finalTally: tally ? toRational(tally) : { numerator: '0', denominator: '1' },
    };
  });
}
