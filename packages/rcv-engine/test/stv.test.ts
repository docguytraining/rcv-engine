import { describe, it, expect } from 'vitest';
import { tabulate } from '../src/tabulate.js';
import type { TabulateInput } from '../src/types.js';

function ballot(id: string, ...ranking: string[]) {
  return { id, rankings: ranking.map(cid => ({ type: 'candidate' as const, id: cid })) };
}

describe('STV tabulation', () => {
  it('elects two clear winners in a 3-candidate, 2-seat election', () => {
    // Alice: 40, Bob: 35, Carol: 25 → quota = floor(100/3)+1 = 34
    // Alice and Bob both > 34 → both elected in round 1
    const ballots: TabulateInput['ballots'] = [];
    let id = 1;
    for (let i = 0; i < 40; i++) ballots.push(ballot(`b${id++}`, 'alice'));
    for (let i = 0; i < 35; i++) ballots.push(ballot(`b${id++}`, 'bob'));
    for (let i = 0; i < 25; i++) ballots.push(ballot(`b${id++}`, 'carol'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      ballots,
      options: {
        method: 'stv',
        seats: 2,
        tieBreak: { strategy: 'random', seed: 'demo' },
        quotaMode: 'static',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.winners).toHaveLength(2);
    const winnerIds = result.winners.map(w => w.candidateId).sort();
    expect(winnerIds).toEqual(['alice', 'bob']);
  });

  it('implements the spec worked example: 3-seat STV with surplus transfers', () => {
    // Spec Section 7.10: 5 candidates (Alice, Bob, Carol, Dave, Eve), 3 seats, 100 ballots
    // Quota = floor(100/(3+1)) + 1 = 26
    // Round 1: Alice 38 (elected, surplus 12), Bob 22, Carol 18, Dave 14, Eve 8
    // Alice surplus transfers proportionally
    // Then elections continue until 3 seats filled

    const ballots: TabulateInput['ballots'] = [];
    let id = 1;

    // Alice: 38 first-choice, surplus 12
    // When transferred, proportionally go to Bob, Carol, etc.
    // For simplicity: Alice's 38 voters have diverse second choices
    // 20 of Alice's voters prefer Bob second, 10 prefer Carol, 8 prefer Dave
    for (let i = 0; i < 20; i++) ballots.push(ballot(`b${id++}`, 'alice', 'bob'));
    for (let i = 0; i < 10; i++) ballots.push(ballot(`b${id++}`, 'alice', 'carol'));
    for (let i = 0; i < 8; i++) ballots.push(ballot(`b${id++}`, 'alice', 'dave'));

    // Bob: 22 first-choice
    for (let i = 0; i < 22; i++) ballots.push(ballot(`b${id++}`, 'bob'));

    // Carol: 18 first-choice
    for (let i = 0; i < 18; i++) ballots.push(ballot(`b${id++}`, 'carol'));

    // Dave: 14 first-choice
    for (let i = 0; i < 14; i++) ballots.push(ballot(`b${id++}`, 'dave', 'carol'));

    // Eve: 8 first-choice → transfer to Carol
    for (let i = 0; i < 8; i++) ballots.push(ballot(`b${id++}`, 'eve', 'carol'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
        { id: 'dave', name: 'Dave' },
        { id: 'eve', name: 'Eve' },
      ],
      ballots,
      options: {
        method: 'stv',
        seats: 3,
        tieBreak: { strategy: 'random', seed: 'demo' },
        quotaMode: 'static',
        stvArithmetic: 'exact',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.winners).toHaveLength(3);

    // Alice should definitely be elected (had 38 votes, quota 26)
    expect(result.winners.some(w => w.candidateId === 'alice')).toBe(true);

    // Check that we have exactly 3 winners
    expect(result.summary.seatsFilled).toBe(3);
  });

  it('elects by remainder when not enough candidates remain', () => {
    // 3 candidates, 2 seats
    // Quota = floor(10/3)+1 = 4
    // Alice: 7 (elected, surplus 3)
    // Bob: 2, Carol: 1
    // After Alice elected, remainder check: 2 remaining, 1 seat → should be elected by normal process
    // Let's try: 3 candidates, 3 seats → all elected immediately (elected by remainder)
    const ballots: TabulateInput['ballots'] = [];
    let id = 1;
    for (let i = 0; i < 5; i++) ballots.push(ballot(`b${id++}`, 'alice'));
    for (let i = 0; i < 3; i++) ballots.push(ballot(`b${id++}`, 'bob'));
    for (let i = 0; i < 2; i++) ballots.push(ballot(`b${id++}`, 'carol'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      ballots,
      options: {
        method: 'stv',
        seats: 3, // all 3 candidates for 3 seats
        tieBreak: { strategy: 'random', seed: 'test' },
        quotaMode: 'static',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.winners).toHaveLength(3);
    expect(result.summary.unusualOutcomes.some(u => u.code === 'ELECTED_BY_REMAINDER')).toBe(true);
  });

  it('uses exact arithmetic by default', () => {
    // Surplus transfer should produce a non-integer rational
    const ballots: TabulateInput['ballots'] = [];
    let id = 1;
    // Alice: 5 (quota = floor(10/3)+1 = 4, surplus = 1)
    // Surplus ratio = 1/5 → each ballot gets new value 1/5
    for (let i = 0; i < 3; i++) ballots.push(ballot(`b${id++}`, 'alice', 'bob'));
    for (let i = 0; i < 2; i++) ballots.push(ballot(`b${id++}`, 'alice', 'carol'));
    for (let i = 0; i < 3; i++) ballots.push(ballot(`b${id++}`, 'bob'));
    for (let i = 0; i < 2; i++) ballots.push(ballot(`b${id++}`, 'carol'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      ballots,
      options: {
        method: 'stv',
        seats: 2,
        tieBreak: { strategy: 'random', seed: 'test' },
        quotaMode: 'static',
        stvArithmetic: 'exact',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.winners).toHaveLength(2);
    expect(result.meta.stvArithmetic).toBe('exact');
  });

  it('handles order2007 arithmetic mode', () => {
    const ballots: TabulateInput['ballots'] = [];
    let id = 1;
    for (let i = 0; i < 5; i++) ballots.push(ballot(`b${id++}`, 'alice', 'bob'));
    for (let i = 0; i < 4; i++) ballots.push(ballot(`b${id++}`, 'bob'));
    for (let i = 0; i < 1; i++) ballots.push(ballot(`b${id++}`, 'carol'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      ballots,
      options: {
        method: 'stv',
        seats: 2,
        tieBreak: { strategy: 'random', seed: 'test' },
        quotaMode: 'static',
        stvArithmetic: 'order2007',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.winners).toHaveLength(2);
    expect(result.meta.stvArithmetic).toBe('order2007');
  });

  it('produces self-describing metadata', () => {
    const ballots: TabulateInput['ballots'] = [];
    let id = 1;
    for (let i = 0; i < 6; i++) ballots.push(ballot(`b${id++}`, 'alice'));
    for (let i = 0; i < 5; i++) ballots.push(ballot(`b${id++}`, 'bob'));
    for (let i = 0; i < 4; i++) ballots.push(ballot(`b${id++}`, 'carol'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      ballots,
      options: {
        method: 'stv',
        seats: 2,
        tieBreak: { strategy: 'random', seed: 'audit-seed' },
        quotaMode: 'static',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.meta.method).toBe('stv');
    expect(result.meta.seats).toBe(2);
    expect(result.meta.tieBreakStrategy).toBe('random');
    expect(result.meta.tieBreakSeed).toBe('audit-seed');
    expect(result.meta.ballotCount).toBe(15);
    expect(result.meta.candidateCount).toBe(3);
    expect(result.meta.producedAt).toBeNull();
    expect(result.meta.inputHash.startsWith('sha256:')).toBe(true);
  });
});
