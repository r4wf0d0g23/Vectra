/**
 * PropositionExtractor — extracts structured propositions, entities, conditions,
 * and ambiguities from raw text using nemotron3-super at port 8001.
 *
 * @see docs/esp-critique-response.md §D.2
 */

import { createHash } from 'node:crypto';
import type {
  VectraObservation,
  Proposition,
  Entity,
  Condition,
  Ambiguity,
  TextSpan,
} from './types.js';

const DGX_HOST = '100.78.161.126';
const GEN_URL = `http://${DGX_HOST}:8001/v1/chat/completions`;
const GEN_MODEL = 'nemotron3-super';

// ─── HTTP Helper ─────────────────────────────────────────────────────

async function httpPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${errText.slice(0, 500)}`);
  }
  return res.json();
}

// ─── Extraction Response Shape ────────────────────────────────────────

interface ExtractionResponse {
  propositions?: Array<{
    id?: string;
    text?: string;
    type?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    confidence?: number;
    contradicts?: string[];
  }>;
  entities?: Array<{
    id?: string;
    text?: string;
    type?: string;
    canonical?: string;
    confidence?: number;
  }>;
  conditions?: Array<{
    id?: string;
    expression?: string;
    subject?: string;
    predicate?: string;
    value?: string;
  }>;
  ambiguities?: Array<{
    id?: string;
    description?: string;
    span?: { start?: number; end?: number; text?: string };
    alternativeParses?: string[];
  }>;
}

// ─── PropositionExtractor ─────────────────────────────────────────────

export class PropositionExtractor {
  private modelUrl: string;
  private modelId: string;

  constructor(
    modelUrl: string = GEN_URL,
    modelId: string = GEN_MODEL,
  ) {
    this.modelUrl = modelUrl;
    this.modelId = modelId;
  }

  /**
   * Normalize text: lowercase, collapse whitespace, replace timestamps and
   * UUID-like IDs with generic placeholders.
   */
  canonicalize(text: string): string {
    return text
      .toLowerCase()
      // ISO timestamps
      .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?(z|[+-]\d{2}:?\d{2})?/g, '<timestamp>')
      // Simple date-like strings
      .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
      // UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      // Hex IDs (8+ chars)
      .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Compute a deterministic structural fingerprint from sorted propositions.
   * Sorts by subject+predicate+object so order doesn't affect the hash.
   */
  private structuralFingerprint(propositions: Proposition[]): string {
    const sorted = [...propositions].sort((a, b) => {
      const ka = a.subject + a.predicate + a.object;
      const kb = b.subject + b.predicate + b.object;
      return ka.localeCompare(kb);
    });
    const canonical = JSON.stringify(sorted.map((p) => ({
      text: p.text,
      type: p.type,
      subject: p.subject,
      predicate: p.predicate,
      object: p.object,
    })));
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  /**
   * Compute a simple semantic fingerprint: SHA-256 of canonicalized proposition texts.
   */
  private semanticFingerprint(propositions: Proposition[]): string {
    const texts = propositions.map((p) => this.canonicalize(p.text)).sort().join('|');
    return createHash('sha256').update(texts).digest('hex').slice(0, 16);
  }

  /**
   * Extract a VectraObservation from raw text.
   */
  async extract(text: string, sourceId: string): Promise<VectraObservation> {
    const extractionTimestamp = new Date().toISOString();
    const idBase = createHash('sha256')
      .update(sourceId + text)
      .digest('hex')
      .slice(0, 16);

    const systemPrompt = `You are a proposition extraction engine. Extract structured information from the provided text and return ONLY valid JSON — no prose, no markdown fences, no explanation.

Return a JSON object with these fields:
{
  "propositions": [
    {
      "id": "p1",
      "text": "canonical proposition text",
      "type": "assertion|negation|conditional|temporal|causal",
      "subject": "the subject noun phrase",
      "predicate": "the verb/relation",
      "object": "the object noun phrase",
      "confidence": 0.9,
      "contradicts": []
    }
  ],
  "entities": [
    {
      "id": "e1",
      "text": "original text",
      "type": "person|place|system|event|concept|other",
      "canonical": "normalized lowercase form",
      "confidence": 0.9
    }
  ],
  "conditions": [
    {
      "id": "c1",
      "expression": "human-readable condition",
      "subject": "condition subject",
      "predicate": "condition predicate",
      "value": "condition value"
    }
  ],
  "ambiguities": [
    {
      "id": "a1",
      "description": "what is ambiguous",
      "span": { "start": 0, "end": 10, "text": "ambiguous text" },
      "alternativeParses": ["parse 1", "parse 2"]
    }
  ]
}

