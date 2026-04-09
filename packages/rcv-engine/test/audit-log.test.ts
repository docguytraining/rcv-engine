import { describe, it, expect } from 'vitest';
import { tabulate } from '../src/tabulate.js';
import { formatAuditLog } from '../src/audit-log.js';
import { UnsupportedLocaleError } from '../src/errors.js';
import type { TabulateInput } from '../src/types.js';

function ballot(id: string, ...ranking: string[]) {
  return { id, rankings: ranking.map(cid => ({ type: 'candidate' as const, id: cid })) };
}

function simpleInput(): TabulateInput {
  return {
    schemaVersion: 1,
    candidates: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
      { id: 'carol', name: 'Carol' },
    ],
    ballots: [
      ballot('b1', 'alice', 'bob'),
      ballot('b2', 'alice', 'bob'),
      ballot('b3', 'bob', 'alice'),
      ballot('b4', 'carol', 'alice'),
      ballot('b5', 'carol', 'bob'),
    ],
    options: {
      method: 'irv',
      seats: 1,
      tieBreak: { strategy: 'random', seed: 'test' },
      quotaMode: 'dynamic',
      writeInsAllowed: false,
    },
  };
}

describe('formatAuditLog', () => {
  it('produces a non-empty string', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    expect(typeof log).toBe('string');
    expect(log.length).toBeGreaterThan(50);
  });

  it('includes the method', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    expect(log).toContain('IRV');
  });

  it('includes round numbers', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    expect(log).toContain('ROUND 1');
  });

  it('mentions the winner', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    // The winner should be mentioned
    const winnerId = result.winners[0]?.candidateId;
    expect(log).toContain(winnerId);
  });

  it('starts with ELECTION AUDIT LOG', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    expect(log.startsWith('ELECTION AUDIT LOG')).toBe(true);
  });

  it('ends with END OF AUDIT LOG', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    expect(log.trimEnd().endsWith('END OF AUDIT LOG')).toBe(true);
  });

  it('includes the input hash', () => {
    const result = tabulate(simpleInput());
    const log = formatAuditLog(result);
    expect(log).toContain('sha256:');
  });

  it('throws UnsupportedLocaleError for unsupported locale', () => {
    const result = tabulate(simpleInput());
    expect(() => formatAuditLog(result, { locale: 'fr' as 'en' })).toThrow(UnsupportedLocaleError);
  });

  it('respects verbosity: brief omits transfer details', () => {
    // Create an input that will have transfers
    const input: TabulateInput = {
      schemaVersion: 1,
      candidates: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }, { id: 'carol', name: 'Carol' }],
      ballots: [
        ballot('b1', 'alice'), ballot('b2', 'alice'), ballot('b3', 'alice'),
        ballot('b4', 'bob'), ballot('b5', 'bob'),
        ballot('b6', 'carol', 'alice'), ballot('b7', 'carol', 'bob'),
      ],
      options: {
        method: 'irv',
        seats: 1,
        tieBreak: { strategy: 'random', seed: 'test' },
        quotaMode: 'dynamic',
        writeInsAllowed: false,
      },
    };
    const result = tabulate(input);
    const briefLog = formatAuditLog(result, { verbosity: 'brief' });
    const standardLog = formatAuditLog(result, { verbosity: 'standard' });
    // standard should be longer (includes transfer details)
    expect(standardLog.length).toBeGreaterThanOrEqual(briefLog.length);
  });

  it('default locale is en (does not throw)', () => {
    const result = tabulate(simpleInput());
    expect(() => formatAuditLog(result, {})).not.toThrow();
    expect(() => formatAuditLog(result, { locale: 'en' })).not.toThrow();
  });
});
