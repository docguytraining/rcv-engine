// ─────────────────────────────────────────────────────────────────────────────
// Tie-breaking strategies
//
// Three strategies as specified in Section 4.6 and Section 6.6:
//   random        — seeded PRNG; deterministic
//   previousRound — walk backwards through prior rounds to find a discriminator
//   provided      — caller-supplied priority order (later = eliminated first)
// ─────────────────────────────────────────────────────────────────────────────

import type { TieBreakOption, TieBreakEvent, Round } from './types.js';
import { UnresolvableTieError } from './errors.js';
import type { Prng } from './prng.js';
import { pickOne } from './prng.js';
import type { IR } from './rational.js';
import { cmp, fromRational } from './rational.js';

// ---------------------------------------------------------------------------
// TieBreaker function type
// ---------------------------------------------------------------------------

/**
 * Given a set of tied candidate IDs (already sorted by input order) and the
 * rounds recorded so far, returns the ID of the candidate to eliminate (or
 * to act on in the context of the caller).
 *
 * Also returns a TieBreakEvent describing the decision.
 */
export type TieBreakerFn = (
  tiedIds: string[],         // sorted by input order (spec §6.6)
  priorRounds: Round[],      // rounds recorded so far (may be empty)
  context?: string,          // human-readable context for the event reason
) => { selected: string; event: TieBreakEvent };

/**
 * Create a TieBreakerFn from a TieBreakOption.
 * If strategy is 'random', the prng must be provided.
 * The returned function is stateful (PRNG draws accumulate).
 */
export function createTieBreaker(
  option: TieBreakOption,
  candidateInputOrder: Map<string, number>, // candidateId → index in original candidates array
  prng?: Prng,
): TieBreakerFn {
  return (tiedIds: string[], priorRounds: Round[], context?: string): { selected: string; event: TieBreakEvent } => {
    // Sort tied IDs by their input order for determinism
    const sorted = [...tiedIds].sort((a, b) => {
      const ia = candidateInputOrder.get(a) ?? 0;
      const ib = candidateInputOrder.get(b) ?? 0;
      return ia - ib;
    });

    if (option.strategy === 'random') {
      if (!prng) throw new Error('Internal: PRNG required for random tie-break strategy');
      const beforeDraw = prng.drawIndex;
      const { item: selected } = pickOne(sorted, prng);
      const afterDraw = prng.drawIndex;
      const event: TieBreakEvent = {
        strategy: 'random',
        tiedCandidates: sorted,
        selectedCandidate: selected,
        reason: `Seeded PRNG draw (draw #${afterDraw}, seed "${option.seed}")`,
        prngDrawIndex: beforeDraw + 1, // 1-indexed draw number that produced this result
      };
      return { selected, event };
    }

    if (option.strategy === 'provided') {
      // Later in the order → eliminated first
      let lastIdx = -1;
      let lastId = sorted[0]!;
      for (const id of sorted) {
        const idx = option.order.indexOf(id);
        if (idx > lastIdx) {
          lastIdx = idx;
          lastId = id;
        }
      }
      const event: TieBreakEvent = {
        strategy: 'provided',
        tiedCandidates: sorted,
        selectedCandidate: lastId,
        reason: `Candidate "${lastId}" appears latest in the caller-provided tie-break order (position ${lastIdx})`,
      };
      return { selected: lastId, event };
    }

    // strategy === 'previousRound'
    // Walk backwards through prior rounds
    for (let r = priorRounds.length - 1; r >= 0; r--) {
      const round = priorRounds[r]!;
      const talliesInRound = new Map<string, IR>();
      for (const id of sorted) {
        const tallyStr = round.tally[id];
        if (tallyStr) {
          talliesInRound.set(id, fromRational(tallyStr));
        }
      }
      if (talliesInRound.size < 2) continue; // not all tied candidates appeared

      // Find the minimum tally among the tied candidates in this round
      let minTally: IR | null = null;
      let minId: string | null = null;
      for (const [id, tally] of talliesInRound) {
        if (minTally === null || cmp(tally, minTally) < 0n) {
          minTally = tally;
          minId = id;
        }
      }

      // Check for uniqueness: did exactly one candidate have the minimum?
      const minCount = [...talliesInRound.values()].filter(t => cmp(t, minTally!) === 0n).length;
      if (minCount === 1 && minId !== null) {
        const lookback = priorRounds.length - r;
        const event: TieBreakEvent = {
          strategy: 'previousRound',
          tiedCandidates: sorted,
          selectedCandidate: minId,
          reason: `Candidate "${minId}" had the fewest votes (${round.tally[minId]?.numerator ?? '?'}) in round ${round.roundNumber}, ${lookback} round(s) back`,
          previousRoundLookback: lookback,
        };
        return { selected: minId, event };
      }
      // All tied in this round too — look one round further back
    }

    // Could not resolve the tie with any prior round
    throw new UnresolvableTieError(
      sorted,
      `Cannot resolve tie among [${sorted.join(', ')}] using "previousRound" strategy: ` +
      `all tied candidates had equal vote totals in every prior round. ` +
      (context ? context + ' ' : '') +
      `Consider using strategy "random" with a publicly committed seed.`,
    );
  };
}
