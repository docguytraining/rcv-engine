// ─────────────────────────────────────────────────────────────────────────────
// Typed error classes for rcv-engine
// All errors thrown by the engine are instances of RcvEngineError or a subclass.
// The `code` field is machine-readable and stable across minor versions.
// ─────────────────────────────────────────────────────────────────────────────

export class RcvEngineError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'RcvEngineError';
    this.code = code;
    if (path !== undefined) this.path = path;
    // Restore prototype chain for instanceof checks in transpiled code
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Input failed schema validation — missing fields, wrong types, unknown fields, etc. */
export class ValidationError extends RcvEngineError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path);
    this.name = 'ValidationError';
  }
}

/** A tie could not be resolved with the caller-supplied strategy. */
export class UnresolvableTieError extends RcvEngineError {
  readonly tiedCandidates: string[];

  constructor(tiedCandidates: string[], message: string) {
    super('UNRESOLVABLE_TIE', message);
    this.name = 'UnresolvableTieError';
    this.tiedCandidates = tiedCandidates;
  }
}

/** formatAuditLog was called with an unsupported locale. */
export class UnsupportedLocaleError extends RcvEngineError {
  constructor(locale: string) {
    super('UNSUPPORTED_LOCALE', `Locale "${locale}" is not supported in v1. Only "en" is accepted.`);
    this.name = 'UnsupportedLocaleError';
  }
}

// ─── Error codes ──────────────────────────────────────────────────────────────
// Validation error codes

export const ERR = {
  // Schema-level
  SCHEMA_VERSION_MISSING:      'SCHEMA_VERSION_MISSING',
  SCHEMA_VERSION_INVALID:      'SCHEMA_VERSION_INVALID',
  UNKNOWN_FIELD:               'UNKNOWN_FIELD',
  REQUIRED_FIELD_MISSING:      'REQUIRED_FIELD_MISSING',
  INVALID_TYPE:                'INVALID_TYPE',
  // Candidates
  EMPTY_CANDIDATES:            'EMPTY_CANDIDATES',
  DUPLICATE_CANDIDATE_ID:      'DUPLICATE_CANDIDATE_ID',
  CANDIDATE_ID_TOO_LONG:       'CANDIDATE_ID_TOO_LONG',
  CANDIDATE_NAME_TOO_LONG:     'CANDIDATE_NAME_TOO_LONG',
  TOO_MANY_CANDIDATES:         'TOO_MANY_CANDIDATES',
  // Ballots
  EMPTY_BALLOT_RANKINGS:       'EMPTY_BALLOT_RANKINGS',
  DUPLICATE_BALLOT_ID:         'DUPLICATE_BALLOT_ID',
  TOO_MANY_BALLOTS:            'TOO_MANY_BALLOTS',
  TOO_MANY_RANKINGS:           'TOO_MANY_RANKINGS',
  UNKNOWN_CANDIDATE_REF:       'UNKNOWN_CANDIDATE_REF',
  DUPLICATE_CANDIDATE_IN_BALLOT: 'DUPLICATE_CANDIDATE_IN_BALLOT',
  WRITE_IN_NOT_ALLOWED:        'WRITE_IN_NOT_ALLOWED',
  TOO_MANY_WRITE_INS_ON_BALLOT: 'TOO_MANY_WRITE_INS_ON_BALLOT',
  // Options
  INVALID_METHOD:              'INVALID_METHOD',
  INVALID_SEATS:               'INVALID_SEATS',
  SEATS_EXCEEDS_CANDIDATES:    'SEATS_EXCEEDS_CANDIDATES',
  IRV_SEATS_MUST_BE_ONE:       'IRV_SEATS_MUST_BE_ONE',
  INVALID_QUOTA_MODE:          'INVALID_QUOTA_MODE',
  INVALID_TIE_BREAK_STRATEGY:  'INVALID_TIE_BREAK_STRATEGY',
  TIE_BREAK_SEED_MISSING:      'TIE_BREAK_SEED_MISSING',
  TIE_BREAK_SEED_TOO_LONG:     'TIE_BREAK_SEED_TOO_LONG',
  TIE_BREAK_ORDER_INCOMPLETE:  'TIE_BREAK_ORDER_INCOMPLETE',
  TIE_BREAK_ORDER_EXTRA:       'TIE_BREAK_ORDER_EXTRA',
  MAX_WRITE_INS_WITHOUT_ALLOW: 'MAX_WRITE_INS_WITHOUT_ALLOW',
  INVALID_STV_ARITHMETIC:      'INVALID_STV_ARITHMETIC',
  // Write-in aliases
  TOO_MANY_WRITE_IN_ALIASES:   'TOO_MANY_WRITE_IN_ALIASES',
  WRITE_IN_ALIAS_BAD_TARGET:   'WRITE_IN_ALIAS_BAD_TARGET',
  // Size limit
  STRING_TOO_LONG:             'STRING_TOO_LONG',
} as const;

export type ErrCode = typeof ERR[keyof typeof ERR];
