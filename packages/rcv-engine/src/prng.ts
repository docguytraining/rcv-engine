// ─────────────────────────────────────────────────────────────────────────────
// Seeded PRNG for deterministic tie-breaking
//
// Algorithm: xmur3 (string → uint32 seed) + mulberry32 (uint32 → float sequence)
// Both are in the public domain (bryc/code on GitHub). They produce high-quality
// 32-bit uniform pseudorandom floats from a string seed.
//
// The PRNG is stateful within a single tabulate() call. Each tie-break invocation
// draws the next number in the sequence, so the draw index is recorded on the
// TieBreakEvent for full auditability.
// ─────────────────────────────────────────────────────────────────────────────

export interface Prng {
  /** Draw the next float in [0, 1). */
  next(): number;
  /** How many draws have been consumed so far. */
  readonly drawIndex: number;
}

/**
 * Create a seeded PRNG from a string seed.
 * The PRNG is deterministic: given the same seed, it always produces the
 * same sequence of floats. The first call to next() returns the same value
 * as the first call in any other run with the same seed.
 */
export function createPrng(seed: string): Prng {
  // xmur3: hash a string into a uint32 initial state
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  // Final mixing to produce the seed value
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h = (h ^ (h >>> 16)) >>> 0;

  let state = h;
  let index = 0;

  function next(): number {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    index++;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    get drawIndex() { return index; },
  };
}

/**
 * Pick one item from an array at random using the given PRNG.
 * Returns the selected item and the draw index used.
 */
export function pickOne<T>(items: T[], prng: Prng): { item: T; drawIndex: number } {
  if (items.length === 0) throw new Error('PRNG.pickOne: empty array');
  const r = prng.next();
  const idx = Math.floor(r * items.length);
  const clamped = Math.min(idx, items.length - 1);
  return { item: items[clamped]!, drawIndex: prng.drawIndex };
}
