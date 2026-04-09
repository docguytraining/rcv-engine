// ─────────────────────────────────────────────────────────────────────────────
// Input validation and write-in resolution
//
// validateInput()  — returns ValidationResult (never throws)
// resolveInput()   — validates and returns a ResolvedInput (throws on error)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  TabulateInput,
  ElectionOptions,
  ValidationResult, ValidationIssue,
  WriteInAliases, SynthesizedWriteIn,
} from './types.js';
import { ValidationError, ERR } from './errors.js';
import { sha256hex } from './hash.js';

// ---------------------------------------------------------------------------
// Size limits (from spec Section 4.8)
// ---------------------------------------------------------------------------

const MAX_CANDIDATES       = 1_000;
const MAX_BALLOTS          = 1_000_000;
const MAX_RANKINGS         = 100;
const MAX_STRING_LEN       = 256;
const MAX_WRITE_IN_ALIASES = 10_000;

// ---------------------------------------------------------------------------
// Resolved types (post-validation internal representation)
// ---------------------------------------------------------------------------

/** A candidate after write-in synthesis; all fields are guaranteed present. */
export interface ResolvedCandidate {
  id: string;
  name: string;
  isWriteIn: boolean;
}

/** A ballot with all write-in rankings rewritten to candidate ID references. */
export interface ResolvedBallot {
  id: string;
  rankings: string[]; // ordered array of candidateId
}

