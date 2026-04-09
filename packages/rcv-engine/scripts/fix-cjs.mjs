#!/usr/bin/env node
/**
 * Post-build fixup for the CJS output.
 *
 * The root package.json declares "type": "module", which means every .js
 * file in the published tarball is interpreted by Node as ES module source
 * unless something says otherwise. Our CJS build emits real CommonJS code
 * (`exports.foo = ...`) to ./dist/cjs/*.js, but Node would try to load those
 * files as ESM and crash.
 *
 * The idiomatic fix is to drop a one-line package.json inside ./dist/cjs/
 * that says `{"type": "commonjs"}`. Node's module resolution walks up from
 * the file being loaded and honors the nearest package.json, so this flips
 * the whole cjs directory to CommonJS semantics without affecting the rest
 * of the package.
 *
 * This script is idempotent — running it twice produces the same result.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cjsDir = resolve(here, '..', 'dist', 'cjs');

mkdirSync(cjsDir, { recursive: true });
writeFileSync(
  resolve(cjsDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);

console.log('fix-cjs: wrote dist/cjs/package.json ({"type":"commonjs"})');
