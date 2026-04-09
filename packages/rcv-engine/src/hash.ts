// ─────────────────────────────────────────────────────────────────────────────
// Canonical input hashing
//
// hashInput produces a deterministic SHA-256 hash of the canonical serialization
// of any TabulateInput, so auditors can prove that two tabulation runs used
// identical inputs.
//
// Canonicalization follows RFC 8785 (JSON Canonicalization Scheme):
//   - Object keys sorted lexicographically by UTF-16 code units
//   - Strings with minimal escaping (RFC 8259)
//   - Numbers in shortest round-trip form
//   - No whitespace, no trailing newline
//   - Arrays preserve order
//
// The hash is returned as a lowercase hex string prefixed with "sha256:".
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import type { TabulateInput } from './types.js';

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null)               return 'null';
  if (value === undefined)          return 'null'; // treat as null for hashing
  if (typeof value === 'boolean')   return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!isFinite(value)) throw new Error(`hashInput: cannot canonicalize non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    // JSON.stringify produces RFC 8259 string encoding with minimal escaping
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    // Sort object keys lexicographically by UTF-16 code unit sequence
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(k => {
      const v = (value as Record<string, unknown>)[k];
      return `${JSON.stringify(k)}:${canonicalize(v)}`;
    });
    return '{' + pairs.join(',') + '}';
  }
  throw new Error(`hashInput: cannot canonicalize value of type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the deterministic SHA-256 hash of the canonical serialization of
 * the input. Two inputs that are semantically identical (same candidates,
 * ballots, options, regardless of key ordering) produce the same hash.
 *
 * Format: "sha256:<lowercase-hex>"
 */
export function hashInput(input: TabulateInput): string {
  const canonical = canonicalize(input as unknown);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Compute SHA-256 of an arbitrary UTF-8 string.
 * Used internally for synthesized write-in candidate ID generation.
 */
export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
