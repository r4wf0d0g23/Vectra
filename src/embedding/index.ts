/**
 * Embedding Stability Protocol — public API.
 */
export { VECTRA_ANCHOR_SET, ANCHOR_TEXTS, ANCHOR_SET_VERSION } from './anchor-set.js';
export type { AnchorEntry, AnchorDomain } from './anchor-set.js';

export { Embedder } from './embedder.js';

export {
  computeESV,
  compareESV,
  computePairwiseDistances,
  cosineDistance,
} from './esv.js';
export type { ESV, ESVComparison } from './esv.js';

export { DriftDetector } from './drift-detector.js';
export type { DriftReport } from './drift-detector.js';

export * from './compatibility.js';
export * from './types.js';
export * from './calibration-store.js';
export * from './esp-params.js';
export * from './threshold-optimizer.js';
