// ─────────────────────────────────────────────────────────────────────────────
// formatAuditLog — plain-text English narrative of a tabulation result
// Implements spec Section 5.7.
// ─────────────────────────────────────────────────────────────────────────────

import type { TabulateResult, FormatAuditLogOptions } from './types.js';
import { UnsupportedLocaleError } from './errors.js';
import { fromRational, toApprox } from './rational.js';

/**
 * Produce a human-readable plain-text English narrative of the tabulation.
 *
 * The output is suitable for display, copy-pasting into an email, or reading
 * aloud at a public meeting. It is not HTML, not Markdown, and not structured
 * data — just plain text with line breaks.
 */
export function formatAuditLog(
  result: TabulateResult,
  options: FormatAuditLogOptions = {},
): string {
  const locale = options.locale ?? 'en';
  const verbosity = options.verbosity ?? 'standard';
  const includeTransfers = options.includeTransfers !== false;

  if (locale !== 'en') {
    throw new UnsupportedLocaleError(locale);
  }

  const lines: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push('ELECTION AUDIT LOG');
  lines.push('═'.repeat(60));
  lines.push('');

  const { meta, summary } = result;
  lines.push(`Method:          ${meta.method.toUpperCase()} (${meta.method === 'irv' ? 'Instant Runoff Voting' : 'Single Transferable Vote'})`);
  lines.push(`Seats:           ${meta.seats}`);
  lines.push(`Total ballots:   ${summary.totalBallots}`);
  lines.push(`Quota mode:      ${meta.quotaMode}`);
  lines.push(`Tie-break:       ${meta.tieBreakStrategy}${meta.tieBreakSeed ? ` (seed: "${meta.tieBreakSeed}")` : ''}`);
  if (meta.method === 'stv') {
    lines.push(`STV arithmetic:  ${meta.stvArithmetic}`);
  }
  lines.push(`Input hash:      ${meta.inputHash}`);
  lines.push(`Engine version:  ${meta.engineVersion}`);
  lines.push('');

  // ── Winners ────────────────────────────────────────────────────────────────
  lines.push('─'.repeat(60));
  if (result.winners.length === 0) {
    lines.push('RESULT: No winner could be determined.');
  } else if (result.winners.length === 1) {
    const w = result.winners[0]!;
    const tally = toApprox(fromRational(w.finalTally), 4);
    lines.push(`RESULT: ${formatCandidateName(w.candidateName, w.isWriteIn)} won in round ${w.electedInRound} with ${tally} vote(s).`);
  } else {
    lines.push(`RESULT: ${result.winners.length} candidates elected.`);
    for (const w of result.winners) {
      const tally = toApprox(fromRational(w.finalTally), 4);
      lines.push(`  • ${formatCandidateName(w.candidateName, w.isWriteIn)} (elected in round ${w.electedInRound}, tally: ${tally})`);
    }
  }
  lines.push('─'.repeat(60));
  lines.push('');

  // ── Unusual outcomes summary ────────────────────────────────────────────────
  if (summary.unusualOutcomes.length > 0) {
    lines.push('NOTABLE EVENTS:');
    for (const uo of summary.unusualOutcomes) {
      lines.push(`  [${uo.code}] ${uo.description}`);
    }
    lines.push('');
  }

  // ── Round-by-round narrative ────────────────────────────────────────────────
  lines.push('ROUND-BY-ROUND DETAIL');
  lines.push('═'.repeat(60));

  for (const round of result.rounds) {
    lines.push('');
    lines.push(`ROUND ${round.roundNumber}`);
    lines.push('─'.repeat(40));

    // Threshold
    const thresholdApprox = toApprox(fromRational(round.threshold), 4);
    lines.push(`Threshold: ${thresholdApprox} vote(s)`);
    lines.push('');

    // Tally
    lines.push('Tally:');
    const tallyEntries = Object.entries(round.tally)
      .map(([id, r]) => ({ id, value: fromRational(r) }))
      .sort((a, b) => {
        const c = fromRational(round.tally[b.id]!);
        const d = fromRational(round.tally[a.id]!);
        const diff = c.n * d.d - d.n * c.d;
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      });
    for (const e of tallyEntries) {
      const v = toApprox(e.value, 4);
      lines.push(`  ${e.id}: ${v}`);
    }

    // Exhausted this round
    const exThisRound = toApprox(fromRational(round.exhaustedThisRound), 4);
    const exTotal = toApprox(fromRational(round.exhaustedTotal), 4);
    if (fromRational(round.exhaustedThisRound).n > 0n) {
      lines.push(`  (${exThisRound} ballot(s) newly exhausted; ${exTotal} total exhausted)`);
    }
    lines.push('');

    // Events: elected
    for (const id of round.elected) {
      lines.push(`✓ ${id} was elected in this round.`);
    }

    // Events: eliminated
    for (const id of round.eliminated) {
      lines.push(`✗ ${id} was eliminated in this round.`);
    }

    // Tie-break
    if (round.tieBreakApplied) {
      const tb = round.tieBreakApplied;
      lines.push('');
      lines.push(`Tie-break applied:`);
      lines.push(`  Tied candidates: [${tb.tiedCandidates.join(', ')}]`);
      lines.push(`  Selected: ${tb.selectedCandidate}`);
      lines.push(`  Reason: ${tb.reason}`);
    }

    // Transfers (standard + detailed verbosity)
    if (includeTransfers && verbosity !== 'brief' && round.transfers.aggregate.length > 0) {
      lines.push('');
      lines.push('Vote transfers:');
      for (const t of round.transfers.aggregate) {
        const weight = toApprox(fromRational(t.weight), 6);
        const dest = t.toCandidateId ?? '(exhausted)';
        lines.push(`  ${t.ballotCount} ballot(s) × ${weight}: ${t.fromCandidateId} → ${dest}`);
      }
    }

    // Unusual outcomes for this round
    if (round.unusualOutcomes && round.unusualOutcomes.length > 0) {
      lines.push('');
      for (const uo of round.unusualOutcomes) {
        lines.push(`Note [${uo.code}]: ${uo.description}`);
      }
    }
  }

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push('END OF AUDIT LOG');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCandidateName(name: string, isWriteIn: boolean): string {
  return isWriteIn ? `write-in candidate "${name}"` : name;
}
