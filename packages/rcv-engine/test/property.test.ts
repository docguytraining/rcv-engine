/**
 * Property-based tests for rcv-engine using fast-check.
 *
 * These tests assert structural invariants that MUST hold for every valid input,
 * regardless of candidate count, ballot permutation, or vote distribution. They
 * catch regressions that specific example-based tests would miss because they
 * cover the entire input space through random search.
 *
 * Invariants tested:
 *   Universal  — determinism, hash integrity, valid winner IDs, round structure
 *   IRV        — at most 1 winner, exhausted count monotone, tally conservation
 *   STV        — winners ≤ seats, candidates never reappear after elimination
 *   Validation — generated inputs are always accepted by validateInput()
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { tabulate, hashInput, validateInput } from '../src/index.js';
import type { TabulateInput, ElectionOptions, Rational } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a Rational to a BigInt numerator×denominator pair for comparisons. */
function rationalLeq(a: Rational, b: Rational): boolean {
  return BigInt(a.numerator) * BigInt(b.denominator)
    <= BigInt(b.numerator) * BigInt(a.denominator);
}

function rationalEq(a: Rational, b: Rational): boolean {
  return BigInt(a.numerator) * BigInt(b.denominator)
    === BigInt(b.numerator) * BigInt(a.denominator);
}

