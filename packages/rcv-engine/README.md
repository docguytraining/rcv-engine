# rcv-engine

A zero-dependency TypeScript library for tabulating ranked-choice elections. Supports **Instant Runoff Voting (IRV)** and **Single Transferable Vote (STV)**, producing a complete, deterministic, independently auditable result.

[![npm version](https://img.shields.io/npm/v/rcv-engine)](https://www.npmjs.com/package/rcv-engine)
[![license: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue)](https://github.com/docguytraining/rcv-engine/blob/main/LICENSE)
[![CI](https://github.com/docguytraining/rcv-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/docguytraining/rcv-engine/actions/workflows/ci.yml)

---

## Why open source?

Elections are decisions that affect people's lives. The code that counts ballots should be publicly readable, independently verifiable, and free of black boxes. `rcv-engine` is published under AGPL v3 so that anyone — voters, administrators, independent auditors — can read the source, run the tests, and verify that the algorithm works exactly as documented.

---

## Install

```bash
npm install rcv-engine
```

Requires Node.js ≥ 20. No runtime dependencies.

---

## Quick start

```typescript
import { tabulate, formatAuditLog } from 'rcv-engine';

const result = tabulate({
  schemaVersion: 1,
  candidates: [
    { id: 'alice', name: 'Alice' },
    { id: 'bob',   name: 'Bob'   },
    { id: 'carol', name: 'Carol' },
  ],
  ballots: [
    { id: 'b1', rankings: [{ type: 'candidate', id: 'alice' }, { type: 'candidate', id: 'bob'   }] },
    { id: 'b2', rankings: [{ type: 'candidate', id: 'alice' }, { type: 'candidate', id: 'carol' }] },
    { id: 'b3', rankings: [{ type: 'candidate', id: 'bob'   }, { type: 'candidate', id: 'alice' }] },
    { id: 'b4', rankings: [{ type: 'candidate', id: 'carol' }, { type: 'candidate', id: 'bob'   }] },
    { id: 'b5', rankings: [{ type: 'candidate', id: 'carol' }, { type: 'candidate', id: 'alice' }] },
  ],
  options: {
    method: 'irv',
    seats: 1,
    tieBreak: { strategy: 'random', seed: '2024-election-seed' },
    quotaMode: 'dynamic',
    writeInsAllowed: false,
  },
});

console.log(result.winners[0].candidateName); // 'Alice'
console.log(formatAuditLog(result));           // plain-text round-by-round narrative
```

---

## API

### `tabulate(input)`

The main entry point. Pure function — no I/O, no clock. Given identical input it always produces identical output.

```typescript
import { tabulate } from 'rcv-engine';
import type { TabulateInput, TabulateResult } from 'rcv-engine';

const result: TabulateResult = tabulate(input);
```

### `validateInput(input)`

Validates a raw input object without running the election. Returns `{ ok: true }` or `{ ok: false, errors }`. Use this to give users early feedback before submitting ballots.

```typescript
import { validateInput } from 'rcv-engine';

const validation = validateInput(rawInput);
if (!validation.ok) {
  console.error(validation.errors);
}
```

### `hashInput(input)`

Returns a `sha256:<hex>` digest of the canonical JSON serialization of the input. Two inputs that differ in any ballot, candidate, or option produce different hashes. Use this to prove the input was not altered after tabulation.

```typescript
import { hashInput } from 'rcv-engine';

const hash = hashInput(input);
// compare with result.meta.inputHash to verify integrity
```

### `formatAuditLog(result, options?)`

Formats the result as a plain-text English narrative covering method, quota, round-by-round tallies, transfers, tie-break events, and input hash.

```typescript
import { formatAuditLog } from 'rcv-engine';

const log = formatAuditLog(result, {
  verbosity: 'detailed',   // 'brief' | 'standard' | 'detailed'
  includeTransfers: true,
});
```

---

## Input format

```typescript
interface TabulateInput {
  schemaVersion: 1;
  candidates: { id: string; name: string; isWriteIn?: boolean }[];
  ballots: {
    id: string;
    rankings: (
      | { type: 'candidate'; id: string   }
      | { type: 'writeIn';   name: string }
    )[];
  }[];
  writeInAliases?: Record<string, string>; // raw write-in string → candidate id
  options: {
    method: 'irv' | 'stv';
    seats: number;                          // 1 for IRV
    tieBreak:
      | { strategy: 'random';        seed: string    }
      | { strategy: 'previousRound'                  }
      | { strategy: 'provided';      order: string[] };
    quotaMode: 'dynamic' | 'static';
    writeInsAllowed: boolean;
    trackBallotTransfers?: boolean;         // include per-ballot transfer detail
    stvArithmetic?: 'exact' | 'order2007'; // STV only; default 'exact'
  };
}
```

---

## Supported methods

**IRV (Instant Runoff Voting)** — single-winner. Candidates are successively eliminated from the bottom until one candidate holds a majority of active votes. Includes batch elimination optimization to safely remove multiple candidates in one round when their combined total cannot affect the outcome.

**STV (Single Transferable Vote)** — multi-winner. Uses the Weighted Inclusive Gregory (WIG) method for surplus transfers. Supports both exact bigint arithmetic (default) and Scottish Local Government Elections Order 2007 fixed-point arithmetic (`stvArithmetic: 'order2007'`).

---

## Tie-breaking

| Strategy | Behavior |
|---|---|
| `random` | Seeded deterministic PRNG (xmur3 + mulberry32). Fully reproducible — anyone with the seed can verify the draw. |
| `previousRound` | Walks back through prior rounds and selects the candidate with the lowest historical tally. Throws `UnresolvableTieError` if no round discriminates. |
| `provided` | Caller supplies an explicit priority order (e.g. alphabetical, a pre-announced draw). |

---

## Auditing a result

Every result carries `meta.inputHash` — a SHA-256 of the canonical input. To independently verify an election:

```typescript
import { tabulate, hashInput } from 'rcv-engine';

// 1. Confirm the ballots weren't altered after tabulation
assert(hashInput(originalInput) === publishedResult.meta.inputHash);

// 2. Re-run and compare
assert(deepEqual(tabulate(originalInput), publishedResult));
```

See the [Auditing Guide](https://github.com/docguytraining/rcv-engine/blob/main/packages/rcv-engine/docs/auditing.md) for a complete walkthrough, including how to reproduce tie-break decisions and verify STV transfer values.

---

## Error handling

```typescript
import {
  RcvEngineError,
  ValidationError,
  UnresolvableTieError,
} from 'rcv-engine';

try {
  const result = tabulate(input);
} catch (err) {
  if (err instanceof ValidationError) {
    // malformed input — err.issues contains field-level detail
  } else if (err instanceof UnresolvableTieError) {
    // previousRound strategy couldn't break a tie — consider 'random' instead
  } else if (err instanceof RcvEngineError) {
    // other engine error
  }
}
```

---

## Algorithm reference

See the [Algorithm Reference](https://github.com/docguytraining/rcv-engine/blob/main/packages/rcv-engine/docs/algorithm.md) for the normative description of IRV and STV, including worked examples, quota calculations, surplus transfer math, and tie-break logic.

---

## License

GNU Affero General Public License v3.0 — see [LICENSE](https://github.com/docguytraining/rcv-engine/blob/main/LICENSE).

The AGPL ensures that anyone who runs a modified version of this engine as a network service must also publish their modifications. This keeps the code that counts votes auditable regardless of who deploys it.

If you need a commercial license without AGPL obligations, contact the author.
