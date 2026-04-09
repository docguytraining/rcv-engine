#!/usr/bin/env node
/**
 * Packaging smoke test.
 *
 * Builds the package, runs `npm pack` to produce the exact tarball that
 * would be published, installs it into a throwaway temp directory, and
 * then runs four consumers against it:
 *
 *   1. TypeScript ESM — `import { tabulate } from 'rcv-engine'`, compiled
 *      with `moduleResolution: "bundler"` and `module: "esnext"`.
 *   2. TypeScript CJS — same import, compiled with `moduleResolution: "node"`
 *      and `module: "commonjs"`. This is what Firebase Cloud Functions use.
 *   3. JavaScript ESM — `import { tabulate } from 'rcv-engine'` run directly
 *      by Node as an .mjs file.
 *   4. JavaScript CJS — `const { tabulate } = require('rcv-engine')` run
 *      directly by Node as a .cjs file.
 *
 * Each consumer runs a real IRV election and asserts the winner. The test
 * fails loudly if any consumer can't resolve the module, can't find the
 * types, or can't run the function.
 *
 * Why this exists:
 *   Versions 1.0.0–1.0.2 were published with three packaging bugs
 *   (missing type declarations, CJS output not tagged as CommonJS, exports
 *   map pointing to nonexistent files). The unit test suite — which
 *   imports from ./src — didn't notice, because it never touched the
 *   tarball. This script closes that gap by actually installing the
 *   tarball and using it the way a real consumer would.
 *
 * Exit code is 0 on success, 1 on any consumer failure.
 */

import { execSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// Colored output so failures stand out in CI logs.
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const log = (color, msg) => console.log(`${colors[color]}${msg}${colors.reset}`);

function run(cmd, cwd = pkgRoot) {
  log('cyan', `$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function runCapture(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

// ---------------------------------------------------------------------------
// Step 1: build and pack
// ---------------------------------------------------------------------------

log('yellow', '\n=== Step 1: build and pack ===');
run('npm run build');

// `npm pack` prints the tarball filename on stdout.
const packOutput = runCapture('npm pack --json', pkgRoot);
const packInfo = JSON.parse(packOutput)[0];
const tarballName = packInfo.filename;
const tarballPath = resolve(pkgRoot, tarballName);
log('green', `✓ packed: ${tarballName} (${packInfo.size} bytes, ${packInfo.entryCount} entries)`);

// Sanity check: the tarball MUST contain the files referenced by the
// exports map. If any of these are missing, we want to fail before even
// installing.
const requiredFiles = [
  'package/dist/esm/index.js',
  'package/dist/cjs/index.js',
  'package/dist/cjs/package.json',
  'package/dist/types/index.d.ts',
];
const tarballContents = runCapture(`tar -tzf "${tarballPath}"`);
const missing = requiredFiles.filter((f) => !tarballContents.includes(f));
if (missing.length > 0) {
  log('red', '✗ tarball is missing required files:');
  missing.forEach((f) => log('red', `  - ${f}`));
  process.exit(1);
}
log('green', '✓ tarball contains all required files');

// ---------------------------------------------------------------------------
// Step 2: install the tarball into a throwaway dir
// ---------------------------------------------------------------------------

log('yellow', '\n=== Step 2: install tarball into temp dir ===');
const workDir = mkdtempSync(resolve(tmpdir(), 'rcv-engine-pack-test-'));
log('cyan', `workdir: ${workDir}`);

// Copy the tarball in so `npm install` uses the file reference.
cpSync(tarballPath, resolve(workDir, tarballName));

writeFileSync(
  resolve(workDir, 'package.json'),
  JSON.stringify(
    {
      name: 'rcv-engine-pack-test-consumer',
      private: true,
      version: '0.0.0',
      dependencies: { 'rcv-engine': `file:./${tarballName}` },
    },
    null,
    2,
  ),
);

run('npm install --silent --no-audit --no-fund', workDir);
log('green', '✓ install succeeded');

// ---------------------------------------------------------------------------
// Step 3: write four consumer files (TS/ESM, TS/CJS, JS/ESM, JS/CJS)
// ---------------------------------------------------------------------------

log('yellow', '\n=== Step 3: write consumers ===');

// A minimal but real election. Alice wins outright in round 1 — boring,
// but we only care that `tabulate` is importable and runs, not that the
// algorithm is exercised (the full unit suite does that).
const electionInputJs = `{
  schemaVersion: 1,
  candidates: [
    { id: 'alice', name: 'Alice' },
    { id: 'bob',   name: 'Bob'   },
  ],
  ballots: [
    { id: 'b1', rankings: [{ type: 'candidate', id: 'alice' }] },
    { id: 'b2', rankings: [{ type: 'candidate', id: 'alice' }] },
    { id: 'b3', rankings: [{ type: 'candidate', id: 'bob'   }] },
  ],
  options: {
    method: 'irv',
    seats: 1,
    tieBreak: { strategy: 'random', seed: 'pack-test' },
    quotaMode: 'dynamic',
    writeInsAllowed: false,
  },
}`;

// Use `throw new Error(...)` rather than `process.exit()` so the TS
// consumers don't need @types/node installed. Node runtime consumers
// still see a nonzero exit code because an uncaught throw exits nonzero.
const assertWinner = `
  if (result.winners.length !== 1) {
    throw new Error('FAIL: expected 1 winner, got ' + result.winners.length);
  }
  if (result.winners[0].candidateId !== 'alice') {
    throw new Error('FAIL: expected alice, got ' + result.winners[0].candidateId);
  }
  if (typeof result.meta.inputHash !== 'string' || !result.meta.inputHash.startsWith('sha256:')) {
    throw new Error('FAIL: expected sha256 input hash, got ' + result.meta.inputHash);
  }
`;

// --- JS ESM consumer -------------------------------------------------------
writeFileSync(
  resolve(workDir, 'consumer.mjs'),
  `import { tabulate, hashInput } from 'rcv-engine';
const input = ${electionInputJs};
const result = tabulate(input);
const hash = hashInput(input);
if (hash !== result.meta.inputHash) { throw new Error('FAIL: hash mismatch'); }
${assertWinner}
console.log('OK: JS ESM consumer works');
`,
);

// --- JS CJS consumer -------------------------------------------------------
writeFileSync(
  resolve(workDir, 'consumer.cjs'),
  `const { tabulate, hashInput } = require('rcv-engine');
const input = ${electionInputJs};
const result = tabulate(input);
const hash = hashInput(input);
if (hash !== result.meta.inputHash) { throw new Error('FAIL: hash mismatch'); }
${assertWinner}
console.log('OK: JS CJS consumer works');
`,
);

// --- TS consumer source (shared between ESM and CJS TS tests) --------------
// The `satisfies` check confirms types are exported, not just the runtime.
const tsSource = `import { tabulate, hashInput, type TabulateInput } from 'rcv-engine';
const input: TabulateInput = ${electionInputJs};
const result = tabulate(input);
const hash: string = hashInput(input);
if (hash !== result.meta.inputHash) { throw new Error('FAIL: hash mismatch'); }
${assertWinner}
console.log('OK: TS consumer works');
`;

// --- TS ESM consumer (bundler resolution, the modern default) -------------
writeFileSync(resolve(workDir, 'consumer-esm.ts'), tsSource);
writeFileSync(
  resolve(workDir, 'tsconfig.esm.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['consumer-esm.ts'],
    },
    null,
    2,
  ),
);

// --- TS CJS consumer (node resolution, Firebase Functions default) --------
writeFileSync(resolve(workDir, 'consumer-cjs.ts'), tsSource);
writeFileSync(
  resolve(workDir, 'tsconfig.cjs.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['consumer-cjs.ts'],
    },
    null,
    2,
  ),
);

log('green', '✓ consumers written');
log('cyan', `  contents: ${readdirSync(workDir).join(', ')}`);

// ---------------------------------------------------------------------------
// Step 4: typecheck TS consumers
// ---------------------------------------------------------------------------

log('yellow', '\n=== Step 4: typecheck TS consumers ===');

// Install a local typescript we know exists. We use the one already in
// the engine's devDeps to keep the test hermetic.
run(
  `npm install --silent --no-save --no-audit --no-fund typescript@${getDevTsVersion()}`,
  workDir,
);

run('npx -y tsc -p tsconfig.esm.json', workDir);
log('green', '✓ TS ESM typecheck passed');

run('npx -y tsc -p tsconfig.cjs.json', workDir);
log('green', '✓ TS CJS typecheck passed');

// ---------------------------------------------------------------------------
// Step 5: execute the JS consumers
// ---------------------------------------------------------------------------

log('yellow', '\n=== Step 5: execute JS consumers ===');
run('node consumer.mjs', workDir);
run('node consumer.cjs', workDir);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

rmSync(workDir, { recursive: true, force: true });
rmSync(tarballPath, { force: true });

log('green', '\n✓ all pack smoke tests passed');

function getDevTsVersion() {
  const pkg = JSON.parse(
    execSync('cat package.json', { cwd: pkgRoot, encoding: 'utf-8' }),
  );
  // Return the raw range (e.g. "^5.4.0"); npm install accepts ranges directly,
  // and an exact pin like "5.4.0" can fail if that specific patch was never published.
  return pkg.devDependencies?.typescript ?? '^5.4.0';
}
