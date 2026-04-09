/**
 * Golden fixture tests for rcv-engine.
 *
 * These tests lock in the exact, independently verifiable output for two
 * well-documented reference elections. Any future change to the algorithm
 * that silently alters a result will cause these tests to fail, forcing an
 * explicit acknowledgment that the output has changed.
 *
 * Fixtures included:
 *
 *   1. Tennessee Capital Election (IRV) — Wikipedia "Instant-runoff voting"
 *      worked example. 100 voters, 4 cities, 3 rounds. Expected: Knoxville.
 *      https://en.wikipedia.org/wiki/Instant-runoff_voting#Example
 *
 *   2. Three-Candidate Two-Seat STV — a minimal STV election designed to
 *      exercise a round-1 surplus transfer followed by plurality election.
 *      9 ballots, quota = 4, Alice elected in round 1 (zero surplus),
 *      Bob elected in round 2 after accumulating Carol's transfers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tabulate, hashInput, formatAuditLog } from '../src/index.js';
import type { TabulateInput, TabulateResult } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function r(numerator: number, denominator = 1) {
  return { numerator: String(numerator), denominator: String(denominator) };
}

function mkGroup(prefix: string, count: number, ranking: string[]) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    rankings: ranking.map(id => ({ type: 'candidate' as const, id })),
  }));
}

// ── Fixture 1: Tennessee Capital Election ─────────────────────────────────────
//
// Preference profile (100 voters total):
//   42% Memphis    →  Memphis > Nashville > Chattanooga > Knoxville
//   26% Nashville  →  Nashville > Chattanooga > Knoxville > Memphis
//   15% Chattanooga → Chattanooga > Knoxville > Nashville > Memphis
//   17% Knoxville  →  Knoxville > Chattanooga > Nashville > Memphis
//
// Manual calculation:
//   Round 1: Memphis 42, Nashville 26, Chattanooga 15*, Knoxville 17
//            Threshold = floor(100/2)+1 = 51. Eliminate Chattanooga (lowest).
//            15 Chattanooga ballots transfer to Knoxville (next preference).
//   Round 2: Memphis 42, Nashville 26*, Knoxville 32
//            Threshold = 51. Eliminate Nashville (lowest of the two remaining
//            non-Memphis candidates).
//            26 Nashville ballots → next active after Chattanooga (eliminated)
//            is Knoxville. Transfer to Knoxville.
//   Round 3: Memphis 42, Knoxville 58
//            Threshold = 51. Knoxville 58 ≥ 51. Knoxville WINS.
//
// Note: no ballots exhaust because all voters ranked all four candidates.

const tennesseeInput: TabulateInput = {
  schemaVersion: 1,
  candidates: [
    { id: 'mem', name: 'Memphis' },
    { id: 'nas', name: 'Nashville' },
    { id: 'cha', name: 'Chattanooga' },
    { id: 'kno', name: 'Knoxville' },
  ],
  ballots: [
    ...mkGroup('m', 42, ['mem', 'nas', 'cha', 'kno']),
    ...mkGroup('n', 26, ['nas', 'cha', 'kno', 'mem']),
    ...mkGroup('c', 15, ['cha', 'kno', 'nas', 'mem']),
    ...mkGroup('k', 17, ['kno', 'cha', 'nas', 'mem']),
  ],
  options: {
    method: 'irv',
    seats: 1,
    tieBreak: { strategy: 'previousRound' },
    quotaMode: 'dynamic',
    writeInsAllowed: false,
  },
};

describe('Golden: Tennessee Capital Election (IRV)', () => {
  let result: TabulateResult;

  beforeAll(() => {
    result = tabulate(tennesseeInput);
  });

  // ── Winner ──────────────────────────────────────────────────────────────────

  it('elects exactly one winner', () => {
    expect(result.winners).toHaveLength(1);
  });

  it('Knoxville wins', () => {
    expect(result.winners[0].candidateId).toBe('kno');
    expect(result.winners[0].candidateName).toBe('Knoxville');
  });

  it('Knoxville is elected in round 3', () => {
    expect(result.winners[0].electedInRound).toBe(3);
  });

  it('Knoxville final tally is 58', () => {
    expect(result.winners[0].finalTally).toEqual(r(58));
  });

  // ── Round structure ──────────────────────────────────────────────────────────

  it('takes exactly 3 rounds', () => {
    expect(result.rounds).toHaveLength(3);
  });

  // Round 1 ──

  it('round 1: correct first-choice tallies', () => {
    const { tally } = result.rounds[0];
    expect(tally['mem']).toEqual(r(42));
    expect(tally['nas']).toEqual(r(26));
    expect(tally['cha']).toEqual(r(15));
    expect(tally['kno']).toEqual(r(17));
  });

  it('round 1: threshold is 51', () => {
    expect(result.rounds[0].threshold).toEqual(r(51));
  });

  it('round 1: nobody elected', () => {
    expect(result.rounds[0].elected).toHaveLength(0);
  });

  it('round 1: Chattanooga eliminated', () => {
    expect(result.rounds[0].eliminated).toEqual(['cha']);
  });

  it('round 1: no exhausted ballots', () => {
    expect(result.rounds[0].exhaustedTotal).toEqual(r(0));
  });

  // Round 2 ──

  it('round 2: Chattanooga absent from tally', () => {
    expect(result.rounds[1].tally).not.toHaveProperty('cha');
  });

  it('round 2: tallies after Chattanooga transfer', () => {
    const { tally } = result.rounds[1];
    expect(tally['mem']).toEqual(r(42));
    expect(tally['nas']).toEqual(r(26));
    expect(tally['kno']).toEqual(r(32)); // 17 + 15 from Chattanooga
  });

  it('round 2: nobody elected', () => {
    expect(result.rounds[1].elected).toHaveLength(0);
  });

  it('round 2: Nashville eliminated', () => {
    expect(result.rounds[1].eliminated).toEqual(['nas']);
  });

  // Round 3 ──

  it('round 3: only two candidates remain', () => {
    const keys = Object.keys(result.rounds[2].tally);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('mem');
    expect(keys).toContain('kno');
  });

  it('round 3: Knoxville has 58 votes, Memphis 42', () => {
    const { tally } = result.rounds[2];
    expect(tally['kno']).toEqual(r(58)); // 32 + 26 from Nashville
    expect(tally['mem']).toEqual(r(42));
  });

  it('round 3: Knoxville elected', () => {
    expect(result.rounds[2].elected).toContain('kno');
  });

  it('no ballots exhausted (all voters ranked all candidates)', () => {
    const finalRound = result.rounds[result.rounds.length - 1];
    expect(finalRound.exhaustedTotal).toEqual(r(0));
  });

  // ── Metadata ─────────────────────────────────────────────────────────────────

  it('totalBallots is 100', () => {
    expect(result.meta.ballotCount).toBe(100);
  });

  it('method is irv', () => {
    expect(result.meta.method).toBe('irv');
  });

  it('seatsFilled is 1', () => {
    expect(result.summary.seatsFilled).toBe(1);
  });

  it('input hash is stable across re-runs', () => {
    expect(result.meta.inputHash).toBe(hashInput(tennesseeInput));
  });

  it('re-running with the same input produces identical results', () => {
    expect(tabulate(tennesseeInput)).toEqual(result);
  });

  it('audit log is non-empty and mentions Knoxville', () => {
    const log = formatAuditLog(result);
    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain('Knoxville');
  });

  it('audit log mentions all three rounds', () => {
    const log = formatAuditLog(result, { verbosity: 'detailed' });
    expect(log).toContain('ROUND 1');
    expect(log).toContain('ROUND 2');
    expect(log).toContain('ROUND 3');
  });
});

// ── Fixture 2: Three-Candidate Two-Seat STV ───────────────────────────────────
//
// Candidates:  Alice (ali), Bob (bob), Carol (car)
// Seats:       2
// Ballots (9 total):
//   4 × [Alice > Bob > Carol]
//   3 × [Bob > Carol > Alice]
//   2 × [Carol > Bob > Alice]
//
// Manual calculation (Droop quota = floor(9/3)+1 = 4):
//   Round 1 first preferences: Alice 4, Bob 3, Carol 2.
//     Alice meets quota (4 ≥ 4). Surplus = 0.
//     Zero-surplus transfer: Alice's ballots transfer at value 0 — no effective
//     movement. Tally for remaining candidates unchanged: Bob 3, Carol 2.
//     Remaining seats = 1; remaining active candidates = 2.
//     Eliminate Carol (lowest). Carol's 2 ballots → Bob (next preference).
//     Bob: 3 + 2 = 5 ≥ quota 4. Bob elected.
//   Winners: Alice (round 1), Bob (round 2).

const stvInput: TabulateInput = {
  schemaVersion: 1,
  candidates: [
    { id: 'ali', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
    { id: 'car', name: 'Carol' },
  ],
  ballots: [
    ...mkGroup('a', 4, ['ali', 'bob', 'car']),
    ...mkGroup('b', 3, ['bob', 'car', 'ali']),
    ...mkGroup('c', 2, ['car', 'bob', 'ali']),
  ],
  options: {
    method: 'stv',
    seats: 2,
    tieBreak: { strategy: 'previousRound' },
    quotaMode: 'dynamic',
    writeInsAllowed: false,
  },
};

describe('Golden: Three-Candidate Two-Seat STV', () => {
  let result: TabulateResult;

  beforeAll(() => {
    result = tabulate(stvInput);
  });

  // ── Winners ──────────────────────────────────────────────────────────────────

  it('elects exactly 2 winners', () => {
    expect(result.winners).toHaveLength(2);
  });

  it('Alice and Bob win', () => {
    const ids = result.winners.map(w => w.candidateId).sort();
    expect(ids).toEqual(['ali', 'bob']);
  });

  it('Alice elected in round 1', () => {
    const alice = result.winners.find(w => w.candidateId === 'ali')!;
    expect(alice.electedInRound).toBe(1);
  });

  it('Bob elected in round 2', () => {
    const bob = result.winners.find(w => w.candidateId === 'bob')!;
    expect(bob.electedInRound).toBe(2);
  });

  it('Carol does not win', () => {
    expect(result.winners.map(w => w.candidateId)).not.toContain('car');
  });

  // ── Round structure ───────────────────────────────────────────────────────────

  it('takes exactly 2 rounds', () => {
    expect(result.rounds).toHaveLength(2);
  });

  it('round 1: first-choice tallies are Alice 4, Bob 3, Carol 2', () => {
    const { tally } = result.rounds[0];
    expect(tally['ali']).toEqual(r(4));
    expect(tally['bob']).toEqual(r(3));
    expect(tally['car']).toEqual(r(2));
  });

  it('round 1: Alice elected', () => {
    expect(result.rounds[0].elected).toContain('ali');
  });

  it('round 1: nobody eliminated', () => {
    expect(result.rounds[0].eliminated).toHaveLength(0);
  });

  it('round 2: Alice absent from tally', () => {
    expect(result.rounds[1].tally).not.toHaveProperty('ali');
  });

  it('round 2: Bob and Carol still present', () => {
    expect(result.rounds[1].tally).toHaveProperty('bob');
    expect(result.rounds[1].tally).toHaveProperty('car');
  });

  it('round 2: Bob elected', () => {
    expect(result.rounds[1].elected).toContain('bob');
  });

  // ── Metadata ─────────────────────────────────────────────────────────────────

  it('totalBallots is 9', () => {
    expect(result.meta.ballotCount).toBe(9);
  });

  it('method is stv', () => {
    expect(result.meta.method).toBe('stv');
  });

  it('seats is 2', () => {
    expect(result.meta.seats).toBe(2);
  });

  it('seatsFilled is 2', () => {
    expect(result.summary.seatsFilled).toBe(2);
  });

  it('input hash is stable', () => {
    expect(result.meta.inputHash).toBe(hashInput(stvInput));
  });

  it('re-running produces identical results', () => {
    expect(tabulate(stvInput)).toEqual(result);
  });

  it('audit log mentions both winners', () => {
    const log = formatAuditLog(result);
    expect(log).toContain('Alice');
    expect(log).toContain('Bob');
  });
});

// ── Cross-fixture: hash stability ─────────────────────────────────────────────
// The two fixture inputs are structurally different; their hashes must not collide.

describe('Golden: hash uniqueness across fixtures', () => {
  it('Tennessee and STV fixtures have different input hashes', () => {
    expect(hashInput(tennesseeInput)).not.toBe(hashInput(stvInput));
  });
});
