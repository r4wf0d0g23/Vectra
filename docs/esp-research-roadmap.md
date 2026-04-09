# ESP Research Roadmap — Prioritized Experiments & 30-Day Plan

**Author:** Opus Research Architect  
**Date:** 2026-04-09  
**Status:** Active research plan  
**Purpose:** Move ESP from "validated primitives" to "credible, falsifiable protocol"  

---

## A. Prioritized Research Queue

Ranked by **impact × feasibility / cost**. Items that can kill the ESP hypothesis are flagged with ☠️.

### Rank 1: Cross-Model ESV Comparison ☠️

**Question:** Do different embedding models produce different ESVs, and do ESV compatibility verdicts correlate with actual retrieval quality?

**Why highest priority:** This is the single experiment that can validate or kill ESP's core claim. Currently, ESP has only been tested in self-comparison (same model → same ESV, trivially) and synthetic Gaussian noise (fake drift, not real model differences). If two genuinely different models produce ESVs that ESP classifies as "incompatible" but they actually retrieve equally well — or ESP says "compatible" but retrieval breaks — the protocol's detection mechanism is fundamentally flawed.

**Experiment:**
1. Embed the 27 anchors with 4 models (see §C for specifics)
2. Compute ESV for each model
3. Compute all 6 pairwise ESV comparisons
4. For each pair, run retrieval quality benchmark on a shared corpus
5. Plot ESP severity vs. actual retrieval quality delta

**Infrastructure:** DGX GB10 (nemotron-embed port 8004), Jetson1 (nemotron-embed localhost:8004), OpenAI API (text-embedding-3-small, text-embedding-3-large)

**Success:** ESP compatibility verdict predicts retrieval quality — compatible pairs have <5% quality delta, incompatible pairs have >15% delta. ESVs for same-family models (nemotron-embed on DGX vs Jetson) are identical.

**Failure (kills ESP):** No correlation between ESP verdict and retrieval quality. Or: all models produce "incompatible" ESVs (trivially true and useless). Or: models with "compatible" ESVs produce very different retrieval results.

**Effort:** ~4 hours engineering + ~2 hours compute. OpenAI API cost: ~$0.50 for 4 model × 27 anchor embeds + corpus.

**Dependencies:** None. Can run today.

---

### Rank 2: Scale Benchmark (Multi-Document Retrieval) ☠️

**Question:** Does K=3 binary retrieval match full-text quality when the corpus has hundreds of chunks instead of 4?

**Why critical:** The current K=3 = 100% result is on 4 chunks total. K=3 retrieves 75% of the entire document. At 400 chunks, K=3 retrieves 0.75%. If quality collapses at scale, the entire dual-space architecture thesis is undermined — not just ESP, but the 70x speedup value proposition.

**Experiment:**
1. Assemble a 50-100 document corpus (see §D for design)
2. Generate diverse queries via Opus/Sonnet
3. Run retrieval quality at K=1,3,5,10,20,50 against full-text baseline
4. Find the crossover K where binary matches full-text (±5% quality)
5. Test whether crossover K is stable across corpus sizes (10, 50, 100 docs)

**Infrastructure:** DGX GB10 for nemotron-embed. OpenAI API as a cheaper alternative for the OpenAI embedding models. Opus for external judging (~$5-10 in API costs for 200+ judged pairs).

**Success:** K=3 still achieves >90% quality at 100+ docs, or a predictable crossover K exists (e.g., K=10) that scales sublinearly with corpus size.

**Failure (kills dual-space thesis):** K scales linearly with corpus size (need K=75 for 100 docs, K=750 for 1000 docs) — binary retrieval has no advantage over scanning.

**Effort:** ~8 hours engineering + ~4 hours compute. ~$10 API costs for judging.

**Dependencies:** None. Can run today. Benefits from cross-model comparison (Rank 1) to test K crossover across models.

---

### Rank 3: Anchor Set Ablation & Coverage

**Question:** Are 27 anchors necessary? Are they sufficient? Which anchors matter most?

**Why important:** The anchor set is the foundation of ESP. If removing 10 anchors doesn't change detection quality, the set has redundancy. If there are embedding space regions where drift goes undetected, the set has blind spots. Both problems are fixable, but only if measured.

**Experiment:**
1. Leave-one-out ablation: remove each anchor, recompute ESV, check if detection quality degrades on the cross-model pairs from Rank 1
2. Domain ablation: remove entire domains (e.g., all 7 task-routing anchors), measure detection degradation
3. Random baseline: sample 27 random sentences from a diverse corpus, compute ESV, compare detection quality against the curated set
4. Coverage test: embed 1,000+ diverse texts, compute per-region drift sensitivity (can drift in the "medical terminology" region of the space be detected by the agentic-domain anchors?)

**Infrastructure:** Same as Rank 1 (models already loaded).

**Success:** Some anchors are more critical than others (non-uniform importance), the curated set outperforms random selection, and blind spots are identifiable and addressable by adding targeted anchors.