export interface ResolvedInput {
  candidates: ResolvedCandidate[];
  ballots: ResolvedBallot[];
  options: ElectionOptions;
  writeInAliasesUsed: WriteInAliases;
  synthesizedWriteIns: SynthesizedWriteIn[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkStringLen(
  value: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (value.length > MAX_STRING_LEN) {
    errors.push({
      code: ERR.STRING_TOO_LONG,
      message: `String at "${path}" exceeds ${MAX_STRING_LEN} characters.`,
      path,
    });
  }
}

// ---------------------------------------------------------------------------
// Main validator (returns ValidationResult, never throws)
// ---------------------------------------------------------------------------

export function validateInput(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  collectErrors(input, errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function collectErrors(input: unknown, errors: ValidationIssue[]): void {
  if (!isObject(input)) {
    errors.push({ code: ERR.INVALID_TYPE, message: 'Input must be a plain object.' });
    return;
  }

  // schemaVersion
  if (!('schemaVersion' in input)) {
    errors.push({ code: ERR.SCHEMA_VERSION_MISSING, message: 'Missing required field "schemaVersion".' });
  } else if (input['schemaVersion'] !== 1) {
    errors.push({ code: ERR.SCHEMA_VERSION_INVALID, message: `"schemaVersion" must be 1, got ${JSON.stringify(input['schemaVersion'])}.` });
  }

  // Check for unknown top-level fields
  const knownTopLevel = new Set(['schemaVersion', 'candidates', 'ballots', 'writeInAliases', 'options']);
  for (const k of Object.keys(input)) {
    if (!knownTopLevel.has(k)) {
      errors.push({ code: ERR.UNKNOWN_FIELD, message: `Unknown top-level field "${k}".`, path: k });
    }
  }

  // candidates
  if (!('candidates' in input)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required field "candidates".' });
  } else {
    validateCandidates(input['candidates'], errors);
  }

  // ballots
  if (!('ballots' in input)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required field "ballots".' });
  } else {
    const candidateIds = extractCandidateIds(input['candidates']);
    const writeInsAllowed = extractWriteInsAllowed(input['options']);
    validateBallots(input['ballots'], candidateIds, writeInsAllowed, errors);
  }

  // writeInAliases (optional)
  if ('writeInAliases' in input && input['writeInAliases'] !== undefined) {
    const candidateIds = extractCandidateIds(input['candidates']);
    const candidatesArr = Array.isArray(input['candidates']) ? input['candidates'] : [];
    validateWriteInAliases(input['writeInAliases'], candidateIds, candidatesArr, errors);
  }

  // options
  if (!('options' in input)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required field "options".' });
  } else {
    const candidateIds = extractCandidateIds(input['candidates']);
    const candidatesArr = Array.isArray(input['candidates']) ? input['candidates'] : [];
    validateOptions(input['options'], candidateIds, candidatesArr, errors);
  }
}

function extractCandidateIds(candidates: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(candidates)) return ids;
  for (const c of candidates) {
    if (isObject(c) && typeof c['id'] === 'string') ids.add(c['id']);
  }
  return ids;
}

function extractWriteInsAllowed(options: unknown): boolean {
  if (!isObject(options)) return false;
  return options['writeInsAllowed'] === true;
}

function validateCandidates(candidates: unknown, errors: ValidationIssue[]): void {
  if (!Array.isArray(candidates)) {
    errors.push({ code: ERR.INVALID_TYPE, message: '"candidates" must be an array.', path: 'candidates' });
    return;
  }
  if (candidates.length === 0) {
    errors.push({ code: ERR.EMPTY_CANDIDATES, message: '"candidates" array must not be empty.', path: 'candidates' });
    return;
  }
  if (candidates.length > MAX_CANDIDATES) {
    errors.push({ code: ERR.TOO_MANY_CANDIDATES, message: `"candidates" exceeds maximum of ${MAX_CANDIDATES}.`, path: 'candidates' });
    return;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const path = `candidates[${i}]`;
    if (!isObject(c)) {
      errors.push({ code: ERR.INVALID_TYPE, message: `${path} must be an object.`, path });
      continue;
    }
    // Check for unknown fields on Candidate
    const knownCandFields = new Set(['id', 'name', 'isWriteIn']);
    for (const k of Object.keys(c)) {
      if (!knownCandFields.has(k)) {
        errors.push({ code: ERR.UNKNOWN_FIELD, message: `Unknown field "${k}" on ${path}.`, path: `${path}.${k}` });
      }
    }
    if (!('id' in c) || typeof c['id'] !== 'string') {
      errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: `${path}.id must be a string.`, path: `${path}.id` });
    } else {
      checkStringLen(c['id'], `${path}.id`, errors);
      if (seenIds.has(c['id'])) {
        errors.push({ code: ERR.DUPLICATE_CANDIDATE_ID, message: `Duplicate candidate ID "${c['id']}" at ${path}.`, path: `${path}.id` });
      } else {
        seenIds.add(c['id']);
      }
    }
    if (!('name' in c) || typeof c['name'] !== 'string') {
      errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: `${path}.name must be a string.`, path: `${path}.name` });
    } else {
      checkStringLen(c['name'], `${path}.name`, errors);
    }
    if ('isWriteIn' in c && c['isWriteIn'] !== undefined && typeof c['isWriteIn'] !== 'boolean') {
      errors.push({ code: ERR.INVALID_TYPE, message: `${path}.isWriteIn must be a boolean.`, path: `${path}.isWriteIn` });
    }
  }
}

