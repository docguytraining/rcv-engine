# rcv-engine Auditing Guide

**Package:** `rcv-engine` v1.0.0  
**Audience:** Election administrators, independent auditors, and integrators who need to verify tabulation results.

---

## 1. Purpose

`rcv-engine` is designed to produce results that are **independently verifiable**. Any party with access to the original ballots and the election configuration can re-run the engine and obtain byte-identical output. This guide explains how to perform that verification and how to interpret every audit-relevant field in the result.

---

## 2. Verifying a Result End-to-End

### 2.1 Reproduce the tabulation

Call `tabulate()` with the same `TabulateInput` that produced the original result. Because the engine is a **pure function** (no I/O, no clock, no external state), the output is deterministic:

```typescript
import { tabulate } from 'rcv-engine';

const input = /* the original TabulateInput */;
const result = tabulate(input);
```

If the input is identical the outputs will be identical — same winners, same round tallies, same tie-break draws, same input hash.

### 2.2 Confirm input integrity with the hash

`result.meta.inputHash` is a SHA-256 digest of the **canonical JSON** serialization of the input (RFC 8785: keys sorted lexicographically, no whitespace, minimal string escaping). It uniquely identifies the input regardless of key ordering.

```typescript
import { hashInput } from 'rcv-engine';

const hash = hashInput(originalInput);
// compare with result.meta.inputHash
console.assert(hash === result.meta.inputHash, 'Input has been altered');
```

Two inputs that differ in any ballot, any candidate name, any option value, or any schema field will produce different hashes. Two inputs that are semantically identical but differ only in JSON key ordering produce the **same** hash.

### 2.3 Generate a human-readable audit log

```typescript
import { formatAuditLog } from 'rcv-engine';

const log = formatAuditLog(result, { verbosity: 'detailed', includeTransfers: true });
console.log(log);
// or write to a file for archiving
```

The audit log is a plain-text English narrative that covers:

- Election metadata (method, seats, threshold mode, tie-break seed, engine version, input hash)
- Winners
- Any unusual outcomes (batch eliminations, exhausted ballots, etc.)
- Round-by-round tally, threshold, who was eliminated or elected, and vote transfers
- Tie-break events with their draw indices (see Section 4)

---

## 3. Interpreting `result.meta`

| Field | Type | Description |
|---|---|---|
| `engineVersion` | `string` | Semver of `rcv-engine`. A given major version guarantees byte-identical output for byte-identical inputs. |
| `inputHash` | `string` | `"sha256:<hex>"` — SHA-256 of the canonical JSON of the input. Use to confirm the ballots were not altered. |
| `producedAt` | `null` | Always `null`. The engine is pure and has no clock. Callers who need a timestamp must add it at the application layer. |
| `totalBallots` | `number` | Count of ballots passed in. |
| `writeInAliasesUsed` | `Record<string, string>` | Raw write-in strings mapped to the declared candidate IDs they resolved to (via `writeInAliases`). |
| `synthesizedWriteIns` | array | Write-in strings that had no alias entry; each gets a synthesized candidate with a deterministic ID. |

### 3.1 Synthesized write-in candidates

When a write-in string is not in `writeInAliases`, the engine creates a candidate with ID:

```
writein:literal:<first-12-hex-chars-of-SHA256(rawString)>
```

The SHA-256 is of the raw UTF-8 bytes of the write-in string. Auditors can independently compute this:

```typescript
import { createHash } from 'node:crypto';

function synthesizedId(rawName: string): string {
  const hex = createHash('sha256').update(rawName, 'utf8').digest('hex');
  return `writein:literal:${hex.slice(0, 12)}`;
}
```

All synthesized candidates appear in `result.meta.synthesizedWriteIns` with their raw name and computed ID.

---

## 4. Reproducing Tie-Break Decisions

### 4.1 `random` strategy

When `tieBreak.strategy === 'random'`, the engine uses a seeded PRNG:

1. `tieBreak.seed` (a string) is hashed to a 32-bit integer using the **xmur3** algorithm.
2. A **mulberry32** generator is seeded from that integer.
3. Each tie-break invocation draws the **next** number in the sequence. The PRNG state is shared across all tie-breaks within a single `tabulate()` call.

Each tie-break event in `round.tieBreakApplied` records:

| Field | Description |
|---|---|
| `strategy` | `"random"` |
| `tiedCandidateIds` | The candidates that were tied |
| `selectedCandidateId` | The candidate selected for elimination |
| `drawIndex` | The zero-based sequence number of the draw (0 = first draw, 1 = second, etc.) |
| `seed` | The seed string used |

To verify a specific draw, re-run `tabulate()` with the same input (including the same seed). The `drawIndex` lets auditors confirm which draw in the sequence produced the outcome.

### 4.2 `previousRound` strategy

The engine walks backwards through prior rounds comparing tallies of the tied candidates. The candidate with the lowest tally in the **most recent round that discriminates between them** is eliminated.

`round.tieBreakApplied` records:

| Field | Description |
|---|---|
| `strategy` | `"previousRound"` |
| `tiedCandidateIds` | The candidates that were tied |
| `selectedCandidateId` | The candidate eliminated |
| `discriminatingRound` | The round number that provided the discriminating tally |

Auditors can verify by examining `result.rounds[discriminatingRound - 1].tally`.

If no round discriminates (all candidates were tied in every prior round), the engine throws `UnresolvableTieError` and no result is produced.

### 4.3 `provided` strategy

The caller supplies an `order` array. When a tie occurs, the candidate who appears **latest** in the array is eliminated. This models a pre-announced priority ordering (alphabetical, coin-toss order, draw order, etc.).