/** Sum an array of Rationals to a single Rational (returns {n,d} as strings). */
function sumRationals(rs: Rational[]): Rational {
  let n = 0n;
  let d = 1n;
  for (const r of rs) {
    const rn = BigInt(r.numerator);
    const rd = BigInt(r.denominator);
    n = n * rd + rn * d;
    d = d * rd;
    const g = gcd(n < 0n ? -n : n, d);
    n /= g; d /= g;
  }
  return { numerator: n.toString(), denominator: d.toString() };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

// ── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generates a set of unique 4-character hex candidate IDs.
 * Derived from nat() so that uniqueArray constraint is efficient.
 */
const candidateIdsArb = (min = 2, max = 6): fc.Arbitrary<string[]> =>
  fc.uniqueArray(
    fc.nat({ max: 65535 }).map(n => n.toString(16).padStart(4, '0')),
    { minLength: min, maxLength: max },
  );

/** Base options shared by all generated elections. */
function baseOptions(method: 'irv' | 'stv', seats: number): ElectionOptions {
  return {
    method,
    seats,
    tieBreak: { strategy: 'random', seed: 'prop-test-seed' },
    quotaMode: 'dynamic',
    writeInsAllowed: false,
  };
}

/** Builds ballots as non-empty shuffled subsets of the given candidate ID array. */
const ballotsArb = (ids: string[], maxBallots = 80) =>
  fc.array(
    // minLength: 1 — the validator rejects ballots with empty rankings
    fc.shuffledSubarray(ids, { minLength: 1, maxLength: ids.length }),
    { minLength: 0, maxLength: maxBallots },
  ).map(groups =>
    groups.map((rankings, i) => ({
      id: `b${i}`,
      rankings: rankings.map(id => ({ type: 'candidate' as const, id })),
    })),
  );

/** Valid IRV TabulateInput. */
const irvInputArb: fc.Arbitrary<TabulateInput> =
  candidateIdsArb(2, 7).chain(ids =>
    ballotsArb(ids).map(ballots => ({
      schemaVersion: 1 as const,
      candidates: ids.map(id => ({ id, name: `Cand-${id}` })),
      ballots,
      options: baseOptions('irv', 1),
    })),
  );

/** Valid STV TabulateInput with 1 ≤ seats < candidates. */
const stvInputArb: fc.Arbitrary<TabulateInput> =
  fc.integer({ min: 3, max: 6 }).chain(numCands =>
    fc.integer({ min: 1, max: numCands - 1 }).chain(seats =>
      candidateIdsArb(numCands, numCands).chain(ids =>
        ballotsArb(ids, 60).map(ballots => ({
          schemaVersion: 1 as const,
          candidates: ids.map(id => ({ id, name: `Cand-${id}` })),
          ballots,
          options: baseOptions('stv', seats),
        })),
      ),
    ),
  );

// ── Universal invariants ──────────────────────────────────────────────────────

describe('Property: universal invariants (IRV)', () => {
  it('tabulate() is deterministic — same input always gives same output', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const r1 = tabulate(input);
        const r2 = tabulate(input);
        expect(r1).toEqual(r2);
      }),
      { numRuns: 200 },
    );
  });

  it('result.meta.inputHash matches hashInput(input)', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const result = tabulate(input);
        expect(result.meta.inputHash).toBe(hashInput(input));
      }),
      { numRuns: 200 },
    );
  });

  it('every winner candidateId appears in the candidates list', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const result = tabulate(input);
        const validIds = new Set(input.candidates.map(c => c.id));
        for (const w of result.winners) {
          expect(validIds.has(w.candidateId)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('result.meta.producedAt is always null', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        expect(tabulate(input).meta.producedAt).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('rounds array is never empty', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        expect(tabulate(input).rounds.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('generated inputs always pass validateInput()', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        expect(validateInput(input).ok).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

// ── IRV-specific invariants ───────────────────────────────────────────────────

describe('Property: IRV invariants', () => {
  it('at most 1 winner', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        expect(tabulate(input).winners.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('exhaustedTotal is non-decreasing across rounds', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const { rounds } = tabulate(input);
        for (let i = 1; i < rounds.length; i++) {
          expect(rationalLeq(rounds[i - 1].exhaustedTotal, rounds[i].exhaustedTotal)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('every tally key is a valid candidate ID', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const validIds = new Set(input.candidates.map(c => c.id));
        const { rounds } = tabulate(input);
        for (const round of rounds) {
          for (const key of Object.keys(round.tally)) {
            expect(validIds.has(key)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a candidate never reappears in the tally after being eliminated', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const { rounds } = tabulate(input);
        const eliminated = new Set<string>();
        for (const round of rounds) {
          // Check no eliminated candidate has a tally entry this round
          for (const id of eliminated) {
            expect(Object.prototype.hasOwnProperty.call(round.tally, id)).toBe(false);
          }
          // Record this round's eliminations
          for (const id of round.eliminated) {
            eliminated.add(id);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('vote conservation: sum(tally) + exhaustedTotal = totalBallots every round', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const { rounds, meta } = tabulate(input);
        const total: Rational = { numerator: meta.ballotCount.toString(), denominator: '1' };
        for (const round of rounds) {
          const tallySum = sumRationals(Object.values(round.tally));
          const conserved = sumRationals([tallySum, round.exhaustedTotal]);
          expect(rationalEq(conserved, total)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('winner (when present) either has majority or WINNER_WITHOUT_MAJORITY is flagged', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const result = tabulate(input);
        if (result.winners.length === 0) return; // all-exhausted is fine

        const winner = result.winners[0];
        const finalRound = result.rounds[result.rounds.length - 1];
        const threshold = finalRound.threshold;
        const winnerTally = finalRound.tally[winner.candidateId];

        const hasMajority = winnerTally != null && !rationalLeq(winnerTally, threshold)
          || (winnerTally != null && rationalEq(winnerTally, threshold));
        const hasFlag = result.summary.unusualOutcomes
          .some(o => o.code === 'WINNER_WITHOUT_MAJORITY');

        // Either the winner has ≥ threshold votes, or the flag is set
        expect(hasMajority || hasFlag).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('roundCount in summary equals rounds array length', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const result = tabulate(input);
        expect(result.summary.roundCount).toBe(result.rounds.length);
        expect(result.meta.roundCount).toBe(result.rounds.length);
      }),
      { numRuns: 200 },
    );
  });

  it('electedInRound on each winner matches the round that lists them as elected', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        const result = tabulate(input);
        for (const winner of result.winners) {
          const r = result.rounds[winner.electedInRound - 1];
          expect(r).toBeDefined();
          expect(r.elected).toContain(winner.candidateId);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ── STV invariants ────────────────────────────────────────────────────────────

describe('Property: STV invariants', () => {
  it('winners ≤ seats', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        const result = tabulate(input);
        expect(result.winners.length).toBeLessThanOrEqual(input.options.seats);
      }),
      { numRuns: 200 },
    );
  });

  it('every winner candidateId appears in the candidates list', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        const validIds = new Set(input.candidates.map(c => c.id));
        for (const w of tabulate(input).winners) {
          expect(validIds.has(w.candidateId)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('no duplicate winners', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        const ids = tabulate(input).winners.map(w => w.candidateId);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 200 },
    );
  });

  it('a candidate never reappears in the tally after being eliminated', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        const { rounds } = tabulate(input);
        const eliminated = new Set<string>();
        for (const round of rounds) {
          for (const id of eliminated) {
            expect(Object.prototype.hasOwnProperty.call(round.tally, id)).toBe(false);
          }
          for (const id of round.eliminated) {
            eliminated.add(id);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('exhaustedTotal is non-decreasing across rounds', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        const { rounds } = tabulate(input);
        for (let i = 1; i < rounds.length; i++) {
          expect(rationalLeq(rounds[i - 1].exhaustedTotal, rounds[i].exhaustedTotal)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('generated STV inputs always pass validateInput()', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        expect(validateInput(input).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('tabulate() is deterministic for STV', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        expect(tabulate(input)).toEqual(tabulate(input));
      }),
      { numRuns: 100 },
    );
  });

  it('seatsFilled in summary ≤ seats', () => {
    fc.assert(
      fc.property(stvInputArb, input => {
        const result = tabulate(input);
        expect(result.summary.seatsFilled).toBeLessThanOrEqual(input.options.seats);
      }),
      { numRuns: 200 },
    );
  });

  it('when seats ≥ candidates, all candidates win (elected by remainder)', () => {
    // Generate elections where seats === candidates
    const allWinArb = candidateIdsArb(2, 5).chain(ids =>
      ballotsArb(ids, 30).map(ballots => ({
        schemaVersion: 1 as const,
        candidates: ids.map(id => ({ id, name: `C-${id}` })),
        ballots,
        options: baseOptions('stv', ids.length), // seats == candidates
      })),
    );
    fc.assert(
      fc.property(allWinArb, input => {
        const result = tabulate(input);
        expect(result.winners.length).toBe(input.candidates.length);
      }),
      { numRuns: 150 },
    );
  });
});

// ── Hash integrity ────────────────────────────────────────────────────────────

describe('Property: hash integrity', () => {
  it('different ballots produce different hashes', () => {
    // Build two inputs that differ only in one ballot ranking
    const diffArb = candidateIdsArb(3, 5).filter(ids => ids.length >= 3).chain(ids =>
      fc.tuple(
        ballotsArb(ids, 20),
        fc.shuffledSubarray(ids, { minLength: 1, maxLength: ids.length }),
        fc.shuffledSubarray(ids, { minLength: 1, maxLength: ids.length }),
      ).filter(([, rankA, rankB]) => rankA.join() !== rankB.join())
        .map(([baseBallots, rankA, rankB]) => {
          const base = {
            schemaVersion: 1 as const,
            candidates: ids.map(id => ({ id, name: `C-${id}` })),
            options: baseOptions('irv', 1),
          };
          const inputA: TabulateInput = {
            ...base,
            ballots: [
              ...baseBallots,
              { id: 'extra', rankings: rankA.map(id => ({ type: 'candidate' as const, id })) },
            ],
          };
          const inputB: TabulateInput = {
            ...base,
            ballots: [
              ...baseBallots,
              { id: 'extra', rankings: rankB.map(id => ({ type: 'candidate' as const, id })) },
            ],
          };
          return { inputA, inputB };
        }),
    );

    fc.assert(
      fc.property(diffArb, ({ inputA, inputB }) => {
        expect(hashInput(inputA)).not.toBe(hashInput(inputB));
      }),
      { numRuns: 200 },
    );
  });

  it('hashInput is stable — calling twice gives the same value', () => {
    fc.assert(
      fc.property(irvInputArb, input => {
        expect(hashInput(input)).toBe(hashInput(input));
      }),
      { numRuns: 200 },
    );
  });
});
