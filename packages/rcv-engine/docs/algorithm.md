# rcv-engine Algorithm Reference

**Package:** `rcv-engine` v1.0.0  
**Status:** Normative  
**References:**
- [Ranked voting — Wikipedia](https://en.wikipedia.org/wiki/Ranked_voting)
- [Scottish Local Government Elections Order 2007](https://www.legislation.gov.uk/ssi/2007/42)

---

## 1. Overview

`rcv-engine` supports two tabulation methods:

- **IRV (Instant Runoff Voting)** — single-winner elections, spec Section 6
- **Scottish STV (Single Transferable Vote)** — multi-winner elections using the Weighted Inclusive Gregory method, spec Section 7

Both methods share the same input/output schema. The algorithm is selected via `options.method`.

---

## 2. Instant Runoff Voting (IRV)

IRV is a single-winner method. In each round, the candidate with the fewest votes is eliminated and their voters' next preferences are counted. This continues until one candidate reaches the majority threshold.

### 2.1 Threshold

The majority threshold determines when a candidate has won.

- **Static** (`quotaMode: 'static'`): Computed once at the start from the initial ballot count:

  ```
  threshold = floor(initialBallotCount / 2) + 1
  ```

- **Dynamic** (`quotaMode: 'dynamic'`): Recomputed each round from the count of non-exhausted ballots:

  ```
  threshold = floor(activeBallotCount / 2) + 1
  ```

### 2.2 Round loop

Each round:

1. Count: For each non-exhausted ballot, find its highest-ranked still-active candidate and add 1 to that candidate's tally.
2. Exhaust: Any ballot with no remaining active preference becomes exhausted.
3. Check threshold: If any candidate's tally ≥ threshold, that candidate wins.
4. Check last remaining: If only one active candidate remains, they win (recorded as `WINNER_WITHOUT_MAJORITY`).
5. Check all exhausted: If all active candidates have zero ballots and no one won, the election ends with no winner (`ALL_BALLOTS_EXHAUSTED`).
6. Eliminate: Remove the candidate(s) with the fewest votes (see Section 2.3). Transfer their ballots to the next active preference.

### 2.3 Elimination

**Single elimination:** If exactly one candidate has the strictly-lowest vote total, that candidate is eliminated.

**Tie-break:** If two or more candidates are tied for the lowest total, the tie-break strategy (Section 4) selects one to eliminate.

**Batch elimination:** If the combined votes of the lowest-ranked candidates are strictly less than the next-lowest candidate's total, all of them are eliminated together in a single round:

```
Find the largest prefix P of candidates sorted by ascending tally such that:
  sum(tally[c] for c in P) < min(tally[c] for c not in P)

If len(P) > 1: eliminate all of P together (no tie-break needed, batch is outcome-neutral)
```

Batch eliminations are flagged in the round with `BATCH_ELIMINATION_APPLIED`.

### 2.4 Worked example

See `engine-package-design.md` Section 6.9 for a full 5-candidate, 100-ballot worked example showing Bob winning despite Alice leading every round.

---

## 3. Scottish STV

STV is a multi-winner method using the **Weighted Inclusive Gregory (WIG)** surplus transfer method, as specified in the Scottish Local Government Elections Order 2007.

Each ballot carries a *transfer value* (initially 1). When a candidate is elected with a surplus, that surplus is proportionally distributed to the elected candidate's supporters' next preferences by reducing each ballot's value.

### 3.1 Quota (Droop)

- **Static** (`quotaMode: 'static'`):

  ```
  quota = floor(totalBallots / (seats + 1)) + 1
  ```

  Computed once; constant throughout.

- **Dynamic** (`quotaMode: 'dynamic'`):

  ```
  quota = floor(activeWeight / (seatsRemaining + 1)) + 1
  ```

  Recomputed each round. `activeWeight` is the sum of all non-exhausted ballot values.

### 3.2 Round loop

Each round:

1. Count: Sum `ballotValue[b]` for every non-exhausted ballot `b`, adding it to its current top-preference candidate's tally.
2. Elect: Any candidate whose tally ≥ quota is elected.
3. Transfer surpluses (if any elections occurred): Transfer the largest surplus first, then re-count. Repeat until no surpluses remain or all seats are filled.
4. Check termination conditions (Section 3.4).
5. Eliminate: If no one was elected and no surpluses remain, eliminate the lowest-tally candidate(s) and transfer their ballots.

### 3.3 Surplus transfer (Weighted Inclusive Gregory)

When candidate C is elected with tally `T` and quota `Q`:

```
surplus  = T - Q
newValue = oldValue × (surplus / T)
```

Every ballot currently on C gets its value reduced by this factor and transfers to its next active preference. Eliminated candidates' ballots transfer at their *current* value, unchanged.

### 3.4 Termination conditions

| Condition | Code | Description |
|---|---|---|
| All seats filled | — | Normal completion |
| Remaining active candidates = remaining seats | `ELECTED_BY_REMAINDER` | All remaining candidates elected without further counting |
| Fewer candidates remain than remaining seats | `INSUFFICIENT_CANDIDATES` | Some seats unfilled |
| All ballots exhausted | `ALL_BALLOTS_EXHAUSTED` | Some seats unfilled |

### 3.5 Arithmetic modes

**`exact` (default):** All fractions are computed as exact bigint rationals. No rounding at any step. Recommended for all new elections.

**`order2007`:** Reproduces the fixed-point integer arithmetic of the Scottish Local Government Elections Order 2007. Values are scaled by 100,000 and truncated (not rounded) at each division. Use only when the result must be auditable against the Order verbatim. In rare elections with small margins, `order2007` can produce different winners than `exact` mode.

---

## 4. Tie-breaking

All three strategies are deterministic for a given input:

### 4.1 `random` (seeded PRNG)

The seed string is hashed using **xmur3** to produce a 32-bit initial state, then a **mulberry32** PRNG generates the sequence. The tied candidates are sorted by their input-array order (the order they appeared in the `candidates` array), and one is selected using the PRNG's next draw. The PRNG state persists across multiple tie-break invocations within a single `tabulate()` call, so each tie draws the next number in the sequence.

The draw index is recorded on the `TieBreakEvent` so an auditor can reproduce the exact draw.

### 4.2 `previousRound`

The engine walks backwards through prior rounds comparing the tied candidates' tallies. The candidate with the lowest tally in the most recent discriminating round is eliminated. If no round discriminates (all tied in all prior rounds), `UnresolvableTieError` is thrown.

### 4.3 `provided`

The caller supplies an `order` array containing every candidate ID. When a tie must be broken, the candidate who appears latest in the array is eliminated. This models a pre-announced tie-breaking rule (alphabetical order, coin toss order, etc.).

---

## 5. Write-in handling

Write-in rankings appear in ballots as `{ type: 'writeIn', name: '...' }`. During validation, they are resolved as follows:

1. If the raw string appears in `writeInAliases`, the ranking is rewritten to `{ type: 'candidate', id: alias[rawString] }`, where the target must be a declared candidate with `isWriteIn: true`.
2. If the raw string is not in `writeInAliases`, the engine synthesizes a new candidate with ID `writein:literal:<sha256-prefix>` (first 12 hex chars of SHA-256 of the raw string, byte-for-byte). These synthesized candidates appear in the tally and can win.

The alias map and all synthesized candidates are recorded verbatim in `result.meta` for auditors.

---

## 6. Input hashing

`hashInput(input)` returns `"sha256:<hex>"`. The hash is produced by:

1. Serializing the input to **canonical JSON** (RFC 8785): object keys sorted lexicographically, no whitespace, strings with minimal RFC 8259 escaping.
2. Encoding the canonical JSON as UTF-8.
3. Computing SHA-256 of the UTF-8 bytes.

Two semantically equivalent inputs (same candidates, ballots, options, regardless of object-key order) produce identical hashes. Any meaningful difference produces a different hash.

---

## 7. Purity contract

`tabulate`, `validateInput`, `hashInput`, and `formatAuditLog` are pure functions. They:

- Perform no I/O (no filesystem, no network, no clock, no `console`)
- Do not mutate their inputs
- Accept no callbacks, loggers, or pluggable randomness sources
- Produce byte-identical output for byte-identical inputs within a major version

`result.meta.producedAt` is always `null`. Callers who need a timestamp must add it themselves.