**Failure (weakens ESP but doesn't kill it):** Random anchors perform equally well → the curation effort was wasted, but ESP still works. OR: blind spots are pervasive → anchor set needs fundamental redesign.

**Effort:** ~6 hours engineering + ~3 hours compute.

**Dependencies:** Requires Rank 1 cross-model pairs to measure detection quality against.

---

### Rank 4: Adversarial Anchor Evasion ☠️

**Question:** Can two models agree on all 27 anchors but diverge on real content?

**Why important:** This tests whether the anchor set is a *superficial probe* (easy to game) or a *genuine space characterizer* (hard to fool). If you can fine-tune a model to preserve anchor geometry while scrambling everything else, ESP is security theater.

**Experiment:**
1. Take nemotron-embed embeddings for anchors as "target geometry"
2. Fine-tune a small sentence-transformer to minimize anchor drift while maximizing general embedding divergence (adversarial loss: `L = -λ₁·anchor_drift + λ₂·general_drift`)
3. Test if the fine-tuned model passes ESP anchor test
4. Test if retrieval quality is destroyed despite passing

**Infrastructure:** DGX GB10 for fine-tuning (sentence-transformers are small enough). ~2-4 hours GPU time.

**Success (for ESP):** Adversarial fine-tuning that preserves anchor geometry also preserves general geometry — the anchors genuinely constrain the space.

**Failure (for ESP):** Easy to create a model that passes anchors but fails on real content. This would mean ESP needs the denser probing approach (1000+ random anchors) rather than 27 curated ones.

**Effort:** ~12 hours engineering + ~4 hours compute. This is the most complex experiment.

**Dependencies:** Requires cross-model baseline (Rank 1) to calibrate what "normal" divergence looks like.

---

### Rank 5: Threshold Calibration

**Question:** Are the proposed thresholds (0.05, 0.10, 0.15 cosine distance) correctly separating compatible from incompatible model pairs?

**Experiment:**
1. Collect ESV comparisons from all cross-model pairs (Rank 1 output)
2. For each pair, measure actual retrieval quality delta
3. Plot ROC curves: at what threshold does ESP correctly classify compatible vs. incompatible?
4. Compute AUC — does ESP have diagnostic power?

**Infrastructure:** Pure computation on Rank 1 outputs. No additional GPU time.

**Success:** AUC > 0.85. Clear threshold exists where compatible/incompatible separation is reliable.

**Failure:** AUC < 0.65. Thresholds cannot separate compatible from incompatible regardless of tuning → ESP's geometric comparison approach lacks discriminative power.

**Effort:** ~2 hours engineering. Zero compute cost (uses data from Rank 1).

**Dependencies:** Requires Rank 1 cross-model data.

---

### Rank 6: Ordering Preservation Test

**Question:** Does the O(n³) ordering test from ESP spec §2.3 provide better signal than the simpler mean-drift metric?

**Experiment:**
1. For each cross-model pair from Rank 1, compute both metrics: (a) mean pairwise drift, (b) ordering inversion rate
2. Correlate each with actual retrieval quality delta
3. Determine which metric is more predictive

**Infrastructure:** Pure computation. The O(n³) test on 27 anchors is ~19,683 comparisons — trivial.

**Success:** Ordering inversion rate correlates more strongly with retrieval quality than mean drift → use it as primary metric.

**Failure:** Neither correlates well → need different metrics entirely.

**Effort:** ~2 hours engineering. Zero compute cost.

**Dependencies:** Requires Rank 1 data.

---

### Rank 7: Quantization Drift Measurement

**Question:** How much drift does INT8/INT4 quantization introduce to nemotron-embed, and does ESP correctly detect it?

**Experiment:**
1. If nemotron-embed supports different quantization levels on DGX, run anchors at FP32, FP16, INT8
2. Compute ESV at each quantization level
3. Compare ESVs and measure retrieval quality at each level

**Infrastructure:** DGX GB10. Depends on vLLM quantization options for the current nemotron-embed deployment.

**Success:** Quantization drift is small (< 0.02 per ESP spec prediction), ESV detects it correctly, retrieval quality is preserved.

**Failure:** Quantization introduces more drift than expected, or ESV misclassifies it.

**Effort:** ~3 hours engineering + ~1 hour compute.

**Dependencies:** Requires verifying vLLM supports runtime quantization changes for nemotron-embed.

---

### Rank 8: Proposition Stability vs Embedding Stability (ESP v2)

**Question:** Can embeddings be stable (L3 passes) while proposition extraction is unstable (L4 fails)?

**Experiment:**
1. Use the L4 assessment already in `src/esp/layers.ts`
2. Construct ambiguous test texts (sentences with multiple valid parses)
3. Run L3 + L4 assessments, look for L3-stable/L4-unstable cases
4. Measure downstream decision impact

**Infrastructure:** Requires an LLM for proposition extraction (nemotron3-super on DGX, or Sonnet via API).

**Success (for ESP v1):** L3 stability implies L4 stability for well-formed content → single-layer ESP is sufficient.

**Failure (for ESP v1, success for ESP v2):** L3/L4 divergence exists → multi-layer detection is necessary.

**Effort:** ~6 hours engineering + ~2 hours compute.

**Dependencies:** Requires proposition extractor to be wired to a real model (currently `PropositionExtractor` exists as an interface in `src/observation/extractor.ts` but may need a concrete implementation).

---

## B. Critical Path

The 3 experiments that most rapidly advance ESP from "validated primitives" to "credible, falsifiable protocol":

### Experiment 1 → Cross-Model ESV Comparison (Rank 1)

**Why first:** Everything else depends on having real cross-model data. Without it, ESP is validated only against itself. This experiment produces the dataset that all subsequent analyses (threshold calibration, ordering test, ablation) operate on.

**Minimum viable experiment:** Embed 27 anchors with 3 models: nemotron-embed (DGX), text-embedding-3-small (OpenAI), text-embedding-3-large (OpenAI). Compute 3 ESVs. Run 3 pairwise comparisons. Run retrieval quality on a 10-doc corpus for each model. Total: ~3 hours.

**What it proves:** Whether ESV has any diagnostic power at all over real model differences.

### Experiment 2 → Scale Benchmark (Rank 2)

**Why second:** The K=3 = 100% claim is the foundation of the dual-space value proposition. If it doesn't hold at scale, the product thesis changes fundamentally. Run this immediately after cross-model comparison because it shares infrastructure (embedding models, judge model) and the corpus built for scaling can be reused for cross-model quality testing.

**Minimum viable experiment:** 20 documents (Wikipedia articles, arxiv abstracts — varied domains), ~100 total chunks, 50 queries generated by Opus, K=1,3,5,10 evaluated by Opus external judge. Total: ~4 hours including query generation and judging.

**What it proves:** Whether binary retrieval quality degrades predictably with corpus scale, and what K is actually needed.

### Experiment 3 → Anchor Set Ablation (Rank 3)

**Why third:** After Experiments 1 and 2 produce real cross-model data at scale, ablation tells us whether the 27-anchor set is justified or needs redesign. This is the final piece needed to publish ESP as a credible protocol — "here's the anchor set, here's why these anchors, here's what happens when you remove them."

**Minimum viable experiment:** Leave-one-out on 27 anchors (27 runs) + domain-removal on 5 domains (5 runs) + 3 random baselines. Measure detection quality degradation against the cross-model pairs from Experiment 1. Total: ~3 hours.

**What it proves:** Whether the anchor set design is principled or arbitrary.

### Why these three?

They form a logical chain:
1. **Cross-model** establishes that ESP can detect real differences (not just synthetic noise)
2. **Scale benchmark** validates the retrieval architecture ESP is designed to protect
3. **Ablation** validates the probe set that ESP uses for detection

If all three succeed, ESP has: real cross-model validation, a retrieval architecture confirmed at scale, and a justified anchor set. That's a credible protocol. If any fail, we know exactly what needs to change.

---

## C. Cross-Model ESV Comparison Design

### Models to Compare

| # | Model | Source | Endpoint | Dimensions | Notes |
|---|-------|--------|----------|-----------|-------|
| 1 | `nemotron-embed` | NVIDIA | DGX GB10 `rawdata@100.78.161.126:8004` | 2048 | Current baseline. ESV: `eb29870568bd` |
| 2 | `nemotron-embed` | NVIDIA | Jetson1 `localhost:8004` | 2048 | Same model, different hardware. Tests determinism. |
| 3 | `text-embedding-3-small` | OpenAI | `api.openai.com` | 1536 | Different architecture, different dimensions |
| 4 | `text-embedding-3-large` | OpenAI | `api.openai.com` | 3072 | Same family as #3, larger |

**Note on dimensionality:** Models 3 and 4 have different dimensions than model 1. Direct ESV comparison via fingerprint hash requires same dimensions. However, the *geometry comparison* (normalized pairwise distance matrix) is dimension-independent — we compare the 27×27 distance matrices, not the raw vectors. The `compareESV()` function in `esv.ts` already operates on the fingerprint matrix, which is dimensionless. The `compact` ESV string includes dimensions, so compact-string comparison will correctly flag incompatibility. The geometry comparison via Frobenius norm of fingerprint delta will work across dimensions.

**Dimensionality handling for retrieval quality comparison:** When comparing retrieval quality across models of different dimensions, each model operates in its own space. The question is not "can model A's vectors be used in model B's index" (they can't, different dimensions) but "does ESP's geometric compatibility verdict correlate with whether two models produce similar retrieval rankings for the same corpus?"

### Test Corpus

**Size:** 20 documents, ~100-120 total chunks at 512 tokens each.

**Sources (public domain, no licensing issues):**
- 5 Wikipedia articles: varied domains (history, science, technology, geography, biography)
- 5 arXiv abstracts: ML/NLP papers (domain-relevant to embedding models)
- 5 technical documentation pages: Python stdlib, Node.js API, Rust book (agentic-relevant)
- 5 news articles: recent events from public RSS feeds

**Why this mix:** Tests ESP across semantic domains. If the anchor set (designed for agentic operations) only detects drift in agentic content but misses drift in general content, that's a critical finding.

### Metrics to Compute

For each model pair (6 pairs from 4 models):

1. **Pairwise fingerprint Frobenius distance** — `||G_A - G_B||_F` where G is the 27×27 distance matrix
2. **Mean per-anchor drift** — for same-dimension pairs only: `mean(cosine_distance(E_A(anchor_i), E_B(anchor_i)))`
3. **Ordering inversion rate** — percentage of anchor triplet orderings that flip between models
4. **ESP compatibility verdict** — output of `compareESV()`
5. **Retrieval quality delta** — for each model, run 50 queries against the 20-doc corpus, score with Opus, compute `|quality_A - quality_B|`
6. **Rank correlation (Kendall's τ)** — for each query, compare the ranking of top-10 retrieved chunks between models

### Success vs. Failure Criteria

**"Anchor set works across models":**
- Fingerprint Frobenius distance is < 0.5 for same-family models (nemotron DGX vs Jetson)
- Fingerprint Frobenius distance is > 2.0 for cross-family models (nemotron vs OpenAI)
- ESP correctly classifies same-family as compatible, cross-family as incompatible
- Retrieval quality within compatible pairs has < 5% delta
- Retrieval quality between incompatible pairs has > 15% delta

**"Anchor set is model-specific" (bad outcome):**
- All cross-model pairs produce high Frobenius distance (even same-family)
- OR: Frobenius distance doesn't correlate with retrieval quality delta
- → Anchor set captures model idiosyncrasies, not semantic geometry

### DGX Time Estimate

- Embedding 27 anchors × 2 nemotron runs: ~2 seconds (545ms per run, measured)
- Embedding 120 chunks × 2 nemotron runs: ~30 seconds
- Embedding 50 queries × 2 nemotron runs: ~15 seconds
- Total nemotron DGX time: **< 1 minute**
- OpenAI API calls: ~340 embeds (27 anchors + 120 chunks + 50 queries) × 2 models = 680 calls. Cost: ~$0.02 (text-embedding-3-small) + ~$0.26 (text-embedding-3-large) = **~$0.30**
- Opus judging: 50 queries × 4 models × ~500 tokens per judgment = ~100K tokens. Cost: **~$3**

Total: < 1 minute DGX, ~$3.30 API costs. This is a **weekend afternoon experiment**, not a research program.

### Pseudocode for Experiment Runner

```typescript
import { Embedder } from '../embedding/embedder.js';
import { ANCHOR_TEXTS } from '../embedding/anchor-set.js';
import { computeESV, compareESV, cosineDistance } from '../embedding/esv.js';

interface ModelConfig {
  name: string;
  endpoint: string;
  apiKey?: string;
  dimensions: number;
}

interface CrossModelResult {
  modelA: string;
  modelB: string;
  frobeniusDistance: number;
  espVerdict: 'compatible' | 'warning' | 'incompatible';
  meanAnchorDrift: number | null;  // null if different dimensions
  orderingInversionRate: number;
  retrievalQualityDeltaAtK3: number;
  kendallTauAtK10: number;
}

async function runCrossModelExperiment(
  models: ModelConfig[],
  corpus: string[],       // chunked documents
  queries: string[],      // test queries with known answers
): Promise<CrossModelResult[]> {
  
  // Step 1: Compute ESVs for all models
  const esvs = new Map<string, { esv: ReturnType<typeof computeESV>; anchorVecs: number[][]; chunkVecs: number[][]; queryVecs: number[][] }>();
  
  for (const model of models) {
    const embedder = new Embedder(model.endpoint, model.apiKey);
    
    const anchorVecs = await embedder.embed(ANCHOR_TEXTS);
    const chunkVecs = await embedder.embed(corpus);
    const queryVecs = await embedder.embed(queries);
    const esv = computeESV(anchorVecs, model.name);
    
    esvs.set(model.name, { esv, anchorVecs, chunkVecs, queryVecs });
  }
  
  // Step 2: Pairwise comparisons
  const results: CrossModelResult[] = [];
  
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = esvs.get(models[i].name)!;
      const b = esvs.get(models[j].name)!;
      
      // ESV comparison (works across dimensions — compares distance matrices)
      const comparison = compareESV(a.esv, b.esv);
      
      // Mean anchor drift (only for same-dimension pairs)
      let meanAnchorDrift: number | null = null;
      if (models[i].dimensions === models[j].dimensions) {
        const drifts = ANCHOR_TEXTS.map((_, k) =>
          cosineDistance(a.anchorVecs[k], b.anchorVecs[k])
        );
        meanAnchorDrift = drifts.reduce((s, d) => s + d, 0) / drifts.length;
      }
      
      // Ordering inversion rate
      const n = ANCHOR_TEXTS.length;
      let inversions = 0;
      let totalTriplets = 0;
      for (let ai = 0; ai < n; ai++) {
        for (let aj = ai + 1; aj < n; aj++) {
          for (let ak = 0; ak < n; ak++) {
            if (ak === ai || ak === aj) continue;
            totalTriplets++;
            const orderA = a.esv.fingerprint[ai][ak] < a.esv.fingerprint[aj][ak];
            const orderB = b.esv.fingerprint[ai][ak] < b.esv.fingerprint[aj][ak];
            if (orderA !== orderB) inversions++;
          }
        }
      }
      const inversionRate = totalTriplets > 0 ? inversions / totalTriplets : 0;
      
      // Retrieval quality comparison
      // For each query, get top-10 chunks from each model's space
      const rankingsA = queries.map((_, qi) =>
        getTopK(a.queryVecs[qi], a.chunkVecs, 10)
      );
      const rankingsB = queries.map((_, qi) =>
        getTopK(b.queryVecs[qi], b.chunkVecs, 10)
      );
      
      // Kendall's tau between rankings
      const taus = queries.map((_, qi) =>
        kendallTau(rankingsA[qi], rankingsB[qi])
      );
      const meanTau = taus.reduce((s, t) => s + t, 0) / taus.length;
      
      // Quality delta requires Opus judging (external process)
      // Placeholder — actual quality scoring done in separate pass
      const qualityDelta = -1; // computed after Opus judging
      
      results.push({
        modelA: models[i].name,
        modelB: models[j].name,
        frobeniusDistance: comparison.frobeniusDistance,
        espVerdict: comparison.recommendation,
        meanAnchorDrift: meanAnchorDrift,
        orderingInversionRate: inversionRate,
        retrievalQualityDeltaAtK3: qualityDelta,
        kendallTauAtK10: meanTau,
      });
    }
  }
  
  return results;
}

function getTopK(query: number[], chunks: number[][], k: number): number[] {
  const scored = chunks.map((c, i) => ({ i, d: cosineDistance(query, c) }));
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, k).map(s => s.i);
}

function kendallTau(rankA: number[], rankB: number[]): number {
  // Kendall rank correlation between two orderings
  let concordant = 0, discordant = 0;
  for (let i = 0; i < rankA.length; i++) {
    for (let j = i + 1; j < rankA.length; j++) {
      const posAi = rankB.indexOf(rankA[i]);
      const posAj = rankB.indexOf(rankA[j]);
      if (posAi === -1 || posAj === -1) continue; // item not in both lists
      if (posAi < posAj) concordant++;
      else discordant++;
    }
  }
  const total = concordant + discordant;
  return total > 0 ? (concordant - discordant) / total : 0;
}
```

---

## D. Scale Benchmark Design

### Target Corpus

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Documents | 50-100 | 10x-25x current benchmark (1 doc) |
| Total chunks (512 tokens) | 400-800 | K=3 represents 0.4%-0.75% of corpus |
| Domains | 5+ (tech, science, news, legal, medical) | Tests domain generalization |
| Doc sizes | 1K-32K tokens each | Tests chunking at different granularities |

**Corpus source:** Use publicly available datasets — no data collection needed:
- **MS MARCO passages** (100K+ passages, public): sample 50-100 with existing relevance judgments
- **Natural Questions** (Google, public): sample 50-100 with answer spans
- **SQuAD 2.0** (public): sample for exact-match evaluation

Using datasets with existing ground truth eliminates the need for Opus to judge answer correctness from scratch — it only judges whether the retrieved context was sufficient.

### Query Diversity

For each document, generate 3 query types:
1. **Point query** — single fact, single chunk answer (like entity specificity)
2. **Span query** — answer spans 2-3 chunks (like sequential reasoning)
3. **Synthesis query** — answer requires combining info from 3+ chunks or multiple documents

Generation method: Use Opus to generate queries from the documents, then shuffle so queries are not co-located with their source documents in the evaluation pipeline.

Target: **150-300 queries** (3 per document × 50-100 documents).

### Crossover Point Detection

```
For K in [1, 2, 3, 5, 10, 15, 20, 30, 50]:
  For each query:
    binary_answer = generate(model, topK(query, K))
    fulltext_answer = generate(model, full_document)
    score = opus_judge(binary_answer, fulltext_answer, ground_truth)
  
  retention[K] = mean(scores) / mean(fulltext_scores)

Plot: K vs. retention
Find: K* where retention > 0.95
Test: Is K* stable across corpus sizes 10, 50, 100?
```

**Crossover stability test:** Run the full benchmark at 10 docs (40 chunks), 50 docs (200 chunks), 100 docs (800 chunks). If K* shifts proportionally with corpus size, binary retrieval doesn't scale. If K* is constant or sublinear, it does.

### Infrastructure Without DGX

**OpenAI text-embedding-3-small:** $0.02/1M tokens. A 100-doc corpus with 300 queries:
- Corpus: ~200K tokens to embed = $0.004
- Queries: ~30K tokens to embed = $0.001
- Total embedding cost: **< $0.01**

**Generation model (for answering):** Use gpt-4o-mini at $0.15/1M input tokens. 300 queries × avg 2K tokens context = 600K input tokens = **$0.09**

**Opus judging:** 300 pairs × ~500 tokens per judgment = 150K tokens = **~$2.25**

**Total cost for a full scale benchmark on OpenAI: ~$2.35.** This can run on a laptop with an API key. No DGX required.

### Weekend Run Timeline

| Phase | Duration | What |
|-------|----------|------|
| Corpus prep | 2 hours | Download MS MARCO/NQ subsets, chunk, validate |
| Query generation | 1 hour | Opus generates 300 queries |
| Embedding | 30 min | Embed all chunks + queries (OpenAI API, fast) |
| Retrieval runs | 1 hour | K=1,2,3,5,10,15,20,30,50 × 300 queries |
| Answer generation | 2 hours | 300 queries × 9 K values × generation model |
| Opus judging | 2 hours | 2,700 answer pairs scored |
| Analysis | 2 hours | Plot curves, find crossover, write up |
| **Total** | **~10 hours** | Fits in a weekend with breaks |

---

## E. Anchor Set Validation Design

### Coverage Test

**Method:**
1. Embed 10,000 diverse texts (sample from C4, Wikipedia, code, legal, medical)
2. For each text, find its nearest anchor (by cosine distance)
3. Compute coverage map: what fraction of texts has a "nearby" anchor (< 0.5 cosine distance)?
4. Identify "desert regions" — areas of the embedding space far from all anchors
5. Simulate drift in desert regions: add noise to embeddings of desert-region texts
6. Test whether ESP detects the drift via anchor comparison

**What we're looking for:** If >20% of diverse texts are in desert regions (far from all anchors), ESP has blind spots. Those blind spots are where adversarial or accidental drift would go undetected.

**Infrastructure:** DGX nemotron-embed for 10K texts. At ~500 texts/second (based on 545ms for 27 texts), this is ~20 seconds of DGX time.

### Ablation

**Leave-one-out protocol:**
1. For each anchor i (i = 1..27):
   - Compute ESV using anchors {1..27} \ {i} (26 anchors)
   - Run cross-model comparison (from Rank 1 data)
   - Compute detection quality: does the 26-anchor ESV still correctly classify compatible/incompatible pairs?
2. Record detection quality for each removal
3. Rank anchors by importance: most-to-least impact on detection quality when removed

**Domain-removal protocol:**
1. For each domain d in {task-routing, memory-context, identity-role, tool-use, system-state}:
   - Remove all anchors from domain d
   - Recompute ESV with remaining anchors
   - Measure detection quality
2. Rank domains by contribution to detection quality

**Expected outcome:** Some anchors/domains are critical (removal degrades detection). Some are redundant (removal has no effect). This justifies either trimming the set or expanding it.

### Adversarial Cases

**Finding two models that agree on anchors but diverge elsewhere:**

1. Take nemotron-embed baseline anchor embeddings (the "target geometry")
2. Create a synthetic "adversarial" embedding space:
   - For anchors: use nemotron's exact geometry (passes ESP)
   - For non-anchor texts: apply a random rotation (breaks real retrieval)
3. Test if ESP reports "compatible" for this synthetic space
4. If it does → ESP is fooled by anchor agreement alone

More realistically:
5. Fine-tune a small sentence-transformer (all-MiniLM-L6-v2, 384 dims) with adversarial loss:
   ```
   L = -α · mean_anchor_drift + β · mean_general_drift
   ```
   Where α minimizes anchor drift and β maximizes general drift
6. This produces a model that "looks like" it agrees with nemotron on anchors but diverges elsewhere

If this attack succeeds: ESP needs denser probing (100+ anchors) or randomized anchor selection per check.

### Recommended Anchor Set Size

**Mathematical justification:**

The anchor set must sample the embedding space densely enough that drift in any occupied region is detected by at least one nearby anchor. For a d-dimensional unit sphere (d=2048 for nemotron-embed):

- The number of points needed to ε-cover a d-dimensional sphere grows as O((1/ε)^d) — exponential in d. This is intractable.
- But real embeddings don't uniformly fill the sphere. They concentrate on a low-dimensional manifold. Empirical intrinsic dimensionality of sentence embeddings is typically 20-50.
- For intrinsic dimension k=30, ε-covering with ε=0.5 (half the space width) requires ~2^30 points — still too many.

**Practical conclusion:** You cannot cover a high-dimensional embedding space with a fixed probe set. 27 anchors is not enough for complete coverage. 270 is not enough. The anchor set works not because it covers the space, but because **drift tends to be global, not local.** Model updates, quantization, and fine-tuning affect the entire space, not individual pockets.

**Validation test:** After running the coverage experiment (10K texts), measure the correlation between "nearest anchor distance" and "drift detection sensitivity." If drift detection is equally good for texts near and far from anchors, global drift dominates and the anchor count doesn't matter much. If detection is poor for far-from-anchor texts, we need more anchors or a different approach.

**Recommendation:** Start with 27 (current). After the coverage and ablation experiments, the data will justify one of:
- **Keep 27:** global drift dominates, anchor count doesn't matter
- **Trim to 15-20:** some anchors are redundant, smaller set is equally effective
- **Expand to 50-100:** local drift exists in important regions, need denser probing
- **Switch to randomized probing:** fixed anchors are gameable, random per-check is more robust

---

## F. What to Build Next

### Missing from `src/benchmark/`

| File | Purpose | Priority |
|------|---------|----------|
| `cross-model-bench.ts` | Runs the cross-model ESV comparison experiment (§C). Takes a list of model endpoints, embeds anchors + corpus + queries, computes all pairwise ESV comparisons, produces JSON results. | **P0 — needed for Experiment 1** |
| `scale-bench.ts` | Runs the scale benchmark (§D). Downloads/loads a multi-document corpus, generates queries, runs retrieval at multiple K values, outputs results for external judging. | **P0 — needed for Experiment 2** |
| `corpus-loader.ts` | Loads and chunks a multi-document corpus from disk or downloads from public datasets (MS MARCO, NQ). Handles 512-token chunking with overlap. | P0 — dependency of `scale-bench.ts` |
| `query-generator.ts` | Generates diverse queries from a corpus using an LLM (Opus/Sonnet). Produces point, span, and synthesis queries with ground-truth answers. | P1 — can use manual queries initially |
| `opus-judge.ts` | Calls Opus API to judge answer quality (already partially implemented in `retrieval-quality-bench-v2.ts`, needs extraction into reusable module). | P1 — extract from v2 bench |
| `kendall-tau.ts` | Rank correlation computation for comparing retrieval rankings across models. | P1 — small utility |

### Missing from `src/embedding/`

| File/Function | Purpose | Priority |
|---------------|---------|----------|
| `embedder.ts` → add OpenAI support | Current `Embedder` class targets a single OpenAI-compatible endpoint. Needs to support OpenAI's actual API (different auth headers, model parameter). | **P0 — needed for cross-model experiment** |
| `procrustes.ts` | Orthogonal Procrustes alignment (SVD-based). Pseudocode exists in ESP spec Appendix A.3. Needed for alignment experiments. | P2 — not needed for critical path |
| `ordering-test.ts` | O(n³) ordering inversion rate computation. Simple but should be a reusable function. | P1 — needed for Experiment 1 analysis |

### Missing from `src/esp/`

| File/Function | Purpose | Priority |
|---------------|---------|----------|
| `layers.ts` → wire L4 to real extractor | L4 assessment calls `PropositionExtractor.extract()` but needs a concrete implementation backed by an LLM. | P2 — needed for Rank 8 experiment |
| `anchor-ablation.ts` | Leave-one-out and domain-removal analysis. Takes cross-model ESV data, recomputes ESVs with subsets, measures detection quality change. | P1 — needed for Experiment 3 |
| `coverage-analyzer.ts` | Takes 10K+ embeddings and 27 anchor embeddings, computes nearest-anchor distances, identifies desert regions. | P1 — needed for anchor coverage test |

### Summary: Build Order

1. **`cross-model-bench.ts`** + OpenAI embedder support → unlocks Experiment 1
2. **`corpus-loader.ts`** + **`scale-bench.ts`** → unlocks Experiment 2
3. **`anchor-ablation.ts`** + **`ordering-test.ts`** → unlocks Experiment 3
4. **`coverage-analyzer.ts`** → unlocks anchor coverage validation
5. **`procrustes.ts`** → unlocks alignment experiments (later)

---

## G. 30-Day Plan

### Week 1: Cross-Model Validation (Days 1-7)

**Goal:** Answer "does ESP detect real model differences?"

| Day | Task | Output |
|-----|------|--------|
| 1-2 | Build `cross-model-bench.ts`, add OpenAI support to `Embedder` | Working cross-model benchmark runner |
| 3 | Run cross-model ESV comparison: nemotron (DGX), nemotron (Jetson), text-embedding-3-small, text-embedding-3-large | 4 ESVs, 6 pairwise comparisons |
| 4 | Build `corpus-loader.ts`, download MS MARCO subset (50 docs) | Chunked corpus ready for retrieval benchmark |
| 5 | Run retrieval quality for each model on the 50-doc corpus (K=3), Opus judge | Quality scores per model |
| 6 | Compute correlation: ESP verdict vs quality delta | ROC curve, AUC, threshold analysis |
| 7 | Write up results, update executive report | `docs/esp-cross-model-results.md` |

**Decision gate:** If ESP verdict has AUC < 0.7 against quality, stop and redesign the comparison mechanism before proceeding. If AUC > 0.85, proceed with confidence.

### Week 2: Scale Benchmark (Days 8-14)

**Goal:** Answer "does K=3 hold at scale?"

| Day | Task | Output |
|-----|------|--------|
| 8-9 | Build `scale-bench.ts` and `query-generator.ts` | Scale benchmark runner with query generation |
| 10 | Generate 150 queries across 50-doc corpus using Opus | Diverse query set with ground truth |
| 11 | Run scale benchmark: K=1,2,3,5,10,15,20 × 150 queries | Raw retrieval + answer data |
| 12 | Opus judges 1,050 answer pairs (150 queries × 7 K values) | Quality retention curves |
| 13 | Repeat at 20 docs and 100 docs (if available), test crossover stability | K* vs corpus size data |
| 14 | Write up results, find crossover K, update positioning | `docs/benchmark-retrieval-quality-v3.md` |

**Decision gate:** If K* > 20 at 100 docs, the dual-space architecture needs K-adaptive retrieval, not fixed K=3. Update product claims accordingly.

### Week 3: Anchor Validation & Ablation (Days 15-21)

**Goal:** Answer "is the 27-anchor set justified?"

| Day | Task | Output |
|-----|------|--------|
| 15 | Build `anchor-ablation.ts` and `coverage-analyzer.ts` | Ablation and coverage tools |
| 16 | Run leave-one-out ablation (27 runs) + domain removal (5 runs) | Anchor importance ranking |
| 17 | Run random baseline comparison (3 × 27 random anchor sets) | Curated vs random detection quality |
| 18 | Run coverage analysis: embed 5K diverse texts, map to nearest anchors | Coverage map, desert regions |
| 19 | Simulate drift in desert regions, test detection | Desert region vulnerability data |
| 20 | Run ordering inversion test on all cross-model pairs | Ordering test vs mean-drift comparison |
| 21 | Write up results, recommend anchor set changes | `docs/esp-anchor-validation.md` |

**Decision gate:** If random anchors perform within 10% of curated anchors, the curation effort was wasted — switch to randomized probing. If desert regions show undetected drift, expand the anchor set.

### Week 4: Documentation, Falsification, Publication (Days 22-30)

**Goal:** Document findings honestly, run remaining falsification experiments, prepare for publication.

| Day | Task | Output |
|-----|------|--------|
| 22 | Attempt adversarial anchor evasion (simplified version: synthetic, not fine-tuned) | Adversarial resilience data |
| 23 | Run threshold calibration analysis on all collected cross-model data | Optimized thresholds with ROC curves |
| 24-25 | Update all ESP docs with empirical findings: revised thresholds, anchor set recommendations, scale benchmark results | Updated `embedding-stability-protocol.md`, `executive-report-esp.md` |
| 26 | Build `ordering-test.ts`, run on all data, compare predictive power vs mean drift | Best-metric recommendation |
| 27-28 | Write comprehensive results document: what was tested, what succeeded, what failed, what changed | `docs/esp-empirical-validation.md` |
| 29 | If results support it: draft ESP as a publishable spec (blog post / technical report) | Draft publication |
| 30 | Final review, commit everything, update PROJECTS.md | All artifacts committed |

---

## What Would Kill ESP Entirely

Being honest about failure modes:

1. **No correlation between ESV and retrieval quality** (Experiment 1 failure). If the 27×27 distance matrix comparison has no diagnostic power over real model differences, the entire geometric fingerprinting approach is wrong. Fix: try ordering-based metrics, try denser probing. If nothing works: ESP's core mechanism is flawed.

2. **K scales linearly with corpus size** (Experiment 2 failure). If you need K=75 at 100 docs and K=750 at 1000 docs, binary retrieval has no advantage over full text scanning. ESP becomes a protocol for protecting a worthless optimization. Fix: K-adaptive retrieval, better chunking, re-ranking. But the "70x speedup with zero quality loss" claim dies.

3. **Trivial adversarial evasion** (Experiment 4 failure). If a 5-minute fine-tune can produce a model that passes ESP but fails retrieval, ESP is security theater. Fix: randomized probing, denser anchor sets, or fundamentally different detection (e.g., compare on actual retrieval rankings, not anchor geometry). This doesn't kill the *need* for embedding compatibility detection, but it kills *this specific approach.*

4. **Anchors are irrelevant — random probes work equally well** (Experiment 3 finding). This doesn't kill ESP but kills the "curated anchor set" component. The protocol simplifies to "probe with N random texts" which is less elegant but possibly more robust.

None of these are likely to kill the *concept* of embedding stability detection — the problem is real. But they could kill *this implementation's approach*. The experiments are designed to find out fast.

---

*This roadmap is a research plan, not a validation exercise. The experiments are designed to break ESP, not confirm it. If ESP survives, it's earned its claims. If it doesn't, we'll know exactly what needs to change.*
