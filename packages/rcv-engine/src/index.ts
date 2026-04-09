// ─────────────────────────────────────────────────────────────────────────────
// rcv-engine — public API surface
//
// Everything exported from this file is covered by semver guarantees.
// Internal modules (rational, prng, etc.) are NOT part of the public API
// and should not be imported directly by callers.
// ─────────────────────────────────────────────────────────────────────────────

// ── Functions ─────────────────────────────────────────────────────────────────

export { tabulate } from './tabulate.js';
export { validateInput } from './validate.js';
export { hashInput } from './hash.js';
export { formatAuditLog } from './audit-log.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
  // Top-level input/output
  TabulateInput,
  TabulateResult,

  // Input sub-structures
  Candidate,
  Ballot,
  Ranking,
  WriteInAliases,
  ElectionOptions,
  TieBreakOption,

  // Enum-like string literal unions
  TabulationMethod,
  QuotaMode,
  StvArithmetic,

  // Output sub-structures
  Winner,
  Round,
  Transfers,
  AggregateTransfer,
  BallotLevelTransfer,
  TieBreakEvent,
  ResultSummary,
  ResultMetadata,
  SynthesizedWriteIn,
  UnusualOutcome,

  // Rational number type
  Rational,

  // formatAuditLog
  FormatAuditLogOptions,

  // validateInput
  ValidationResult,
  ValidationIssue,
} from './types.js';

// ── Error classes ──────────────────────────────────────────────────────────────

export {
  RcvEngineError,
  ValidationError,
  UnresolvableTieError,
  UnsupportedLocaleError,
} from './errors.js';