function validateBallots(
  ballots: unknown,
  candidateIds: Set<string>,
  writeInsAllowed: boolean,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(ballots)) {
    errors.push({ code: ERR.INVALID_TYPE, message: '"ballots" must be an array.', path: 'ballots' });
    return;
  }
  if (ballots.length > MAX_BALLOTS) {
    errors.push({ code: ERR.TOO_MANY_BALLOTS, message: `"ballots" exceeds maximum of ${MAX_BALLOTS}.`, path: 'ballots' });
    return;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < ballots.length; i++) {
    const b = ballots[i];
    const path = `ballots[${i}]`;
    if (!isObject(b)) {
      errors.push({ code: ERR.INVALID_TYPE, message: `${path} must be an object.`, path });
      continue;
    }
    if (!('id' in b) || typeof b['id'] !== 'string') {
      errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: `${path}.id must be a string.`, path: `${path}.id` });
    } else {
      checkStringLen(b['id'], `${path}.id`, errors);
      if (seenIds.has(b['id'])) {
        errors.push({ code: ERR.DUPLICATE_BALLOT_ID, message: `Duplicate ballot ID "${b['id']}" at ${path}.`, path: `${path}.id` });
      } else {
        seenIds.add(b['id']);
      }
    }
    if (!('rankings' in b) || !Array.isArray(b['rankings'])) {
      errors.push({ code: ERR.INVALID_TYPE, message: `${path}.rankings must be an array.`, path: `${path}.rankings` });
      continue;
    }
    if (b['rankings'].length === 0) {
      errors.push({ code: ERR.EMPTY_BALLOT_RANKINGS, message: `${path}.rankings must not be empty.`, path: `${path}.rankings` });
      continue;
    }
    if (b['rankings'].length > MAX_RANKINGS) {
      errors.push({ code: ERR.TOO_MANY_RANKINGS, message: `${path}.rankings exceeds maximum of ${MAX_RANKINGS}.`, path: `${path}.rankings` });
      continue;
    }
    const seenInBallot = new Set<string>();
    let writeInsOnBallot = 0;
    for (let j = 0; j < b['rankings'].length; j++) {
      const r = b['rankings'][j];
      const rpath = `${path}.rankings[${j}]`;
      if (!isObject(r)) {
        errors.push({ code: ERR.INVALID_TYPE, message: `${rpath} must be an object.`, path: rpath });
        continue;
      }
      if (r['type'] === 'candidate') {
        if (typeof r['id'] !== 'string') {
          errors.push({ code: ERR.INVALID_TYPE, message: `${rpath}.id must be a string.`, path: `${rpath}.id` });
          continue;
        }
        if (!candidateIds.has(r['id'])) {
          errors.push({ code: ERR.UNKNOWN_CANDIDATE_REF, message: `${rpath} references unknown candidate ID "${r['id']}".`, path: rpath });
          continue;
        }
        if (seenInBallot.has(r['id'])) {
          errors.push({ code: ERR.DUPLICATE_CANDIDATE_IN_BALLOT, message: `${rpath}: candidate "${r['id']}" appears more than once on this ballot.`, path: rpath });
        } else {
          seenInBallot.add(r['id']);
        }
      } else if (r['type'] === 'writeIn') {
        if (!writeInsAllowed) {
          errors.push({ code: ERR.WRITE_IN_NOT_ALLOWED, message: `${rpath}: write-in rankings are not allowed in this election.`, path: rpath });
          continue;
        }
        if (typeof r['name'] !== 'string') {
          errors.push({ code: ERR.INVALID_TYPE, message: `${rpath}.name must be a string.`, path: `${rpath}.name` });
          continue;
        }
        checkStringLen(r['name'], `${rpath}.name`, errors);
        writeInsOnBallot++;
      } else {
        errors.push({ code: ERR.INVALID_TYPE, message: `${rpath}.type must be "candidate" or "writeIn", got ${JSON.stringify(r['type'])}.`, path: `${rpath}.type` });
      }
    }
    // maxWriteInsPerBallot will be checked after options are validated; store count for later
    void writeInsOnBallot; // will be used in resolveInput
  }
}

