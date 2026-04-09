#!/usr/bin/env node
/**
 * Vectra CLI entry point.
 *
 * Usage:
 *   vectra init   — create a new instance config
 *   vectra start  — start Vectra with configured instance
 */

const command = process.argv[2];

if (command === 'init') {
  import('./init.js').then((m) => m.init());
} else if (command === 'start') {
  import('../index.js');
} else {
  console.log('Usage: vectra [init|start]');
  console.log('  init   — create a new instance config');
  console.log('  start  — start Vectra with configured instance');
}
