/**
 * Observation record types — structured extraction layer for ESP v2.
 *
 * @see docs/esp-critique-response.md §D.2
 */

export interface TextSpan {
  start: number;
  end: number;
  text: string;
}

export type PropositionType = "assertion" | "negation" | "conditional" | "temporal" | "causal";

export interface Proposition {
  id: string;
  text: string;             // canonical form
  type: PropositionType;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;       // 0-1
  contradicts?: string[];   // ids of conflicting propositions
}

export interface Entity {
  id: string;
  text: string;
  type: string;             // person, place, system, event, concept, etc.
  canonical: string;        // normalized form
  confidence: number;
}

export interface Condition {
  id: string;
  expression: string;       // human-readable
  subject: string;
  predicate: string;
  value: string;
}

export interface Ambiguity {
  id: string;
  description: string;      // what is ambiguous
  span: TextSpan;
  alternativeParses: string[];
}

export interface VectraObservation {
  // Identity
  id: string;               // deterministic hash of source + extraction
  sourceId: string;         // reference to raw evidence

  // Content
  rawText: string;

  // Extracted structure
  propositions: Proposition[];
  entities: Entity[];
  conditions: Condition[];
  ambiguities: Ambiguity[];

  // Fingerprints
  structuralFingerprint: string;   // hash of proposition graph
  semanticFingerprint: string;     // ESV-style hash of proposition embeddings

  // Metadata
  confidence: number;              // 0-1
  extractionModel: string;
  extractionTimestamp: string;
  evidenceSpans: TextSpan[];

  // Embeddings (nullable — populated lazily)
  documentEmbedding?: number[];
  propositionEmbeddings?: number[][];
}
