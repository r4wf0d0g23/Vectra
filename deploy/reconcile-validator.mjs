#!/usr/bin/env node
import { reconcileValidator } from '../dist/src/validation/reconcile.js';

const configPath = process.env.VECTRA_VALIDATOR_CONFIG ?? '/etc/vectra/validator.json';
const result = await reconcileValidator(configPath);
console[result.ok ? 'log' : 'error'](JSON.stringify(result));
if (!result.ok) process.exit(1);
