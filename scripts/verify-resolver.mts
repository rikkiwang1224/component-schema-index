/**
 * Verify CSI resolver pipeline
 *
 * Usage:
 *   CSI_DATA_ROOT=/path/to/component-data pnpm verify:resolver
 *
 * Requires registry.json, npm packages installed, and optional examples/flattened-types.
 */
import { join } from 'path';
import { configureCsi, resolveComponentSource, listComponents, formatComponentSourceForAI, getRegisteredLibraries } from '@csi/core';

const dataRoot = process.env.CSI_DATA_ROOT ?? join(process.cwd(), 'data');
configureCsi({ dataRoot });

const libraries = getRegisteredLibraries();

if (libraries.length === 0) {
  console.error('No libraries in registry.json — add at least one library or set CSI_DATA_ROOT');
  process.exit(1);
}

let passed = 0;
let failed = 0;

console.log(`=== CSI Resolver verification (dataRoot: ${dataRoot}) ===\n`);

console.log('--- 1. Component listing ---');
for (const lib of libraries) {
  const components = listComponents(lib);
  if (components.length > 0) {
    console.log(`✓ ${lib}: ${components.length} component dirs`);
    passed++;
  } else {
    console.log(`✗ ${lib}: empty (install npm package: see registry npmPackage)`);
    failed++;
  }
}

console.log('\n--- 2. Type resolution (first registered component per library) ---');
for (const lib of libraries) {
  const dirs = listComponents(lib);
  const compName = dirs[0]
    ? dirs[0].split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    : 'Button';

  const result = resolveComponentSource(lib, compName, false, true);
  if (result?.typesContent) {
    console.log(`✓ ${lib}/${compName}: ${result.typesContent.length} chars`);
    passed++;
  } else {
    console.log(`⚠ ${lib}/${compName}: no types (try another component name in registry)`);
  }
}

console.log('\n--- 3. Format output ---');
for (const lib of libraries.slice(0, 1)) {
  const dirs = listComponents(lib);
  if (dirs.length === 0) continue;
  const compName = dirs[0]
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  const result = resolveComponentSource(lib, compName, false, true);
  if (result) {
    const formatted = formatComponentSourceForAI(result);
    if (formatted.includes('### Import')) {
      console.log(`✓ ${lib}/${compName}: formatted ${formatted.length} chars`);
      passed++;
    } else {
      console.log(`✗ ${lib}/${compName}: format error`);
      failed++;
    }
  }
}

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
