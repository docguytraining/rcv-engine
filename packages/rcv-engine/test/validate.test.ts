import { describe, it, expect } from 'vitest';
import { validateInput, resolveInput } from '../src/validate.js';
import { ValidationError } from '../src/errors.js';

// Minimal valid input for tests
function minimalInput() {
  return {
    schemaVersion: 1 as const,
    candidates: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    ballots: [
      { id: 'b1', rankings: [{ type: 'candidate' as const, id: 'alice' }] },
      { id: 'b2', rankings: [{ type: 'candidate' as const, id: 'bob' }] },
      { id: 'b3', rankings: [{ type: 'candidate' as const, id: 'alice' }] },
    ],
    options: {
      method: 'irv' as const,
      seats: 1,
      tieBreak: { strategy: 'random' as const, seed: 'test-seed' },
      quotaMode: 'dynamic' as const,
      writeInsAllowed: false,
    },
  };
}

describe('validateInput', () => {
  it('accepts a minimal valid input', () => {
    const result = validateInput(minimalInput());
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = validateInput('not an object');
    expect(result.ok).toBe(false);
  });

  it('requires schemaVersion', () => {
    const input = { ...minimalInput() } as Record<string, unknown>;
    delete input['schemaVersion'];
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'SCHEMA_VERSION_MISSING')).toBe(true);
    }
  });

  it('rejects schemaVersion !== 1', () => {
    const input = { ...minimalInput(), schemaVersion: 2 } as unknown;
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'SCHEMA_VERSION_INVALID')).toBe(true);
    }
  });

  it('rejects unknown top-level field', () => {
    const input = { ...minimalInput(), unknownField: 'oops' } as unknown;
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'UNKNOWN_FIELD')).toBe(true);
    }
  });

  it('rejects empty candidates', () => {
    const input = { ...minimalInput(), candidates: [] };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'EMPTY_CANDIDATES')).toBe(true);
    }
  });

  it('rejects duplicate candidate IDs', () => {
    const input = {
      ...minimalInput(),
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'alice', name: 'Alice 2' },
      ],
    };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'DUPLICATE_CANDIDATE_ID')).toBe(true);
    }
  });

  it('rejects empty ballot rankings', () => {
    const input = {
      ...minimalInput(),
      ballots: [{ id: 'b1', rankings: [] }],
    };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'EMPTY_BALLOT_RANKINGS')).toBe(true);
    }
  });

  it('rejects ballot referencing unknown candidate', () => {
    const input = {
      ...minimalInput(),
      ballots: [{ id: 'b1', rankings: [{ type: 'candidate' as const, id: 'unknown-id' }] }],
    };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'UNKNOWN_CANDIDATE_REF')).toBe(true);
    }
  });

  it('rejects IRV with seats !== 1', () => {
    const input = { ...minimalInput(), options: { ...minimalInput().options, seats: 2 } };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'IRV_SEATS_MUST_BE_ONE')).toBe(true);
    }
  });

  it('rejects write-in rankings when writeInsAllowed is false', () => {
    const input = {
      ...minimalInput(),
      ballots: [{ id: 'b1', rankings: [{ type: 'writeIn' as const, name: 'Mickey Mouse' }] }],
    };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'WRITE_IN_NOT_ALLOWED')).toBe(true);
    }
  });

  it('rejects missing tieBreak', () => {
    const input = { ...minimalInput() };
    const { tieBreak: _tb, ...optsWithoutTieBreak } = input.options;
    const result = validateInput({ ...input, options: optsWithoutTieBreak });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'REQUIRED_FIELD_MISSING')).toBe(true);
    }
  });

  it('accepts provided tieBreak with complete order', () => {
    const input = {
      ...minimalInput(),
      options: {
        ...minimalInput().options,
        tieBreak: { strategy: 'provided' as const, order: ['alice', 'bob'] },
      },
    };
    const result = validateInput(input);
    expect(result.ok).toBe(true);
  });

  it('rejects provided tieBreak with incomplete order', () => {
    const input = {
      ...minimalInput(),
      options: {
        ...minimalInput().options,
        tieBreak: { strategy: 'provided' as const, order: ['alice'] }, // missing bob
      },
    };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'TIE_BREAK_ORDER_INCOMPLETE')).toBe(true);
    }
  });

  it('rejects duplicate ballot IDs', () => {
    const input = {
      ...minimalInput(),
      ballots: [
        { id: 'b1', rankings: [{ type: 'candidate' as const, id: 'alice' }] },
        { id: 'b1', rankings: [{ type: 'candidate' as const, id: 'bob' }] },
      ],
    };
    const result = validateInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.code === 'DUPLICATE_BALLOT_ID')).toBe(true);
    }
  });
});

describe('resolveInput', () => {
  it('resolves a valid minimal input', () => {
    const resolved = resolveInput(minimalInput());
    expect(resolved.candidates).toHaveLength(2);
    expect(resolved.ballots).toHaveLength(3);
    expect(resolved.synthesizedWriteIns).toHaveLength(0);
  });

  it('throws ValidationError on invalid input', () => {
    expect(() => resolveInput({ schemaVersion: 2 })).toThrow(ValidationError);
  });

  it('synthesizes write-in candidate for unaliased write-in', () => {
    const input = {
      schemaVersion: 1 as const,
      candidates: [{ id: 'alice', name: 'Alice' }],
      ballots: [
        {
          id: 'b1',
          rankings: [{ type: 'writeIn' as const, name: 'Mickey Mouse' }],
        },
      ],
      options: {
        method: 'irv' as const,
        seats: 1,
        tieBreak: { strategy: 'random' as const, seed: 'seed' },
        quotaMode: 'dynamic' as const,
        writeInsAllowed: true,
      },
    };
    const resolved = resolveInput(input);
    expect(resolved.synthesizedWriteIns).toHaveLength(1);
    expect(resolved.synthesizedWriteIns[0]?.rawString).toBe('Mickey Mouse');
    expect(resolved.synthesizedWriteIns[0]?.ballotCount).toBe(1);
    // The ballot ranking should have been rewritten to the synthesized candidate ID
    expect(resolved.ballots[0]?.rankings[0]?.startsWith('writein:literal:')).toBe(true);
  });

  it('resolves aliased write-ins to canonical candidate', () => {
    const input = {
      schemaVersion: 1 as const,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'writein:mickey', name: 'Mickey Mouse', isWriteIn: true },
      ],
      ballots: [
        {
          id: 'b1',
          rankings: [{ type: 'writeIn' as const, name: 'mickey mouse' }],
        },
      ],
      writeInAliases: { 'mickey mouse': 'writein:mickey' },
      options: {
        method: 'irv' as const,
        seats: 1,
        tieBreak: { strategy: 'random' as const, seed: 'seed' },
        quotaMode: 'dynamic' as const,
        writeInsAllowed: true,
      },
    };
    const resolved = resolveInput(input);
    expect(resolved.ballots[0]?.rankings[0]).toBe('writein:mickey');
    expect(resolved.synthesizedWriteIns).toHaveLength(0);
  });
});
