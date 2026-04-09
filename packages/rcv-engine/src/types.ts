// ─────────────────────────────────────────────────────────────────────────────
// Public types for rcv-engine v1
// These are the authoritative TypeScript representations of the public API
// contract. Any breaking change to a type is a breaking change to the package.
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Rational numbers
// Fractional vote values are represented as exact rational numbers. Both
// numerator and denominator are bigints serialized as decimal strings so the
// type is directly JSON-serializable with full precision.
// Denominator is always positive; fractions are always GCD-reduced.
// ---------------------------------------------------------------------------
export interface Rational {
  numerator: string;   // bigint as decimal string
  denominator: string; // bigint as decimal string, always > 0
}

// ---------------------------------------------------------------------------
// Input: TabulateInput
// ---------------------------------------------------------------------------

export interface TabulateInput {
  schemaVersion: 1;
  candidates: Candidate[];
  ballots: Ballot[];
  writeInAliases?: WriteInAliases;
  options: ElectionOptions;
}

export interface Candidate {
  id: string;
  name: string;
  isWriteIn?: boolean;
}

export interface Ballot {
  id: string;
  rankings: Ranking[];
}

export type Ranking =
  | { type: 'candidate'; id: string }
  | { type: 'writeIn'; name: string };

/** Maps raw write-in strings (as entered by voters) to canonical candidate IDs. */
export type WriteInAliases = Record<string, string>;

export interface ElectionOptions {
  method: TabulationMethod;
  seats: number;
  tieBreak: TieBreakOption;
  quotaMode: QuotaMode;
  writeInsAllowed: boolean;
  maxWriteInsPerBallot?: number;
  trackBallotTransfers?: boolean;
  stvArithmetic?: StvArithmetic;
}

export type TabulationMethod = 'irv' | 'stv';
export type QuotaMode = 'static' | 'dynamic';
export type StvArithmetic = 'exact' | 'order2007';

export type TieBreakOption =
  | { strategy: 'random'; seed: string }
  | { strategy: 'previousRound' }
  | { strategy: 'provided'; order: string[] };

// ---------------------------------------------------------------------------
// Output: TabulateResult
// ---------------------------------------------------------------------------

export interface TabulateResult {
  winners: Winner[];
  rounds: Round[];
  summary: ResultSummary;
  meta: ResultMetadata;
}

export interface Winner {
  candidateId: string;
  candidateName: string;
  isWriteIn: boolean;
  electedInRound: number;
  finalTally: Rational;
}

export interface Round {
  roundNumber: number;
  /** Maps active candidate ID → vote total at end of this round. */
  tally: Record<string, Rational>;
  threshold: Rational;
  elected: string[];
  eliminated: string[];
  transfers: Transfers;
  exhaustedThisRound: Rational;
  exhaustedTotal: Rational;
  tieBreakApplied?: TieBreakEvent;
  unusualOutcomes?: UnusualOutcome[];
}

export interface Transfers {
  aggregate: AggregateTransfer[];
  ballotLevel?: BallotLevelTransfer[];
}

export interface AggregateTransfer {
  fromCandidateId: string;
  toCandidateId: string | null; // null = exhausted
  weight: Rational;
  ballotCount: number;
}

export interface BallotLevelTransfer {
  ballotId: string;
  fromCandidateId: string;
  toCandidateId: string | null;
  weight: Rational;
}

export interface TieBreakEvent {
  strategy: 'random' | 'previousRound' | 'provided';
  tiedCandidates: string[];
  selectedCandidate: string;
  reason: string;
  prngDrawIndex?: number;
  previousRoundLookback?: number;
}

export interface ResultSummary {
  totalBallots: number;
  validBallots: number;
  exhaustedBallots: Rational;
  roundCount: number;
  method: TabulationMethod;
  seats: number;
  seatsFilled: number;
  unusualOutcomes: UnusualOutcome[];
}

export interface UnusualOutcome {
  code: string;
  description: string;
  roundNumber?: number;
}

export interface ResultMetadata {
  engineVersion: string;
  schemaVersion: 1;
  inputHash: string;
  producedAt: null;
  method: TabulationMethod;
  seats: number;
  quotaMode: QuotaMode;
  tieBreakStrategy: 'random' | 'previousRound' | 'provided';
  tieBreakSeed?: string;
  writeInsAllowed: boolean;
  maxWriteInsPerBallot?: number;
  stvArithmetic: StvArithmetic | 'n/a';
  candidateCount: number;
  ballotCount: number;
  roundCount: number;
  writeInAliasesUsed: WriteInAliases;
  synthesizedWriteIns: SynthesizedWriteIn[];
}

export interface SynthesizedWriteIn {
  rawString: string;
  synthesizedId: string;
  ballotCount: number;
}

// ---------------------------------------------------------------------------
// formatAuditLog options
// ---------------------------------------------------------------------------

export interface FormatAuditLogOptions {
  locale?: 'en';
  verbosity?: 'brief' | 'standard' | 'detailed';
  includeTransfers?: boolean;
}

// ---------------------------------------------------------------------------
// validateInput result
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationIssue[] };

/** A single validation problem found in the input. */
export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}
