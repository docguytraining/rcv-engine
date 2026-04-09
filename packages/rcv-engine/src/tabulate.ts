// ─────────────────────────────────────────────────────────────────────────────
// tabulate() — main entry point
// Also exports validateInput() and hashInput() as top-level API functions.
// ─────────────────────────────────────────────────────────────────────────────

import type { TabulateInput, TabulateResult } from './types.js';
import { resolveInput } from './validate.js';
import { hashInput } from './hash.js';
import { createPrng } from './prng.js';
import { createTieBreaker } from './tiebreak.js';
import { tabulateIrv } from './irv.js';
import { tabulateStv } from './stv.js';
import { toRational, fromInt } from './rational.js';

// Package version — single source of truth; keep in sync with package.json
const ENGINE_VERSION = '1.0.0';

/**
 * Tabulate a ranked-choice election.
 *
 * This is the primary entry point. It is synchronous, pure, and performs no I/O.
 * It throws a typed error (subclass of RcvEngineError) if the input is invalid.
 * Unusual but legitimate outcomes are reported in the result, not thrown.
 */
export function tabulate(input: TabulateInput): TabulateResult {
  // 1. Validate and resolve write-ins (throws ValidationError on failure)
  const resolved = resolveInput(input);

  // 2. Compute input hash (for audit trail)
  const inputHash = hashInput(input);

  // 3. Build candidate input-order map (for tie-breaking)
  const candidateInputOrder = new Map<string, number>(
    input.candidates.map((c, i) => [c.id, i]),
  );
  // Synthesized write-in candidates come after all declared candidates
  const baseCandidateCount = input.candidates.length;
  for (const sw of resolved.synthesizedWriteIns) {
    if (!candidateInputOrder.has(sw.synthesizedId)) {
      candidateInputOrder.set(sw.synthesizedId, baseCandidateCount + candidateInputOrder.size);
    }
  }

  // 4. Create PRNG if using random tie-break
  const opts = resolved.options;
  let prng = undefined;
  if (opts.tieBreak.strategy === 'random') {
    prng = createPrng(opts.tieBreak.seed);
  }

  // 5. Create tie-breaker function
  const tieBreaker = createTieBreaker(opts.tieBreak, candidateInputOrder, prng);

  // 6. Run the appropriate algorithm
  const trackBallotTransfers = opts.trackBallotTransfers === true;

  let rounds, winners;
  if (opts.method === 'irv') {
    ({ rounds, winners } = tabulateIrv(
      resolved.candidates,
      resolved.ballots,
      opts.quotaMode,
      tieBreaker,
      trackBallotTransfers,
    ));
  } else {
    const arithmetic = opts.stvArithmetic ?? 'exact';
    ({ rounds, winners } = tabulateStv(
      resolved.candidates,
      resolved.ballots,
      opts.seats,
      opts.quotaMode,
      arithmetic,
      tieBreaker,
      trackBallotTransfers,
    ));
  }

  // 7. Collect all unusual outcomes from rounds
  const allUnusual = rounds.flatMap(r => r.unusualOutcomes ?? []);

  // 8. Build summary
  const totalBallots = resolved.ballots.length;
  const lastRound = rounds[rounds.length - 1];
  const exhaustedBallots = lastRound?.exhaustedTotal ?? toRational(fromInt(0));

  // Check for TIE_BREAK_INVOKED
  const hasTieBreak = rounds.some(r => r.tieBreakApplied !== undefined);
  if (hasTieBreak && !allUnusual.some(u => u.code === 'TIE_BREAK_INVOKED')) {
    // Add a summary-level flag; individual rounds have their TieBreakEvent
  }

  const summary = {
    totalBallots,
    validBallots: totalBallots,
    exhaustedBallots,
    roundCount: rounds.length,
    method: opts.method,
    seats: opts.seats,
    seatsFilled: winners.length,
    unusualOutcomes: allUnusual,
  };

  // 9. Build metadata
  const tieBreakStrategy = opts.tieBreak.strategy;
  const meta = {
    engineVersion: ENGINE_VERSION,
    schemaVersion: 1 as const,
    inputHash,
    producedAt: null,
    method: opts.method,
    seats: opts.seats,
    quotaMode: opts.quotaMode,
    tieBreakStrategy,
    ...(tieBreakStrategy === 'random' ? { tieBreakSeed: opts.tieBreak.seed } : {}),
    writeInsAllowed: opts.writeInsAllowed,
    ...(opts.maxWriteInsPerBallot !== undefined ? { maxWriteInsPerBallot: opts.maxWriteInsPerBallot } : {}),
    stvArithmetic: opts.method === 'stv'
      ? (opts.stvArithmetic ?? 'exact')
      : 'n/a' as const,
    candidateCount: resolved.candidates.length,
    ballotCount: totalBallots,
    roundCount: rounds.length,
    writeInAliasesUsed: resolved.writeInAliasesUsed,
    synthesizedWriteIns: resolved.synthesizedWriteIns,
  };

  return { winners, rounds, summary, meta };
}
