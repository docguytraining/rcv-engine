// ─────────────────────────────────────────────────────────────────────────────
// IRV (Instant Runoff Voting) tabulation algorithm
// Implements spec Section 6 exactly.
// Single-winner only (seats === 1).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Round, Winner, AggregateTransfer, BallotLevelTransfer,
  UnusualOutcome, Rational,
} from './types.js';
import type { ResolvedCandidate, ResolvedBallot } from './validate.js';
import type { TieBreakerFn } from './tiebreak.js';
import {
  IR, fromInt, add, ZERO, ONE, toRational, eq, lt, gt, gte, cmp, sum,
} from './rational.js';

// ---------------------------------------------------------------------------
// IRV result type (internal)
// ---------------------------------------------------------------------------

export interface IrvResult {
  rounds: Round[];
  winners: Winner[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function tabulateIrv(
  candidates: ResolvedCandidate[],
  ballots: ResolvedBallot[],
  quotaMode: 'static' | 'dynamic',
  tieBreaker: TieBreakerFn,
  trackBallotTransfers: boolean,
): IrvResult {
  // State
  const activeCandidates = new Set<string>(candidates.map(c => c.id));
  const exhaustedBallotIds = new Set<string>();
  const rounds: Round[] = [];
  const winners: Winner[] = [];
  const allUnusualOutcomes: UnusualOutcome[] = [];

  // Compute static threshold once from initial ballot count
  const initialBallotCount = BigInt(ballots.length);
  const staticThreshold = fromInt(initialBallotCount / 2n + 1n);

  // --- Round loop ---
  while (true) {
    const { tally, newlyExhausted } = countRound(ballots, activeCandidates, exhaustedBallotIds);
    for (const id of newlyExhausted) exhaustedBallotIds.add(id);

    // Compute threshold for this round
    const activeBallotCount = BigInt(ballots.length - exhaustedBallotIds.size);
    const threshold = quotaMode === 'static'
      ? staticThreshold
      : fromInt(activeBallotCount / 2n + 1n);

    const exhaustedThisRound = fromInt(newlyExhausted.size);
    const exhaustedTotal = fromInt(exhaustedBallotIds.size);

    // Find max-voted candidate
    let maxCandidate: string | null = null;
    let maxTally: IR = ZERO;
    for (const [id, t] of tally) {
      if (maxCandidate === null || gt(t, maxTally)) {
        maxTally = t;
        maxCandidate = id;
      }
    }

    // --- Termination condition (a): a candidate reached the threshold ---
    if (maxCandidate !== null && gte(maxTally, threshold)) {
      rounds.push({
        roundNumber: rounds.length + 1,
        tally: tallyToRecord(tally),
        threshold: toRational(threshold),
        elected: [maxCandidate],
        eliminated: [],
        transfers: { aggregate: [] },
        exhaustedThisRound: toRational(exhaustedThisRound),
        exhaustedTotal: toRational(exhaustedTotal),
      });
      winners.push({
        candidateId: maxCandidate,
        candidateName: candidates.find(c => c.id === maxCandidate)?.name ?? maxCandidate,
        isWriteIn: candidates.find(c => c.id === maxCandidate)?.isWriteIn ?? false,
        electedInRound: rounds.length,
        finalTally: toRational(maxTally),
      });
      break;
    }

    // --- Termination condition (b): only one active candidate remains ---
    if (activeCandidates.size === 1) {
      const lastCandidate = [...activeCandidates][0]!;
      const lastTally = tally.get(lastCandidate) ?? ZERO;
      const unusual: UnusualOutcome = {
        code: 'WINNER_WITHOUT_MAJORITY',
        description: `Candidate "${lastCandidate}" won by default as the last remaining active candidate without reaching the majority threshold.`,
        roundNumber: rounds.length + 1,
      };
      allUnusualOutcomes.push(unusual);
      rounds.push({
        roundNumber: rounds.length + 1,
        tally: tallyToRecord(tally),
        threshold: toRational(threshold),
        elected: [lastCandidate],
        eliminated: [],
        transfers: { aggregate: [] },
        exhaustedThisRound: toRational(exhaustedThisRound),
        exhaustedTotal: toRational(exhaustedTotal),
        unusualOutcomes: [unusual],
      });
      winners.push({
        candidateId: lastCandidate,
        candidateName: candidates.find(c => c.id === lastCandidate)?.name ?? lastCandidate,
        isWriteIn: candidates.find(c => c.id === lastCandidate)?.isWriteIn ?? false,
        electedInRound: rounds.length,
        finalTally: toRational(lastTally),
      });
      break;
    }

    // --- Termination condition (c): no active candidates remain ---
    if (activeCandidates.size === 0) {
      const unusual: UnusualOutcome = {
        code: 'ALL_BALLOTS_EXHAUSTED',
        description: 'All ballots exhausted before a winner could be determined.',
        roundNumber: rounds.length + 1,
      };
      allUnusualOutcomes.push(unusual);
      rounds.push({
        roundNumber: rounds.length + 1,
        tally: tallyToRecord(tally),
        threshold: toRational(threshold),
        elected: [],
        eliminated: [],
        transfers: { aggregate: [] },
        exhaustedThisRound: toRational(exhaustedThisRound),
        exhaustedTotal: toRational(exhaustedTotal),
        unusualOutcomes: [unusual],
      });
      break;
    }

    // --- Normal elimination round ---
    // Select candidates to eliminate
    const { toEliminate, tieBreakEvent, unusualOutcome: batchUnusual } =
      selectEliminations(tally, activeCandidates, tieBreaker, rounds);

    // Compute transfers before removing from active set
    const { aggregate, ballotLevel } = computeTransfers(
      ballots,
      toEliminate,
      activeCandidates,
      exhaustedBallotIds,
      trackBallotTransfers,
    );

    // Remove eliminated candidates
    for (const id of toEliminate) activeCandidates.delete(id);

    const roundUnusual: UnusualOutcome[] = [];
    if (batchUnusual) {
      roundUnusual.push(batchUnusual);
      allUnusualOutcomes.push(batchUnusual);
    }

    const round: Round = {
      roundNumber: rounds.length + 1,
      tally: tallyToRecord(tally),
      threshold: toRational(threshold),
      elected: [],
      eliminated: toEliminate,
      transfers: {
        aggregate,
        ...(trackBallotTransfers ? { ballotLevel } : {}),
      },
      exhaustedThisRound: toRational(exhaustedThisRound),
      exhaustedTotal: toRational(exhaustedTotal),
    };
    if (tieBreakEvent) round.tieBreakApplied = tieBreakEvent;
    if (roundUnusual.length > 0) round.unusualOutcomes = roundUnusual;
    rounds.push(round);
  }

  return { rounds, winners };
}

// ---------------------------------------------------------------------------
// Count round: compute tally and newly exhausted ballots
// ---------------------------------------------------------------------------

function countRound(
  ballots: ResolvedBallot[],
  activeCandidates: Set<string>,
  exhaustedBallotIds: Set<string>,
): { tally: Map<string, IR>; newlyExhausted: Set<string> } {
  const tally = new Map<string, IR>();
  for (const id of activeCandidates) tally.set(id, ZERO);

  const newlyExhausted = new Set<string>();

  for (const ballot of ballots) {
    if (exhaustedBallotIds.has(ballot.id)) continue;

    let voted = false;
    for (const candidateId of ballot.rankings) {
      if (activeCandidates.has(candidateId)) {
        tally.set(candidateId, add(tally.get(candidateId)!, ONE));
        voted = true;
        break;
      }
    }
    if (!voted) newlyExhausted.add(ballot.id);
  }

  return { tally, newlyExhausted };
}

// ---------------------------------------------------------------------------
// Select eliminations (single, tied, or batch)
// ---------------------------------------------------------------------------

function selectEliminations(
  tally: Map<string, IR>,
  activeCandidates: Set<string>,
  tieBreaker: TieBreakerFn,
  priorRounds: Round[],
): {
  toEliminate: string[];
  tieBreakEvent?: Round['tieBreakApplied'];
  unusualOutcome?: UnusualOutcome;
} {
  // Sort candidates by tally ascending
  const sorted = [...activeCandidates]
    .map(id => ({ id, tally: tally.get(id) ?? ZERO }))
    .sort((a, b) => {
      const c = cmp(a.tally, b.tally);
      return c < 0n ? -1 : c > 0n ? 1 : 0;
    });

  // Check for batch elimination:
  // Find the largest prefix P such that sum(tally in P) < min(tally not in P)
  let batchSize = 1;
  for (let prefixLen = 2; prefixLen < sorted.length; prefixLen++) {
    const prefixSum = sum(sorted.slice(0, prefixLen).map(x => x.tally));
    const restMin = sorted[prefixLen]!.tally;
    if (lt(prefixSum, restMin)) {
      batchSize = prefixLen;
    } else {
      break; // Once the condition fails, it won't re-hold for larger prefixes
    }
  }

  if (batchSize > 1) {
    const toEliminate = sorted.slice(0, batchSize).map(x => x.id);
    const unusual: UnusualOutcome = {
      code: 'BATCH_ELIMINATION_APPLIED',
      description: `Batch elimination: candidates [${toEliminate.join(', ')}] were eliminated together because their combined vote total is strictly less than the next-lowest candidate's total.`,
      roundNumber: priorRounds.length + 1,
    };
    return { toEliminate, unusualOutcome: unusual };
  }

  // Single elimination (with possible tie-break)
  const minTally = sorted[0]!.tally;
  const tiedCandidates = sorted.filter(x => eq(x.tally, minTally)).map(x => x.id);

  if (tiedCandidates.length === 1) {
    return { toEliminate: [tiedCandidates[0]!] };
  }

  // Tie-break needed
  const { selected, event } = tieBreaker(tiedCandidates, priorRounds, 'IRV elimination tie');
  return { toEliminate: [selected], tieBreakEvent: event };
}

// ---------------------------------------------------------------------------
// Compute ballot transfers after elimination
// ---------------------------------------------------------------------------

function computeTransfers(
  ballots: ResolvedBallot[],
  eliminatedIds: string[],
  activeCandidatesBeforeElimination: Set<string>,
  exhaustedBallotIds: Set<string>,
  trackBallotLevel: boolean,
): { aggregate: AggregateTransfer[]; ballotLevel?: BallotLevelTransfer[] } {
  const eliminatedSet = new Set(eliminatedIds);
  // activeCandidates before removal of eliminated
  const stillActive = new Set([...activeCandidatesBeforeElimination].filter(id => !eliminatedSet.has(id)));

  // aggregate: (from, to | null) → ballot count
  const aggMap = new Map<string, { fromId: string; toId: string | null; count: number }>();
  const ballotLevel: BallotLevelTransfer[] = [];

  for (const ballot of ballots) {
    if (exhaustedBallotIds.has(ballot.id)) continue;

    // Find what this ballot's current active preference was BEFORE eliminations
    let prevActive: string | null = null;
    for (const id of ballot.rankings) {
      if (activeCandidatesBeforeElimination.has(id)) {
        prevActive = id;
        break;
      }
    }
    if (prevActive === null || !eliminatedSet.has(prevActive)) continue;

    // Find new active preference after eliminations
    let newActive: string | null = null;
    for (const id of ballot.rankings) {
      if (stillActive.has(id)) {
        newActive = id;
        break;
      }
    }

    const key = `${prevActive}→${newActive ?? 'null'}`;
    const existing = aggMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      aggMap.set(key, { fromId: prevActive, toId: newActive, count: 1 });
    }

    if (trackBallotLevel) {
      ballotLevel.push({
        ballotId: ballot.id,
        fromCandidateId: prevActive,
        toCandidateId: newActive,
        weight: toRational(ONE),
      });
    }
  }

  const aggregate: AggregateTransfer[] = [...aggMap.values()].map(e => ({
    fromCandidateId: e.fromId,
    toCandidateId: e.toId,
    weight: toRational(ONE),
    ballotCount: e.count,
  }));

  if (trackBallotLevel) return { aggregate, ballotLevel };
  return { aggregate };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tallyToRecord(tally: Map<string, IR>): Record<string, Rational> {
  const rec: Record<string, Rational> = {};
  for (const [id, t] of tally) rec[id] = toRational(t);
  return rec;
}
