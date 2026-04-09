import { describe, it, expect } from 'vitest';
import { tabulate } from '../src/tabulate.js';
import type { TabulateInput } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkInput(overrides: Partial<TabulateInput> = {}): TabulateInput {
  return {
    schemaVersion: 1,
    candidates: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
      { id: 'carol', name: 'Carol' },
    ],
    ballots: [],
    options: {
      method: 'irv',
      seats: 1,
      tieBreak: { strategy: 'random', seed: 'test-seed' },
      quotaMode: 'dynamic',
      writeInsAllowed: false,
    },
    ...overrides,
  };
}

function ballot(id: string, ...ranking: string[]) {
  return { id, rankings: ranking.map(cid => ({ type: 'candidate' as const, id: cid })) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('IRV tabulation', () => {
  it('elects the majority winner in round 1', () => {
    // Alice: 3, Bob: 1, Carol: 1 → Alice wins (threshold = floor(5/2)+1 = 3)
    const input = mkInput({
      ballots: [
        ballot('b1', 'alice'),
        ballot('b2', 'alice'),
        ballot('b3', 'alice'),
        ballot('b4', 'bob'),
        ballot('b5', 'carol'),
      ],
    });
    const result = tabulate(input);
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0]?.candidateId).toBe('alice');
    expect(result.rounds).toHaveLength(1);
    expect(result.summary.seatsFilled).toBe(1);
  });

  it('transfers votes and elects via transfer (classic example)', () => {
    // Alice: 2, Bob: 2, Carol: 1 → Carol eliminated, Carol's vote transfers to Alice
    // Round 1: Alice 2, Bob 2, Carol 1 — threshold = floor(5/2)+1 = 3 → no winner
    // Carol eliminated. Carol's voter prefers Alice.
    // Round 2: Alice 3, Bob 2 — threshold = floor(4/2)+1 = 3 → Alice wins!
    const input = mkInput({
      ballots: [
        ballot('b1', 'alice', 'bob'),
        ballot('b2', 'alice', 'bob'),
        ballot('b3', 'bob', 'alice'),
        ballot('b4', 'bob', 'alice'),
        ballot('b5', 'carol', 'alice'),
      ],
    });
    const result = tabulate(input);
    expect(result.winners[0]?.candidateId).toBe('alice');
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.eliminated).toEqual(['carol']);
    expect(result.rounds[1]?.elected).toEqual(['alice']);
  });

  it('handles ballot exhaustion gracefully', () => {
    // Alice: 2, Bob: 2, Carol: 1 (only ranks Carol) → Carol out, 1 ballot exhausted
    // Round 2: Alice 2, Bob 2 — threshold floor(4/2)+1 = 3 — still no winner
    // But now with just 4 active, threshold drops to 3. Still no winner. Bob or Alice eliminated.
    // One of them then wins by remainder.
    const input = mkInput({
      ballots: [
        ballot('b1', 'alice'),
        ballot('b2', 'alice'),
        ballot('b3', 'bob'),
        ballot('b4', 'bob'),
        ballot('b5', 'carol'), // exhausts after Carol eliminated
      ],
      options: {
        method: 'irv',
        seats: 1,
        tieBreak: { strategy: 'provided', order: ['bob', 'alice', 'carol'] },
        quotaMode: 'dynamic',
        writeInsAllowed: false,
      },
    });
    const result = tabulate(input);
    // With provided order, bob is eliminated first (later in order = eliminated first)
    // So carol → exhausted, bob → eliminated → alice wins
    expect(result.winners).toHaveLength(1);
  });

  it('implements the spec worked example: Bob wins despite Alice leading', () => {
    // Spec Section 6.9: 5 candidates, 100 ballots, dynamic quota
    // Alice: 35, Bob: 28, Carol: 16, Dave: 13, Eve: 8
    // Eve eliminated → 6 to Bob, 1 to Carol, 1 exhausted
    // Dave eliminated → 9 to Bob, 3 to Carol, 1 exhausted
    // Carol eliminated → 16 to Bob, 4 exhausted
    // Bob wins round 4 with 59 votes

    const ballots: TabulateInput['ballots'] = [];
    let bid = 1;

    // Alice: 35 first-choice ballots (no transfer to anyone useful)
    for (let i = 0; i < 35; i++) ballots.push(ballot(`b${bid++}`, 'alice'));

    // Bob: 28 first-choice
    for (let i = 0; i < 28; i++) ballots.push(ballot(`b${bid++}`, 'bob'));

    // Carol: 16 first-choice
    for (let i = 0; i < 16; i++) ballots.push(ballot(`b${bid++}`, 'carol'));

    // Dave: 13 first-choice (transfers: 9→Bob, 3→Carol, 1 exhausted)
    for (let i = 0; i < 9; i++) ballots.push(ballot(`b${bid++}`, 'dave', 'bob'));
    for (let i = 0; i < 3; i++) ballots.push(ballot(`b${bid++}`, 'dave', 'carol'));
    ballots.push(ballot(`b${bid++}`, 'dave')); // exhausts

    // Eve: 8 first-choice (transfers: 6→Bob, 1→Carol, 1 exhausted)
    for (let i = 0; i < 6; i++) ballots.push(ballot(`b${bid++}`, 'eve', 'bob'));
    ballots.push(ballot(`b${bid++}`, 'eve', 'carol'));
    ballots.push(ballot(`b${bid++}`, 'eve')); // exhausts

    // Carol's eliminated ballots: 16→Bob, 4 exhausted (but Carol has 16 + 3 + 1 = 20 by that point)
    // We need Carol's voters to transfer to Bob. Adjust Carol's first-choice ballots:
    // Actually Carol starts with 16, gains 1 from Eve + 3 from Dave = 20 total by round 3
    // When Carol is eliminated, her 20 ballots: 16 → Bob, 4 exhaust
    // So we need to set Carol's first-choice ballots to prefer Bob:
    // Re-assign: replace Carol's 16 first-choice ballots with 12 preferring Bob + 4 exhaust-only
    // Reset and redo Carol:
    // Remove last 16 carol ballots and re-add
    const carolIdx = 28 + 28; // after alice35 + bob28... let me redo this properly

    // Let's use a simple approach: just set the ballot array directly
    const properBallots: TabulateInput['ballots'] = [];
    let id = 1;

    // Alice: 35 (no useful transfer — she never gets eliminated in this example)
    for (let i = 0; i < 35; i++) properBallots.push(ballot(`b${id++}`, 'alice'));
    // Bob: 28
    for (let i = 0; i < 28; i++) properBallots.push(ballot(`b${id++}`, 'bob'));
    // Carol: 16 first-choice → Bob (then Alice doesn't get eliminated so these transfer to Bob)
    for (let i = 0; i < 12; i++) properBallots.push(ballot(`b${id++}`, 'carol', 'bob'));
    for (let i = 0; i < 4; i++) properBallots.push(ballot(`b${id++}`, 'carol')); // exhaust
    // Dave: 13 (9→Bob, 3→Carol, 1 exhaust)
    for (let i = 0; i < 9; i++) properBallots.push(ballot(`b${id++}`, 'dave', 'bob'));
    for (let i = 0; i < 3; i++) properBallots.push(ballot(`b${id++}`, 'dave', 'carol', 'bob'));
    properBallots.push(ballot(`b${id++}`, 'dave')); // exhaust
    // Eve: 8 (6→Bob, 1→Carol, 1 exhaust)
    for (let i = 0; i < 6; i++) properBallots.push(ballot(`b${id++}`, 'eve', 'bob'));
    properBallots.push(ballot(`b${id++}`, 'eve', 'carol', 'bob'));
    properBallots.push(ballot(`b${id++}`, 'eve')); // exhaust

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
        { id: 'dave', name: 'Dave' },
        { id: 'eve', name: 'Eve' },
      ],
      ballots: properBallots,
      options: {
        method: 'irv',
        seats: 1,
        tieBreak: { strategy: 'random', seed: 'demo' },
        quotaMode: 'dynamic',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    expect(result.winners[0]?.candidateId).toBe('bob');
    expect(result.rounds.length).toBeGreaterThan(1);
    // Alice should have been active in all rounds until the last
    const lastRound = result.rounds[result.rounds.length - 1]!;
    expect(lastRound.elected).toContain('bob');
  });

  it('handles last remaining candidate winning without majority (WINNER_WITHOUT_MAJORITY)', () => {
    // 2 candidates, all ballots rank only one each → after one eliminated, last wins without majority
    const input = mkInput({
      candidates: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
      ballots: [
        ballot('b1', 'alice'), // exhausts after alice eliminated
        ballot('b2', 'bob'),
        ballot('b3', 'bob'),
        ballot('b4', 'alice'), // exhausts after alice eliminated
      ],
      options: {
        method: 'irv',
        seats: 1,
        tieBreak: { strategy: 'provided', order: ['bob', 'alice'] },
        quotaMode: 'static', // static threshold: floor(4/2)+1=3, alice never reaches it
        writeInsAllowed: false,
      },
    });
    const result = tabulate(input);
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0]?.candidateId).toBe('bob');
  });

  it('applies batch elimination', () => {
    // 4 candidates: Alice 10, Bob 8, Carol 3, Dave 2 → total 23, threshold=12
    // No one reaches threshold. Batch: Carol(3)+Dave(2)=5 < Bob(8) → batch eliminate Carol and Dave
    const ballots: TabulateInput['ballots'] = [];
    let id = 1;
    for (let i = 0; i < 10; i++) ballots.push(ballot(`b${id++}`, 'alice'));
    for (let i = 0; i < 8; i++) ballots.push(ballot(`b${id++}`, 'bob'));
    for (let i = 0; i < 3; i++) ballots.push(ballot(`b${id++}`, 'carol', 'alice'));
    for (let i = 0; i < 2; i++) ballots.push(ballot(`b${id++}`, 'dave', 'alice'));

    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
        { id: 'dave', name: 'Dave' },
      ],
      ballots,
      options: {
        method: 'irv',
        seats: 1,
        tieBreak: { strategy: 'random', seed: 'test' },
        quotaMode: 'dynamic',
        writeInsAllowed: false,
      },
    };

    const result = tabulate(input);
    // The first elimination round should batch-eliminate Carol and Dave
    const firstRound = result.rounds[0]!;
    expect(firstRound.eliminated).toContain('carol');
    expect(firstRound.eliminated).toContain('dave');
    expect(firstRound.unusualOutcomes?.some(u => u.code === 'BATCH_ELIMINATION_APPLIED')).toBe(true);
  });

  it('produces deterministic results with random seed', () => {
    const input = mkInput({
      candidates: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
      ballots: [
        ballot('b1', 'alice'),
        ballot('b2', 'bob'),
      ],
    });
    const r1 = tabulate(input);
    const r2 = tabulate(input);
    expect(r1.winners[0]?.candidateId).toBe(r2.winners[0]?.candidateId);
    expect(r1.meta.inputHash).toBe(r2.meta.inputHash);
  });

  it('input hash changes when ballots change', () => {
    const input1 = mkInput({
      ballots: [ballot('b1', 'alice'), ballot('b2', 'alice'), ballot('b3', 'bob')],
    });
    const input2 = mkInput({
      ballots: [ballot('b1', 'alice'), ballot('b2', 'bob'), ballot('b3', 'bob')],
    });
    const r1 = tabulate(input1);
    const r2 = tabulate(input2);
    expect(r1.meta.inputHash).not.toBe(r2.meta.inputHash);
  });

  it('generates an audit log without throwing', async () => {
    const { formatAuditLog } = await import('../src/audit-log.js');
    const input = mkInput({
      ballots: [
        ballot('b1', 'alice', 'bob'),
        ballot('b2', 'bob', 'alice'),
        ballot('b3', 'alice'),
      ],
    });
    const result = tabulate(input);
    const log = formatAuditLog(result);
    expect(typeof log).toBe('string');
    expect(log).toContain('ROUND 1');
    expect(log.length).toBeGreaterThan(100);
  });

  it('meta.producedAt is null (purity contract)', () => {
    const input = mkInput({ ballots: [ballot('b1', 'alice'), ballot('b2', 'alice'), ballot('b3', 'bob')] });
    const result = tabulate(input);
    expect(result.meta.producedAt).toBeNull();
  });
});