Rules:
- Extract all factual claims as propositions
- type=negation for claims about what is NOT the case
- type=conditional for if/when/unless claims
- type=temporal for time-ordered or duration claims
- type=causal for cause/effect claims
- type=assertion for everything else
- confidence is your certainty in the extraction (0-1)
- contradicts lists IDs of propositions that conflict with this one
- Only include ambiguities when the text is genuinely unclear`;

    const userPrompt = `Extract structured information from this text:\n\n${text}`;

    let extracted: ExtractionResponse = {};
    let parseSuccess = false;

    try {
      const data = await httpPost(this.modelUrl, {
        model: this.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0,
      }) as { choices: Array<{ message: { content: string } }> };

      const raw = data.choices[0].message.content.trim();
      // Strip markdown code fences if present
      const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
      extracted = JSON.parse(jsonStr) as ExtractionResponse;
      parseSuccess = true;
    } catch {
      // Fallback: return minimal observation
      return {
        id: idBase,
        sourceId,
        rawText: text,
        propositions: [],
        entities: [],
        conditions: [],
        ambiguities: [],
        structuralFingerprint: createHash('sha256').update('').digest('hex').slice(0, 16),
        semanticFingerprint: createHash('sha256').update('').digest('hex').slice(0, 16),
        confidence: 0.1,
        extractionModel: this.modelId,
        extractionTimestamp,
        evidenceSpans: [],
      };
    }

    if (!parseSuccess) {
      return {
        id: idBase,
        sourceId,
        rawText: text,
        propositions: [],
        entities: [],
        conditions: [],
        ambiguities: [],
        structuralFingerprint: createHash('sha256').update('').digest('hex').slice(0, 16),
        semanticFingerprint: createHash('sha256').update('').digest('hex').slice(0, 16),
        confidence: 0.1,
        extractionModel: this.modelId,
        extractionTimestamp,
        evidenceSpans: [],
      };
    }

    // Normalize extracted data
    const propositions: Proposition[] = (extracted.propositions ?? []).map((p, i) => ({
      id: p.id ?? `p${i + 1}`,
      text: p.text ?? '',
      type: (['assertion', 'negation', 'conditional', 'temporal', 'causal'].includes(p.type ?? '')
        ? p.type
        : 'assertion') as Proposition['type'],
      subject: p.subject ?? '',
      predicate: p.predicate ?? '',
      object: p.object ?? '',
      confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.8,
      contradicts: p.contradicts ?? [],
    }));

    const entities: Entity[] = (extracted.entities ?? []).map((e, i) => ({
      id: e.id ?? `e${i + 1}`,
      text: e.text ?? '',
      type: e.type ?? 'concept',
      canonical: e.canonical ?? (e.text ?? '').toLowerCase(),
      confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.8,
    }));

    const conditions: Condition[] = (extracted.conditions ?? []).map((c, i) => ({
      id: c.id ?? `c${i + 1}`,
      expression: c.expression ?? '',
      subject: c.subject ?? '',
      predicate: c.predicate ?? '',
      value: c.value ?? '',
    }));

    const ambiguities: Ambiguity[] = (extracted.ambiguities ?? []).map((a, i) => {
      const span: TextSpan = {
        start: a.span?.start ?? 0,
        end: a.span?.end ?? 0,
        text: a.span?.text ?? '',
      };
      return {
        id: a.id ?? `a${i + 1}`,
        description: a.description ?? '',
        span,
        alternativeParses: a.alternativeParses ?? [],
      };
    });

    // Heuristic confidence: 1 - ambiguityRate
    const ambiguityRate = ambiguities.length / Math.max(propositions.length, 1);
    const confidence = Math.max(0, Math.min(1, 1 - ambiguityRate));

    return {
      id: idBase,
      sourceId,
      rawText: text,
      propositions,
      entities,
      conditions,
      ambiguities,
      structuralFingerprint: this.structuralFingerprint(propositions),
      semanticFingerprint: this.semanticFingerprint(propositions),
      confidence,
      extractionModel: this.modelId,
      extractionTimestamp,
      evidenceSpans: [],
    };
  }
}