function validateWriteInAliases(
  aliases: unknown,
  candidateIds: Set<string>,
  candidatesArr: unknown[],
  errors: ValidationIssue[],
): void {
  if (!isObject(aliases)) {
    errors.push({ code: ERR.INVALID_TYPE, message: '"writeInAliases" must be a plain object.', path: 'writeInAliases' });
    return;
  }
  const entries = Object.entries(aliases as Record<string, unknown>);
  if (entries.length > MAX_WRITE_IN_ALIASES) {
    errors.push({ code: ERR.TOO_MANY_WRITE_IN_ALIASES, message: `"writeInAliases" exceeds maximum of ${MAX_WRITE_IN_ALIASES} entries.`, path: 'writeInAliases' });
    return;
  }
  // Build a map of isWriteIn candidates for validation
  const writeInCandidateIds = new Set<string>();
  for (const c of candidatesArr) {
    if (isObject(c) && typeof c['id'] === 'string' && c['isWriteIn'] === true) {
      writeInCandidateIds.add(c['id']);
    }
  }
  for (const [rawString, targetId] of entries) {
    const path = `writeInAliases["${rawString}"]`;
    checkStringLen(rawString, `writeInAliases key "${rawString}"`, errors);
    if (typeof targetId !== 'string') {
      errors.push({ code: ERR.INVALID_TYPE, message: `${path} must be a string candidate ID.`, path });
      continue;
    }
    if (!candidateIds.has(targetId)) {
      errors.push({ code: ERR.WRITE_IN_ALIAS_BAD_TARGET, message: `${path}: target ID "${targetId}" does not exist in candidates.`, path });
      continue;
    }
    if (!writeInCandidateIds.has(targetId)) {
      errors.push({ code: ERR.WRITE_IN_ALIAS_BAD_TARGET, message: `${path}: target ID "${targetId}" exists but does not have isWriteIn: true.`, path });
    }
  }
}

function validateOptions(
  options: unknown,
  candidateIds: Set<string>,
  candidatesArr: unknown[],
  errors: ValidationIssue[],
): void {
  if (!isObject(options)) {
    errors.push({ code: ERR.INVALID_TYPE, message: '"options" must be a plain object.', path: 'options' });
    return;
  }

  // Check for unknown options fields
  const knownOptFields = new Set([
    'method', 'seats', 'tieBreak', 'quotaMode', 'writeInsAllowed',
    'maxWriteInsPerBallot', 'trackBallotTransfers', 'stvArithmetic',
  ]);
  for (const k of Object.keys(options)) {
    if (!knownOptFields.has(k)) {
      errors.push({ code: ERR.UNKNOWN_FIELD, message: `Unknown field "${k}" in options.`, path: `options.${k}` });
    }
  }

  // method
  if (!('method' in options)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required options field "method".', path: 'options.method' });
  } else if (options['method'] !== 'irv' && options['method'] !== 'stv') {
    errors.push({ code: ERR.INVALID_METHOD, message: `options.method must be "irv" or "stv", got ${JSON.stringify(options['method'])}.`, path: 'options.method' });
  }

  const method = options['method'];
  const nonWriteInCount = candidatesArr.filter(c => isObject(c) && !c['isWriteIn']).length;

  // seats
  if (!('seats' in options)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required options field "seats".', path: 'options.seats' });
  } else {
    const seats = options['seats'];
    if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1) {
      errors.push({ code: ERR.INVALID_SEATS, message: 'options.seats must be a positive integer.', path: 'options.seats' });
    } else {
      if (method === 'irv' && seats !== 1) {
        errors.push({ code: ERR.IRV_SEATS_MUST_BE_ONE, message: 'options.seats must be 1 when method is "irv".', path: 'options.seats' });
      }
      if (method === 'stv' && nonWriteInCount > 0 && seats > nonWriteInCount) {
        errors.push({ code: ERR.SEATS_EXCEEDS_CANDIDATES, message: `options.seats (${seats}) exceeds the number of non-write-in candidates (${nonWriteInCount}).`, path: 'options.seats' });
      }
    }
  }

  // quotaMode
  if (!('quotaMode' in options)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required options field "quotaMode".', path: 'options.quotaMode' });
  } else if (options['quotaMode'] !== 'static' && options['quotaMode'] !== 'dynamic') {
    errors.push({ code: ERR.INVALID_QUOTA_MODE, message: `options.quotaMode must be "static" or "dynamic".`, path: 'options.quotaMode' });
  }

  // writeInsAllowed
  if (!('writeInsAllowed' in options)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required options field "writeInsAllowed".', path: 'options.writeInsAllowed' });
  } else if (typeof options['writeInsAllowed'] !== 'boolean') {
    errors.push({ code: ERR.INVALID_TYPE, message: 'options.writeInsAllowed must be a boolean.', path: 'options.writeInsAllowed' });
  }

  // maxWriteInsPerBallot
  if ('maxWriteInsPerBallot' in options && options['maxWriteInsPerBallot'] !== undefined) {
    if (options['writeInsAllowed'] !== true) {
      errors.push({ code: ERR.MAX_WRITE_INS_WITHOUT_ALLOW, message: 'options.maxWriteInsPerBallot cannot be set when writeInsAllowed is false.', path: 'options.maxWriteInsPerBallot' });
    }
    const mw = options['maxWriteInsPerBallot'];
    if (typeof mw !== 'number' || !Number.isInteger(mw) || mw < 0) {
      errors.push({ code: ERR.INVALID_TYPE, message: 'options.maxWriteInsPerBallot must be a non-negative integer.', path: 'options.maxWriteInsPerBallot' });
    }
  }

  // stvArithmetic
  if ('stvArithmetic' in options && options['stvArithmetic'] !== undefined) {
    if (options['stvArithmetic'] !== 'exact' && options['stvArithmetic'] !== 'order2007') {
      errors.push({ code: ERR.INVALID_STV_ARITHMETIC, message: `options.stvArithmetic must be "exact" or "order2007".`, path: 'options.stvArithmetic' });
    }
  }

  // tieBreak
  if (!('tieBreak' in options)) {
    errors.push({ code: ERR.REQUIRED_FIELD_MISSING, message: 'Missing required options field "tieBreak".', path: 'options.tieBreak' });
  } else {
    validateTieBreak(options['tieBreak'], candidateIds, errors);
  }
}

