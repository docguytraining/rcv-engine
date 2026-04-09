// ─────────────────────────────────────────────────────────────────────────────
// Exact rational arithmetic using BigInt
// All fractions are kept in lowest terms with a positive denominator.
// The public Rational type uses strings for JSON-serializability; internally
// we operate on InternalRational (bigint numerator, bigint denominator).
// ─────────────────────────────────────────────────────────────────────────────

import type { Rational } from './types.js';

export type IR = { n: bigint; d: bigint };

// ---------------------------------------------------------------------------
// GCD and reduction
// ---------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

export function reduce(r: IR): IR {
  if (r.d === 0n) throw new Error('Rational: denominator is zero');
  if (r.n === 0n) return { n: 0n, d: 1n };
  // Ensure denominator is positive
  const sign = r.d < 0n ? -1n : 1n;
  const n = r.n * sign;
  const d = r.d * sign;
  const g = gcd(n < 0n ? -n : n, d);
  return { n: n / g, d: d / g };
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function fromInt(n: number | bigint): IR {
  return { n: BigInt(n), d: 1n };
}

export function fromRational(r: Rational): IR {
  return reduce({ n: BigInt(r.numerator), d: BigInt(r.denominator) });
}

export function toRational(r: IR): Rational {
  const rr = reduce(r);
  return { numerator: String(rr.n), denominator: String(rr.d) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZERO: IR = { n: 0n, d: 1n };
export const ONE: IR  = { n: 1n, d: 1n };

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function add(a: IR, b: IR): IR {
  return reduce({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}

export function sub(a: IR, b: IR): IR {
  return reduce({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
}

export function mul(a: IR, b: IR): IR {
  return reduce({ n: a.n * b.n, d: a.d * b.d });
}

export function div(a: IR, b: IR): IR {
  if (b.n === 0n) throw new Error('Rational: division by zero');
  return reduce({ n: a.n * b.d, d: a.d * b.n });
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Returns negative, zero, or positive like Array.sort comparator. */
export function cmp(a: IR, b: IR): bigint {
  // a/b compared: a.n*b.d vs b.n*a.d (both denominators positive after reduce)
  return a.n * b.d - b.n * a.d;
}

export function eq(a: IR, b: IR): boolean  { return cmp(a, b) === 0n; }
export function lt(a: IR, b: IR): boolean  { return cmp(a, b) < 0n; }
export function lte(a: IR, b: IR): boolean { return cmp(a, b) <= 0n; }
export function gt(a: IR, b: IR): boolean  { return cmp(a, b) > 0n; }
export function gte(a: IR, b: IR): boolean { return cmp(a, b) >= 0n; }

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Floor toward negative infinity. */
export function floor(r: IR): bigint {
  const q = r.n / r.d; // BigInt division truncates toward zero
  // If negative and there's a remainder, subtract 1
  return r.n < 0n && r.n % r.d !== 0n ? q - 1n : q;
}

export function isZero(r: IR): boolean {
  return r.n === 0n;
}

/** Sum an array of IRs. */
export function sum(items: IR[]): IR {
  return items.reduce((acc, x) => add(acc, x), ZERO);
}

/** Approximate as a decimal string for display (not for computation). */
export function toApprox(r: IR, decimals = 4): string {
  if (r.d === 1n) return String(r.n);
  const scale = 10n ** BigInt(decimals);
  const scaled = (r.n * scale * 10n) / r.d;
  const rounded = (scaled + 5n) / 10n; // round half-up
  const s = String(rounded < 0n ? -rounded : rounded);
  const padded = s.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals) || '0';
  const fracPart = padded.slice(padded.length - decimals);
  const sign = rounded < 0n ? '-' : '';
  return `${sign}${intPart}.${fracPart}`;
}