`round.tieBreakApplied` records:

| Field | Description |
|---|---|
| `strategy` | `"provided"` |
| `tiedCandidateIds` | The candidates that were tied |
| `selectedCandidateId` | The candidate eliminated (latest position in the order array) |
| `order` | The full provided order array |

---

## 5. Interpreting Rounds

Each element of `result.rounds` represents one counting round:

| Field | Description |
|---|---|
| `roundNumber` | 1-based sequential round number |
| `tally` | Map of candidate ID → `Rational` vote total at the start of this round |
| `threshold` | The majority threshold (IRV) or Droop quota (STV) in effect for this round |
| `elected` | Candidate IDs elected this round (empty if none) |
| `eliminated` | Candidate IDs eliminated this round (empty if none) |
| `transfers.aggregate` | Summarized vote flows: who transferred to whom, and how many ballots (or weighted ballot-value for STV) |
| `transfers.ballotLevel` | Per-ballot transfer detail (only present if `options.trackBallotTransfers` was `true`) |
| `exhaustedThisRound` | Ballots (or ballot-value) that became exhausted in this round |
| `exhaustedTotal` | Cumulative exhausted ballots (or ballot-value) through this round |
| `unusualOutcomes` | Array of `UnusualOutcome` objects if anything non-standard occurred |
| `tieBreakApplied` | Present if a tie-break was invoked in this round |

### 5.1 `Rational` fields

Tallies and thresholds are expressed as `{ numerator: string; denominator: string }` to preserve exact arithmetic across JSON serialization (JavaScript `bigint` cannot be JSON-stringified natively). For integer tallies, `denominator` is always `"1"`. For STV with `exact` mode, denominators may be non-trivial fractions.

To convert to a decimal for display:

```typescript
function rationalToDecimal(r: Rational, precision = 6): string {
  const n = BigInt(r.numerator);
  const d = BigInt(r.denominator);
  const whole = n / d;
  const frac = ((n - whole * d) * 10n ** BigInt(precision)) / d;
  return `${whole}.${frac.toString().padStart(precision, '0')}`;
}
```

### 5.2 Unusual outcomes

| Code | Meaning |
|---|---|
| `BATCH_ELIMINATION_APPLIED` | Multiple candidates eliminated together because their combined total was strictly less than the next-lowest candidate's total. Outcome-neutral — the same candidates would be eliminated eventually in separate rounds anyway. |
| `WINNER_WITHOUT_MAJORITY` | IRV only. The last remaining active candidate won without reaching the majority threshold (all other candidates were eliminated first). |
| `ALL_BALLOTS_EXHAUSTED` | All active ballots exhausted before a winner was determined. No winners are declared. |
| `ELECTED_BY_REMAINDER` | STV only. Remaining active candidates equal remaining seats; all are elected without further counting. |
| `INSUFFICIENT_CANDIDATES` | STV only. Fewer candidates remain than remaining seats; some seats are unfilled. |

---

## 6. STV-Specific Audit Points

### 6.1 Transfer values

In the Weighted Inclusive Gregory method, every ballot carries a `ballotValue` (initially 1). When a candidate is elected with a surplus:

```
surplus  = tally - quota
newValue = oldValue × (surplus / tally)
```

This reduced value is carried forward on every ballot that was on the elected candidate, and those ballots transfer to their next active preference. `transfers.aggregate[i].weight` records the transfer-value factor applied.

### 6.2 Arithmetic mode

`result.meta.arithmeticMode` is either `"exact"` (default bigint rational) or `"order2007"` (Scottish Order fixed-point).

- **`exact`**: All fractions computed precisely; no rounding at any step. Recommended for all new elections.
- **`order2007`**: Values scaled by 100,000 and **truncated** (not rounded) at each division, replicating the arithmetic specified verbatim in the Scottish Local Government Elections Order 2007. Use only when the result must be auditable against that Order. In rare elections with small margins, `order2007` and `exact` may elect different winners.

---

## 7. Archiving a Complete Audit Record

A complete audit package for an election should include:

1. **The original `TabulateInput`** (JSON) — all ballots, candidates, and options
2. **`result.meta.inputHash`** — to prove the input was not altered after tabulation
3. **The full `TabulateResult`** (JSON) — all rounds, tallies, transfers, unusual outcomes
4. **The plain-text audit log** (`formatAuditLog(result, { verbosity: 'detailed', includeTransfers: true })`)
5. **The engine version** (`result.meta.engineVersion`) — ensures the same version can be used for re-runs

With these five items, any party can independently verify the election by:
- Running `hashInput(input)` and comparing against the archived hash
- Calling `tabulate(input)` and comparing the result JSON against the archived result
- Confirming all winners, round tallies, and tie-break decisions match

---

## 8. Verifying the Engine Itself

`rcv-engine` is open source. Auditors who want to verify the engine code rather than just the output can:

1. Clone the repository and inspect the source in `packages/rcv-engine/src/`
2. Run the full test suite (`npm test` in the package directory) — all 71 tests should pass
3. Run `npm run typecheck` — zero TypeScript errors expected
4. Build from source and compare the published package's dist output

Key files for algorithmic review:

| File | Content |
|---|---|
| `src/irv.ts` | Instant Runoff Voting algorithm |
| `src/stv.ts` | Scottish STV (WIG) algorithm |
| `src/rational.ts` | Exact bigint rational arithmetic |
| `src/tiebreak.ts` | All three tie-break strategies |
| `src/hash.ts` | Canonical JSON serialization and SHA-256 hashing |
| `src/validate.ts` | Input validation and write-in resolution |
| `docs/algorithm.md` | Normative algorithm reference |