function validateTieBreak(
  tieBreak: unknown,
  candidateIds: Set<string>,
  errors: ValidationIssue[],
): void {
  if (!isObject(tieBreak)) {
    errors.push({ code: ERR.INVALID_TYPE, message: 'options.tieBreak must be an object.', path: 'options.tieBreak' });
    return;
  }
  const strategy = tieBreak['strategy'];
  if (strategy !== 'random' && strategy !== 'previousRound' && strategy !== 'provided') {
    errors.push({ code: ERR.INVALID_TIE_BREAK_STRATEGY, message: `options.tieBreak.strategy must be "random", "previousRound", or "provided".`, path: 'options.tieBreak.strategy' });
    return;
  }
  if (strategy === 'random') {
    if (!('seed' in tieBreak) || typeof tieBreak['seed'] !== 'string' || tieBreak['seed'].length === 0) {
      errors.push({ code: ERR.TIE_BREAK_SEED_MISSING, message: 'options.tieBreak.seed is required for strategy "random".', path: 'options.tieBreak.seed' });
    } else {
      checkStringLen(tieBreak['seed'], 'options.tieBreak.seed', errors);
    }
  }
  if (strategy === 'provided') {
    const order = tieBreak['order'];
    if (!Array.isArray(order)) {
      errors.push({ code: ERR.INVALID_TYPE, message: 'options.tieBreak.order must be an array for strategy "provided".', path: 'options.tieBreak.order' });
      return;
    }
    const orderSet = new Set<string>(order.filter((x): x is string => typeof x === 'string'));
    for (const id of candidateIds) {
      if (!orderSet.has(id)) {
        errors.push({ code: ERR.TIE_BREAK_ORDER_INCOMPLETE, message: `options.tieBreak.order is missing candidate ID "${id}".`, path: 'options.tieBreak.order' });
      }
    }
    for (const id of orderSet) {
      if (!candidateIds.has(id)) {
        errors.push({ code: ERR.TIE_BREAK_ORDER_EXTRA, message: `options.tieBreak.order contains unknown candidate ID "${id}".`, path: 'options.tieBreak.order' });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// resolveInput: validates, throws on error, returns ResolvedInput
// ---------------------------------------------------------------------------

export function resolveInput(raw: unknown): ResolvedInput {
  // First pass: strict validation
  const result = validateInput(raw);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new ValidationError(first.code, first.message, first.path);
  }

  const input = raw as TabulateInput;
  const aliases = (input.writeInAliases ?? {}) as WriteInAliases;
  const opts = input.options;
  const writeInsAllowed = opts.writeInsAllowed;
  const seats = opts.seats;
  const maxWriteIns = opts.maxWriteInsPerBallot !== undefined
    ? opts.maxWriteInsPerBallot
    : (writeInsAllowed ? seats : 0);

  // Build base candidate map
  const candidateMap = new Map<string, ResolvedCandidate>();
  for (const c of input.candidates) {
    candidateMap.set(c.id, {
      id: c.id,
      name: c.name,
      isWriteIn: c.isWriteIn === true,
    });
  }

  // Resolve write-in aliases and synthesize candidates for unknown write-ins
  // Collect all raw write-in strings that appear on any ballot
  const rawWriteInNames = new Map<string, number>(); // rawName → ballot count
  for (const ballot of input.ballots) {
    for (const r of ballot.rankings) {
      if (r.type === 'writeIn') {
        rawWriteInNames.set(r.name, (rawWriteInNames.get(r.name) ?? 0) + 1);
      }
    }
  }

  // Synthesize candidates for raw write-ins not in aliases
  const synthesizedWriteIns: SynthesizedWriteIn[] = [];
  const synthIdForRaw = new Map<string, string>(); // rawName → synthesizedId

  for (const [rawName, ballotCount] of rawWriteInNames) {
    if (rawName in aliases) continue; // will be resolved to an existing candidate
    const hash = sha256hex(rawName).slice(0, 12);
    const synthId = `writein:literal:${hash}`;
    synthIdForRaw.set(rawName, synthId);
    synthesizedWriteIns.push({ rawString: rawName, synthesizedId: synthId, ballotCount });
    if (!candidateMap.has(synthId)) {
      candidateMap.set(synthId, { id: synthId, name: rawName, isWriteIn: true });
    }
  }

  // Resolve ballots
  const resolvedBallots: ResolvedBallot[] = [];
  for (const ballot of input.ballots) {
    let writeInsOnThisBallot = 0;
    const rankings: string[] = [];
    const seenInBallot = new Set<string>();

    for (const r of ballot.rankings) {
      let resolvedId: string;

      if (r.type === 'candidate') {
        resolvedId = r.id;
      } else {
        // write-in
        if (!writeInsAllowed) {
          throw new ValidationError(ERR.WRITE_IN_NOT_ALLOWED, `Ballot "${ballot.id}" contains a write-in ranking but writeInsAllowed is false.`);
        }
        writeInsOnThisBallot++;
        if (writeInsOnThisBallot > maxWriteIns) {
          throw new ValidationError(ERR.TOO_MANY_WRITE_INS_ON_BALLOT, `Ballot "${ballot.id}" has ${writeInsOnThisBallot} write-in rankings, exceeding maxWriteInsPerBallot (${maxWriteIns}).`);
        }
        // Resolve via alias or synthesized ID
        if (r.name in aliases) {
          resolvedId = aliases[r.name]!;
        } else {
          resolvedId = synthIdForRaw.get(r.name)!;
        }
      }

      if (seenInBallot.has(resolvedId)) {
        throw new ValidationError(ERR.DUPLICATE_CANDIDATE_IN_BALLOT, `Ballot "${ballot.id}" references candidate "${resolvedId}" more than once (after write-in resolution).`);
      }
      seenInBallot.add(resolvedId);
      rankings.push(resolvedId);
    }

    resolvedBallots.push({ id: ballot.id, rankings });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    ballots: resolvedBallots,
    options: input.options,
    writeInAliasesUsed: aliases,
    synthesizedWriteIns,
  };
}
