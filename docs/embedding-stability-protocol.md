# Embedding Stability Protocol (ESP)

**Version:** 0.1.0-draft  
**Author:** T3 Validator (Deep Research Pass)  
**Date:** 2026-04-09  
**Status:** Spec Draft — No Implementation Yet  

---

## Abstract

Embedding spaces drift. When the model that produces vector representations is updated, fine-tuned, quantized, or replaced, the geometric relationships between encoded concepts change. Content encoded under model version A occupies a different region of vector space under model version B — even when the source text is identical.

This document defines the **Embedding Stability Protocol (ESP)**: a framework for detecting, measuring, bounding, and mitigating embedding drift so that binary-encoded context can serve as a **stable transport layer** in Vectra's agentic execution pipeline. The analogy is precise: IP headers don't drift because they are defined by specification, not by inference. ESP defines the equivalent specification layer for embedding spaces.

---

## 1. The Drift Problem

### 1.1 Formal Definition

**Embedding drift** is the change in vector representation of identical semantic content when the encoding function changes.

Let:
- `E_A(t)` = the embedding vector produced by model A for text `t`
- `E_B(t)` = the embedding vector produced by model B for the same text `t`
- `d(u, v)` = cosine distance between vectors `u` and `v`: `1 - (u · v) / (||u|| · ||v||)`

**Drift** for a single text `t` between models A and B is:

```
drift(t, A, B) = d(E_A(t), E_B(t))
```

**Aggregate drift** across a corpus `C = {t_1, ..., t_n}` is:

```
Drift(C, A, B) = (1/n) Σ d(E_A(t_i), E_B(t_i))
```

Drift is problematic when it destroys **relative ordering**. The critical invariant for retrieval systems is not that absolute positions are preserved, but that nearest-neighbor relationships are stable:

```
If d(E_A(q), E_A(t_1)) < d(E_A(q), E_A(t_2))   [t_1 is closer to query q under A]
Then d(E_B(q), E_B(t_1)) < d(E_B(q), E_B(t_2))  [t_1 should still be closer under B]
```

When this ordering invariant breaks, retrieval quality degrades silently — the system returns results, they are just the *wrong* results.

### 1.2 Drift Taxonomy

Not all drift is equal. The causes differ in magnitude, predictability, and recoverability.

#### 1.2.1 Model Update Drift

**Cause:** The embedding model vendor releases a new version (e.g., `text-embedding-3-small` → `text-embedding-3-large`, or version bumps within the same model family).

**Character:** Potentially catastrophic. New model architectures can reorganize the entire embedding space. Dimensionality may change. There is no guarantee of any geometric relationship between the old and new spaces.

**Predictability:** Low. You cannot predict how a new model will rearrange its space until you measure it.

**Testable prediction:** Encoding the ESP anchor set (§7) with the old and new model will produce cosine distances > 0.1 for most anchors when a major version change occurs.

#### 1.2.2 Fine-Tune Drift

**Cause:** A base model is fine-tuned on domain-specific data, producing a specialized variant.

**Character:** Moderate and anisotropic. Fine-tuning warps the embedding space — regions related to the fine-tuning domain shift more than distant regions. The space doesn't rotate uniformly; it *stretches*.

**Predictability:** Medium. Drift concentrates in the semantic neighborhood of the fine-tuning data. You can predict *where* drift will be worst even if you can't predict exact magnitudes.

**Testable prediction:** Anchors semantically close to the fine-tuning domain will show 2-5x higher drift than anchors in unrelated domains.

#### 1.2.3 Quantization Drift

**Cause:** A model is quantized (FP32 → FP16 → INT8 → INT4) for inference efficiency.

**Character:** Small and approximately uniform. Quantization introduces rounding error across all dimensions. The geometric structure is approximately preserved — it's noise, not reorganization.

**Predictability:** High. Drift magnitude correlates directly with quantization aggressiveness. INT8 produces measurably less drift than INT4.

**Testable prediction:** Anchor drift under quantization will be < 0.02 cosine distance for INT8, < 0.05 for INT4, and ordering invariants will be preserved in > 99% of cases for INT8.

#### 1.2.4 Inference Parameter Drift

**Cause:** The same model with different inference parameters (batch size, sequence length, attention masking strategy, pooling method) produces different embeddings for the same input.

**Character:** Small but non-zero. Often ignored but measurable. Mean pooling vs. CLS token pooling can produce significant differences. Truncation behavior at different `max_seq_length` values affects embeddings of long texts.

**Predictability:** High. These parameters are under the operator's control and are deterministic for a given configuration.

**Testable prediction:** CLS pooling vs. mean pooling on the same model will produce cosine distances of 0.05-0.15 across the anchor set. Same pooling method with different max_seq_length values will produce < 0.01 drift for texts shorter than both limits.

### 1.3 Failure Modes in a Context Pipeline

When embedding drift occurs in Vectra's context pipeline, the failures manifest as:

| Failure Mode | Mechanism | Observability |
|---|---|---|
| **Silent retrieval degradation** | Stored context vectors no longer match query vectors for the same concept. Retrieval returns semantically adjacent but wrong results. | Low — results look plausible but are suboptimal. Only detectable via quality metrics or anchor tests. |
| **Context routing misfire** | Task routing depends on similarity to prototype embeddings. Drift shifts the decision boundaries. Tasks get routed to wrong protocols. | Medium — observable via T1 dispatch audits showing unexpected protocol binding. |
| **Memory coherence loss** | Agent memory encoded under old model is not retrievable under new model. Effectively amnesia. | High — agent stops referencing known prior context. Users notice immediately. |
| **Bundle validation false negatives** | Context bundles pass validation but contain stale/drifted embeddings that don't match their semantic labels. | Low — the bundle *looks* valid but carries degraded context. |
| **Cascading confidence collapse** | T3 validator trusts embedding similarity for semantic verification. Drifted embeddings produce low-confidence results, triggering unnecessary escalations. | Medium — spike in T3 escalation-to-human rate. |

### 1.4 Acceptable Drift

Drift tolerance is not a single number — it depends on the downstream task:

| Task | Tolerance Threshold (cosine distance) | Rationale |
|---|---|---|
| Memory retrieval (top-k) | < 0.05 | Must preserve nearest-neighbor ordering with margin |
| Task routing (classification) | < 0.10 | Decision boundaries have wider margin than retrieval |
| Deduplication | < 0.03 | Near-duplicate detection requires tight similarity |
| Semantic search (approximate) | < 0.08 | Users tolerate some ranking drift |

**Critical threshold:** If *any* anchor exceeds 0.15 cosine distance, the embedding spaces are **incompatible** for binary context exchange. Full re-encoding is required.

**The 90/10 rule:** If > 10% of anchors exceed the task-specific threshold, the embedding spaces are incompatible for that task class, even if mean drift is below threshold. Drift is not uniform — a few badly-drifted regions can destroy pipeline reliability.

---

## 2. Stability Anchors

### 2.1 The Core Insight

IP headers work because they are defined by a specification (RFC 791), not by a model. The specification creates a shared coordinate system that all implementations agree on. No implementation "interprets" the IP header differently — the spec *is* the definition.

Embedding spaces have no such specification. Two models encoding the phrase "user authentication request" will place it in completely unrelated regions of their respective vector spaces. There is no shared coordinate system.

**Stability anchors** are the embedding-space equivalent of protocol headers. They are a fixed set of semantic reference points that:

1. Define a coordinate system within an embedding space
2. Enable measurement of how two embedding spaces relate to each other
3. Provide a basis for computing alignment transformations between spaces
4. Serve as a compatibility test between model versions

The anchors themselves are not magic — they don't prevent drift. They **make drift measurable**, which is the prerequisite for everything else.

### 2.2 Properties of a Good Stability Anchor

A stability anchor must satisfy five properties:

1. **High semantic specificity.** The phrase should encode a precise, narrow concept. "Process management" is too broad. "Terminate a running process by its process ID" is specific.

2. **Low ambiguity.** The phrase should have a single dominant interpretation. "Bank" is ambiguous (financial vs. river). "Commercial banking institution" is not.

3. **Diverse coverage.** The anchor set must sample broadly across the embedding space. If all anchors cluster in one semantic region, they cannot detect drift in distant regions.

4. **Cross-model stability.** The *relative* geometry of anchors should be preserved across model families. The phrase "positive emotional sentiment" should always be *closer* to "happiness and joy" than to "database query optimization" — regardless of which model encodes them.

5. **Domain relevance.** For Vectra's use case, anchors should cover the semantic territory that the pipeline actually operates in. Generic anchors from unrelated domains (molecular biology, ancient history) waste measurement capacity.

### 2.3 The Anchor Test

The fundamental compatibility test between two embedding models:

```
ANCHOR_TEST(model_A, model_B, anchor_set, threshold):
  for each anchor a_i in anchor_set:
    v_A_i = model_A.encode(a_i)
    v_B_i = model_B.encode(a_i)
    drift_i = cosine_distance(v_A_i, v_B_i)
  
  mean_drift = mean(drift_i for all i)
  max_drift = max(drift_i for all i)
  breach_rate = count(drift_i > threshold) / len(anchor_set)
  
  COMPATIBLE if:
    mean_drift < threshold AND
    max_drift < 2 * threshold AND
    breach_rate < 0.10
  
  INCOMPATIBLE otherwise
```

**Ordering preservation test** (stronger, more expensive):

```
ORDERING_TEST(model_A, model_B, anchor_set):
  for each pair (a_i, a_j) in anchor_set:
    for each anchor a_k ≠ a_i, a_j:
      order_A = (d(E_A(a_i), E_A(a_k)) < d(E_A(a_j), E_A(a_k)))
      order_B = (d(E_B(a_i), E_B(a_k)) < d(E_B(a_j), E_B(a_k)))
      if order_A ≠ order_B: inversions += 1
  
  inversion_rate = inversions / total_comparisons
  COMPATIBLE if inversion_rate < 0.05
```

The ordering test is O(n³) on anchor count but n is small (25-30), making it ~20,000 comparisons — trivial.

### 2.4 Anchor Geometry as Fingerprint

Beyond pairwise drift, the anchor set's internal geometry provides a **space fingerprint**:

```
fingerprint(model, anchor_set):
  G = pairwise_cosine_distance_matrix(model.encode(a) for a in anchor_set)
  return G  # n×n symmetric matrix
```

Two models with similar fingerprints (`||G_A - G_B||_F < ε`, Frobenius norm) have compatible embedding geometries, even if the absolute vector positions are completely different. This is the key insight: **compatibility is about preserved geometry, not preserved position**.

This fingerprint can be hashed into a compact identifier — the **Embedding Space Version** (§4.5).

---

## 3. Drift Detection Protocol

### 3.1 Detection Responsibility

In Vectra's worker tier architecture:

- **T1 (Scanner)** owns scheduled and event-triggered drift detection
- **T2 (Watcher)** applies corrections and monitors for anomalous retrieval quality between scans
- **T3 (Validator)** performs deep analysis when drift is detected — determines root cause, evaluates mitigation options, and recommends action

### 3.2 Drift Check Triggers

| Trigger | Initiator | Priority |
|---|---|---|
| Model dependency update | T1 (detects model version change in config) | CRITICAL — immediate scan |
| Scheduled cadence | T1 cron (weekly) | ROUTINE |
| Anomalous retrieval quality | T2 (monitors hit rates, ranking stability) | HIGH — on-demand scan |
| Quantization parameter change | T1 (config watcher) | MEDIUM |
| New anchor set deployed | T1 (anchor set version change) | MEDIUM — re-baseline |
| Manual trigger | `vectra inspect drift --run` | Operator-determined |

### 3.3 Detection Procedure

When a drift check is triggered, T1 executes:

```
DRIFT_SCAN(current_model, reference_fingerprint, anchor_set):
  1. Encode all anchors with current_model → current_vectors
  2. Compute current_fingerprint = pairwise_distance_matrix(current_vectors)
  3. Compare to reference_fingerprint:
     a. Per-anchor drift (if reference vectors stored): cosine_distance per anchor
     b. Geometry drift: Frobenius distance between fingerprint matrices
     c. Ordering inversions: count relative-order violations
  4. Classify severity (§3.5)
  5. Emit DriftReport to telemetry + ops channel
  6. If CRITICAL: halt pipeline, escalate to T3 and human operator
```

### 3.4 Drift Report Schema

```typescript
interface DriftReport {
  // Metadata
  report_id: string;                    // UUID
  timestamp: string;                    // ISO 8601
  trigger: 'model-update' | 'scheduled' | 'anomaly' | 'manual';
  
  // Models compared
  reference_model: ModelFingerprint;    // Baseline
  current_model: ModelFingerprint;      // Current
  
  // Measurements
  anchor_count: number;
  per_anchor_drift: Array<{
    anchor_id: string;
    anchor_text: string;
    cosine_distance: number;
    exceeds_threshold: boolean;
  }>;
  
  // Aggregates
  mean_drift: number;
  max_drift: number;
  median_drift: number;
  p95_drift: number;
  breach_count: number;                 // Anchors exceeding threshold
  breach_rate: number;                  // breach_count / anchor_count
  geometry_distance: number;            // Frobenius norm of fingerprint delta
  ordering_inversion_rate: number;
  
  // Classification
  severity: 'NONE' | 'LOW' | 'WARNING' | 'CRITICAL';
  compatible: boolean;
  affected_task_classes: string[];      // Which Vectra task classes are impacted
  
  // Recommendation
  recommended_action: 'none' | 'monitor' | 're-encode' | 'align' | 'halt';
  rationale: string;
}

interface ModelFingerprint {
  model_id: string;                     // e.g., "text-embedding-3-small"
  model_version: string;                // e.g., "2024-01-25"
  quantization: string | null;          // e.g., "int8", "fp16"
  pooling: string;                      // e.g., "mean", "cls"
  max_seq_length: number;
  dimensions: number;
  esp_fingerprint_hash: string;         // SHA-256 of flattened fingerprint matrix
  embedding_space_version: string;      // §4.5
}
```

### 3.5 Severity Classification

| Severity | Condition | Action |
|---|---|---|
| **NONE** | mean_drift < 0.01 AND max_drift < 0.03 | No action. Models are functionally identical. |
| **LOW** | mean_drift < 0.03 AND breach_rate < 0.05 | Log only. Schedule monitoring at higher cadence. |
| **WARNING** | mean_drift < 0.08 AND breach_rate < 0.10 AND inversion_rate < 0.03 | Alert ops channel. Evaluate alignment transform. May continue operating with degraded quality. |
| **CRITICAL** | mean_drift ≥ 0.08 OR breach_rate ≥ 0.10 OR inversion_rate ≥ 0.03 OR any anchor > 0.15 | **Halt binary context exchange.** Fall back to text re-encoding. Escalate to T3 + human. |

---

## 4. Drift Mitigation Strategies

### 4.1 Re-Encode on Model Update

**Approach:** When the embedding model changes, re-embed all stored context with the new model.

**Cost:** O(n) where n = number of stored context items. For Vectra's current scale (hundreds to low thousands of context items per agent instance), this is feasible — a few seconds of API calls or local inference. At production scale (millions of contexts across multiple instances), this becomes expensive and introduces a migration window during which the pipeline is inconsistent.

**Advantages:**
- Simplest to reason about — after re-encoding, the system is in a known-good state
- No alignment approximation errors
- No dual-space overhead

**Disadvantages:**
- Requires storing original text alongside embeddings (can't discard source text)
- Migration window creates a consistency problem — in-flight queries during re-encoding may mix old and new embeddings
- Cost grows linearly with corpus size
- External contexts (received from other agents) cannot be re-encoded without the source text

**Verdict for Vectra:** Appropriate as a **fallback strategy** at all versions. Should always be available as the "nuclear option." Primary strategy for v0.x where corpus is small.

### 4.2 Anchor-Based Alignment (Procrustes Transform)

**Approach:** Given the anchor embeddings under both old and new models, compute an optimal rotation/reflection matrix that maps the old embedding space onto the new one. This is the **orthogonal Procrustes problem** — a well-studied linear algebra problem with a closed-form solution via SVD.

```
Given: X = [E_old(a_1), ..., E_old(a_n)]  (anchor embeddings under old model)
       Y = [E_new(a_1), ..., E_new(a_n)]  (anchor embeddings under new model)
       
Find: R = argmin_R ||RX - Y||_F  subject to R^T R = I

Solution: U Σ V^T = SVD(X Y^T), then R = V U^T
```

After computing R, all old embeddings can be transformed: `E_aligned(t) = R · E_old(t)`.

**Critical assumption:** This works if and only if the drift is **approximately linear** — meaning the embedding space has been rotated/reflected but not non-linearly warped. This is approximately true for model version bumps within the same family but **breaks down** for cross-family model changes and fine-tuning (which produces anisotropic warping).

**Advantages:**
- O(1) computation per query after the transform is computed (just a matrix multiply)
- No need to re-encode the entire corpus
- Transform computation is fast (SVD on a 25×d matrix)
- Works well for quantization drift and minor version updates

**Disadvantages:**
- Fails for non-linear drift (fine-tuning, cross-family changes)
- Approximation error accumulates — applying successive transforms (A→B→C) degrades quality
- Requires careful validation: the transform must be tested on held-out data beyond the anchor set to verify it generalizes

**Alignment quality test:**

```
ALIGNMENT_TEST(R, model_A, model_B, held_out_set):
  for each text t in held_out_set:
    aligned = R · E_A(t)
    actual = E_B(t)
    residual_i = cosine_distance(aligned, actual)
  
  ACCEPTABLE if mean(residual) < 0.05 AND max(residual) < 0.10
```

**Verdict for Vectra:** Appropriate for v1.x as an optimization over full re-encoding. Must be paired with validation that detects when the linear assumption breaks. Should never be applied more than once in sequence — if model changes again, compute fresh transform from the original reference, not transform-of-transform.

### 4.3 Dual-Space Indexing

**Approach:** Store both the source text and the binary embedding for every context item. Use binary embeddings for fast retrieval. When drift is detected, fall back to re-encoding queries in real time against the stored text.

```
Context Store:
  { text: "...", embedding: [...], model_version: "...", encoded_at: "..." }

Normal path: query → encode → nearest-neighbor search on embeddings (fast)
Drift path:  query → encode → search fails quality check → re-encode stored texts → search (slow but correct)
```

**Advantages:**
- Graceful degradation — never completely broken, just slower during drift
- No approximation error — re-encoding from text is exact
- Natural path to lazy re-encoding: items accessed during drift get re-encoded; items never accessed don't waste compute

**Disadvantages:**
- 2x storage (text + embedding)
- Drift-path latency is significantly higher (re-encoding is slow)
- Requires a "quality check" heuristic to decide when to switch paths, which itself can be unreliable
- Lazy re-encoding creates a mixed-state index that's hard to reason about

**Verdict for Vectra:** This is actually Vectra's natural architecture. Vectra's ContextEngine (§5.2) already stores text content and composes it at query time. Binary embeddings would be an *optimization layer* on top of text — not a replacement. This makes dual-space the default posture: text is always available, embeddings are a cache that can be invalidated.

### 4.4 Frozen Embedding Model

**Approach:** Decouple the embedding model from the generation model. Pin the embedding model to a specific version and never update it. Only the generation model changes.

```
Architecture:
  embedding_model = "text-embedding-3-small@2024-01-25"  (FROZEN)
  generation_model = "gpt-5-turbo@latest"                (UPDATED)
```

**Advantages:**
- Eliminates embedding drift entirely (by definition)
- Production-proven: this is how most RAG systems operate today
- Simple to implement and reason about

**Disadvantages:**
- Forfeits improvements in embedding quality when new models release
- Creates a hidden dependency: the frozen model must remain available (vendor-hosted models can be deprecated)
- If the frozen model is self-hosted, it's a permanent infrastructure commitment
- Doesn't help when you *want* to upgrade the embedding model for quality reasons

**The deprecation trap:** If you pin to `text-embedding-ada-002` and OpenAI deprecates it, you must re-encode everything anyway — but now under time pressure instead of at your convenience. Frozen embedding is stable until the freeze breaks, then it's a crisis.

**Verdict for Vectra:** Appropriate as the **default production strategy** for v1.x+. But ESP must be designed to handle the freeze *breaking* — meaning the full drift detection and re-encoding apparatus must exist even in a frozen-model deployment. The frozen model is the steady state; ESP is the safety net.

### 4.5 Semantic Versioning for Embedding Spaces

**Approach:** Define a version identifier for an embedding space based on its anchor fingerprint geometry. Two spaces with the same version are compatible for binary context exchange.

**Embedding Space Version (ESV):**

```
ESV = {
  anchor_set_version: "esp-v1",              // Which anchor set was used
  fingerprint_hash: "sha256:a3f8c1...",      // Hash of the n×n distance matrix
  compatibility_class: "text-embedding-3",   // Human-readable family
  dimensions: 1536,
  tolerance: 0.05                            // Threshold used for compatibility determination
}

Compact form: "esp-v1:a3f8c1:1536:0.05"
```

**Compatibility rule:** Two models have the same ESV if and only if:
1. They use the same anchor set version
2. Their fingerprint matrices have Frobenius distance < tolerance
3. Their dimensionality is identical

**Binary context headers:**

Every binary-encoded context bundle carries an ESV header:

```
BinaryContextBundle = {
  esv: "esp-v1:a3f8c1:1536:0.05",
  encoded_at: "2026-04-09T12:00:00Z",
  model_id: "text-embedding-3-small",
  payload: Float32Array[...]
}
```

A consumer receiving a binary context bundle checks: `bundle.esv == my_esv`. If compatible, use the binary payload directly. If not, request text fallback.

**This is the IP header analogy made concrete.** The ESV is a protocol-level compatibility marker. It doesn't prevent drift — it makes drift *negotiable*. Two agents can agree on a shared embedding space, and the ESV proves they're in the same space.

**Advantages:**
- Enables binary context exchange between agents without trust in model identity
- Compact, hashable, storable
- Composable with all other mitigation strategies
- Creates a foundation for standardization (§6)

**Disadvantages:**
- Requires anchor set stability (changing the anchor set changes all ESVs)
- Fingerprint hash is sensitive to floating-point precision — need to define rounding rules
- Adds metadata overhead to every context bundle

**Verdict for Vectra:** This is the **strategic differentiator**. Implement in v0.x as a metadata field. Make it load-bearing in v1.x. Propose as a standard in v2.x.

---

## 5. The Vectra Implementation Path

### 5.1 Version Milestones

| Version | Strategy | Embedding Layer | ESP Features |
|---|---|---|---|
| **v0.x** (current) | Frozen model + text fallback | No binary embeddings yet. Text-only context via ContextEngine. ESV metadata field defined but not enforced. | Anchor set defined. `vectra inspect drift` CLI. Manual drift checks. |
| **v1.x** | Frozen model + Procrustes alignment + ESV enforcement | Binary embedding cache added to ContextEngine. Dual-space: text always available, binary is acceleration. | T1 scheduled drift scans. DriftReport schema. ESV compatibility checks on bundle exchange. Alignment transform when model updates within same family. |
| **v2.x** | Full ESP with semantic versioning | Binary context as first-class transport. Agents negotiate ESV during handshake. Text fallback for incompatible spaces. | ESP proposed as open standard. Cross-agent ESV negotiation protocol. Anchor set governance. Drift-aware routing (prefer agents with compatible ESV). |

### 5.2 Embedding Layer in Vectra's Pipeline

Currently, Vectra's pipeline is text-native. Context flows through five layers (static, task, working, persistent, retrieval) as string content, composed by `ContextEngine` and validated by `BundleValidator`. There is no binary embedding anywhere in the pipeline.

The embedding layer inserts between the Context Engine and the Bundle Validator:

```
Context Engine (compose text layers)
  ↓
Embedding Layer (NEW)
  ├── Encode text → binary embedding (for retrieval acceleration)
  ├── Attach ESV header to bundle
  ├── Check ESV compatibility for received bundles
  └── If incompatible: request text fallback or apply alignment
  ↓
Bundle Validator (validate enriched bundle)
  ↓
Model (inference)
```

For the **retrieval layer** specifically, the embedding layer enables vector similarity search instead of text-based retrieval:

```
Retrieval Query:
  1. Encode query text → query vector
  2. Search binary index for nearest neighbors
  3. Return text content of matched items
  4. Compose into retrieval layer

Retrieval Index Update:
  1. New context arrives → encode to binary
  2. Store {text, vector, esv, timestamp}
  3. On drift detection: invalidate binary index, fall back to text search
```

### 5.3 `vectra inspect` Drift Tooling

The `vectra inspect` CLI should expose:

```bash
# Run anchor test against current model
vectra inspect drift --run

# Show last drift report
vectra inspect drift --report

# Compare two models
vectra inspect drift --compare <model_a> <model_b>

# Show current ESV
vectra inspect esv

# Show ESV for a specific bundle
vectra inspect esv --bundle <bundle_id>

# Validate ESV compatibility between two bundles
vectra inspect esv --check <esv_a> <esv_b>

# Show anchor set details
vectra inspect anchors --list
vectra inspect anchors --geometry  # Visualize pairwise distances

# Force re-encoding
vectra inspect drift --re-encode --confirm

# Show alignment transform quality
vectra inspect drift --alignment-residual
```

### 5.4 Integration with Receipt Gate and Worker Tiers

**Receipt Gate extension:**

The receipt gate (§ `receipt.ts`) validates handoff artifacts. With ESP, receipts gain an `esv` field:

```typescript
interface HandoffArtifact {
  // ... existing fields ...
  esv: string;                    // Embedding space version of any binary context in this artifact
  drift_check_passed: boolean;    // Was an anchor test run and passed at handoff time?
}
```

If `drift_check_passed` is false or missing, the receipt gate can flag the receipt as `WARNING` severity — the artifact may contain drifted binary context.

**T1 Scanner extension:**

T1's existing scan cycle (protocol schema, var staleness, dispatch table) gains a drift check:

```typescript
interface T1Finding {
  type: 'schema-violation' | 'staleness' | 'orphaned-pattern' | 'missing-field'
    | 'embedding-drift';        // NEW
  // ...
}
```

T1 runs the anchor test on its scheduled cadence and when model config changes are detected via the config watcher.

**T2 Watcher extension:**

T2 monitors retrieval quality metrics in real time. New signals:
- Retrieval hit rate drop (% of queries where top-k results have similarity < quality threshold)
- Ranking instability (same query produces different top-k ordering across consecutive calls)

When these signals cross thresholds, T2 triggers an out-of-band T1 drift scan.

**T3 Validator extension:**

When T1 reports `CRITICAL` drift, T3 performs deep analysis:
- Root cause determination (which drift type? §1.2)
- Alignment feasibility assessment (is Procrustes viable? Test on held-out data)
- Re-encoding cost estimation (corpus size × encoding cost)
- Recommendation with confidence score

---

## 6. The Standardization Path

### 6.1 What an Open Standard Requires

An "IP header for embedding spaces" would need:

1. **Anchor Set Specification.** A canonical, versioned set of reference texts with defined semantics. This is the "port numbers" equivalent — a shared reference that all implementations agree on.

2. **Fingerprinting Algorithm.** A deterministic procedure for computing an embedding space's geometric fingerprint from anchor embeddings. Must specify rounding, normalization, and hash computation precisely enough that independent implementations produce identical fingerprints.

3. **Compatibility Decision Procedure.** A well-defined algorithm that takes two ESVs and a tolerance parameter and returns a compatibility verdict. No ambiguity.

4. **Binary Context Header Format.** A compact, serializable header format that travels with binary-encoded context. Must be self-describing (can be parsed without knowing the encoding model) and versioned.

5. **Negotiation Protocol.** A handshake procedure for two agents to discover whether they share a compatible embedding space before exchanging binary context.

### 6.2 Minimum Viable Standard

```
ESP Standard v1.0 (minimum):
  
  1. Anchor Set v1: 25 reference texts (published, immutable for v1)
  2. Fingerprint: pairwise cosine distance matrix, float32, row-major, 
     rounded to 6 decimal places, SHA-256 hashed
  3. Compatibility: fingerprints with Frobenius distance < 0.05 are compatible
  4. Header: { "esp": "1", "esv": "<hash>", "dim": <int>, "model": "<string>" }
  5. Negotiation: send ESV header, receive ACK (compatible) or NACK (incompatible)
```

### 6.3 Existing Work

| Work | Relevance | Gap |
|---|---|---|
| **MTEB (Massive Text Embedding Benchmark)** | Benchmarks embedding model quality across tasks. Establishes that different models have different quality profiles. | Does not measure inter-model compatibility or drift. Compares models against ground truth, not against each other. |
| **Model Cards (Mitchell et al., 2019)** | Standardized documentation for ML models including intended use, performance metrics, limitations. | Descriptive, not operational. Doesn't define compatibility tests or space fingerprints. |
| **Sentence-BERT / Sentence Transformers** | Standardized framework for producing sentence embeddings. De facto standard for how embeddings are produced. | Standardizes the encoding process, not the space. Two Sentence-BERT models can have completely incompatible spaces. |
| **Matryoshka Representation Learning** | Embeddings that maintain quality at variable dimensionality by training to be effective at multiple truncation points. | Addresses dimensionality flexibility, not cross-model compatibility. Relevant to the "dimensions" component of ESV but doesn't solve drift. |
| **ONNX Runtime / OpenVINO** | Standardized model serving formats that enable deterministic inference. | Addresses inference reproducibility (same model → same output) but not cross-model compatibility. |
| **Embedding API standards (OpenAI, Cohere)** | De facto API standards for requesting embeddings. | Standardize the *interface*, not the *space*. Two providers implementing the same API produce incompatible embeddings. |

**Gap analysis:** No existing work defines a **compatibility test between embedding spaces**. MTEB measures quality; model cards describe characteristics; Sentence Transformers standardizes production. Nobody standardizes compatibility. This is the gap ESP fills.

### 6.4 Vectra's Contribution

Vectra's path to contributing an open standard:

1. **v0.x:** Publish this spec. Implement ESP internally. Collect data on drift across model families.
2. **v1.x:** Publish anchor set v1 with empirical drift measurements across 10+ model families. Publish fingerprinting algorithm with reference implementation. Open-source the `vectra inspect drift` tooling as a standalone library.
3. **v2.x:** Propose ESP as an informal specification (like JSON started — no standards body, just a spec page and a reference implementation). Seek adoption by other agentic frameworks.
4. **v3.x+:** If adoption occurs, formalize through an appropriate body. The anchor set governance becomes the critical challenge — who decides when to version the anchors?

---

## 7. Proposed Anchor Set

The following 27 anchors are designed for Vectra's domain: agent context management, task routing, memory retrieval, identity, tool use, and escalation. Each anchor has a unique semantic identity, low ambiguity, and covers a distinct region of the embedding space relevant to agentic operations.

### 7.1 Task Routing Domain (7 anchors)

| ID | Anchor Text | Semantic Target |
|---|---|---|
| `TR-01` | "Route this task to the appropriate handler based on its priority and type" | Task dispatch / orchestration |
| `TR-02` | "This task requires human approval before execution can proceed" | Approval gating |
| `TR-03` | "Schedule this operation to run at a specific future time" | Temporal scheduling |
| `TR-04` | "Escalate this issue to a higher authority because automated resolution failed" | Escalation pathway |
| `TR-05` | "Execute this shell command on the local operating system" | System command execution |
| `TR-06` | "Send a message to another agent in the multi-agent network" | Inter-agent communication |
| `TR-07` | "Retrieve relevant information from long-term persistent storage" | Memory retrieval query |

### 7.2 Memory and Context Domain (7 anchors)

| ID | Anchor Text | Semantic Target |
|---|---|---|
| `MC-01` | "Store this information for future retrieval across sessions" | Persistent memory write |
| `MC-02` | "What happened in the previous conversation about this topic" | Conversational history recall |
| `MC-03` | "The user's stated preference is to receive brief summaries" | User preference encoding |
| `MC-04` | "This fact was last verified on a specific calendar date" | Temporal fact staleness |
| `MC-05` | "Combine information from multiple sources into a single context" | Context composition / fusion |
| `MC-06` | "Remove outdated information that is no longer accurate" | Memory garbage collection |
| `MC-07` | "This context belongs to a specific named project or workspace" | Namespace / project scoping |

### 7.3 Identity and Role Domain (5 anchors)

| ID | Anchor Text | Semantic Target |
|---|---|---|
| `IR-01` | "I am an autonomous agent operating under defined behavioral constraints" | Agent self-identity |
| `IR-02` | "The operator has administrative privileges over this system" | Authority / permission level |
| `IR-03` | "This action is prohibited by the safety policy" | Safety constraint / guardrail |
| `IR-04` | "Switch to a different operational persona or behavioral mode" | Persona / mode switching |
| `IR-05` | "Verify the identity and authorization of the requesting entity" | Authentication / authorization |

### 7.4 Tool Use Domain (4 anchors)

| ID | Anchor Text | Semantic Target |
|---|---|---|
| `TU-01` | "Read the contents of a file from the local filesystem" | File I/O operation |
| `TU-02` | "Search the internet for current information about this topic" | Web search / retrieval |
| `TU-03` | "Generate an image based on this textual description" | Media generation |
| `TU-04` | "Parse and extract structured data from this unstructured text" | Data extraction / parsing |

### 7.5 System State Domain (4 anchors)

| ID | Anchor Text | Semantic Target |
|---|---|---|
| `SS-01` | "The system is operating normally with no errors detected" | Healthy state / nominal |
| `SS-02` | "A critical error has occurred and immediate intervention is required" | Error / failure state |
| `SS-03` | "System resource utilization is approaching maximum capacity" | Resource pressure / limits |
| `SS-04` | "The configuration has been modified and requires validation" | Config change detection |

### 7.6 Anchor Set Properties

**Coverage verification:** The 27 anchors span 5 distinct semantic domains. To verify coverage, encode all anchors with any model and compute the pairwise distance matrix. The matrix should show:
- Intra-domain distances: 0.15 - 0.40 (related but distinct)
- Inter-domain distances: 0.40 - 0.80 (clearly separated)
- No pair with distance < 0.10 (no redundant anchors)
- No pair with distance > 0.90 (no anchors in completely unrelated spaces)

If these properties don't hold, the anchor set needs revision.

**Immutability:** Once published as `esp-anchor-v1`, this set is frozen. Any change produces `esp-anchor-v2` with a new fingerprint space. This is why the anchor set must be right before publication — like IP protocol numbers, changing them has cascading effects.

---

## 8. Open Questions and Unsolved Problems

### 8.1 Solved (by this spec)

- ✅ Formal definition of embedding drift and its taxonomy
- ✅ Measurable compatibility test between embedding spaces
- ✅ Severity classification with concrete thresholds
- ✅ Integration path into Vectra's existing architecture
- ✅ Versioning scheme for embedding spaces

### 8.2 Solvable (requires implementation and measurement)

- ⬜ Empirical validation of proposed thresholds (0.05, 0.10, 0.15) across model families
- ⬜ Anchor set coverage verification — do the 27 anchors actually span the relevant space?
- ⬜ Procrustes alignment residual measurement — how well does linear alignment work in practice?
- ⬜ Fingerprint hash stability under floating-point rounding across platforms (ARM vs x86, different BLAS implementations)
- ⬜ Lazy re-encoding convergence — does the dual-space index eventually fully re-encode under normal access patterns, or do cold items remain stale indefinitely?

### 8.3 Unsolved (fundamental challenges)

- ❓ **Non-linear drift correction.** Procrustes handles rotation. Fine-tuning produces non-linear warping. No efficient closed-form solution exists for non-linear alignment. Neural alignment models exist but introduce their own drift problem.
- ❓ **Cross-dimensional compatibility.** Models with different embedding dimensions (384 vs 768 vs 1536) cannot be directly compared. Matryoshka representations offer a partial solution but require training support. Projection-based alignment (768→384 via PCA) loses information.
- ❓ **Anchor set governance.** Who decides when to update the anchor set? In a decentralized agent ecosystem, there's no IANA equivalent. This is a social/governance problem, not a technical one.
- ❓ **Adversarial drift.** A malicious agent could claim ESV compatibility while actually using a different embedding space. Binary context exchange requires either trust or verification — and verification requires the text, which defeats the purpose of binary transport.
- ❓ **Temporal semantic drift.** Even with a frozen model, the *meaning* of text changes over time (e.g., "pandemic" had different connotations in 2019 vs 2021). The model's space doesn't change, but the real-world referents of the encoded concepts do. ESP doesn't address this — it's a different problem (semantic drift vs embedding drift).

---

## 9. Summary

The Embedding Stability Protocol defines three things:

1. **A measurement framework** — anchor sets, fingerprints, compatibility tests — that makes embedding drift observable and quantifiable rather than a silent failure mode.

2. **An operational protocol** — integrated into Vectra's T1/T2/T3 worker tiers — that detects drift when it occurs, classifies its severity, and triggers appropriate mitigation.

3. **A versioning scheme** — Embedding Space Versions (ESV) — that enables binary context to carry its own compatibility metadata, the way IP packets carry protocol version headers.

The key insight is not that we can prevent drift — we cannot, as long as models evolve. The insight is that we can **make drift negotiable**: measurable, bounded, and recoverable. That's sufficient for binary context to become a reliable transport layer.

TCP doesn't guarantee that packets arrive. It guarantees that you *know* when they don't, and that you can recover. ESP provides the same guarantee for embedding spaces.

---

## Appendix A: Reference Implementation Pseudocode

### A.1 Anchor Test

```python
def anchor_test(model_a, model_b, anchors, threshold=0.05):
    vecs_a = [model_a.encode(a.text) for a in anchors]
    vecs_b = [model_b.encode(a.text) for a in anchors]
    
    drifts = [cosine_distance(va, vb) for va, vb in zip(vecs_a, vecs_b)]
    
    return {
        "mean_drift": mean(drifts),
        "max_drift": max(drifts),
        "p95_drift": percentile(drifts, 95),
        "breach_count": sum(1 for d in drifts if d > threshold),
        "breach_rate": sum(1 for d in drifts if d > threshold) / len(drifts),
        "compatible": (
            mean(drifts) < threshold and
            max(drifts) < 2 * threshold and
            sum(1 for d in drifts if d > threshold) / len(drifts) < 0.10
        ),
        "per_anchor": [
            {"id": a.id, "drift": d, "exceeds": d > threshold}
            for a, d in zip(anchors, drifts)
        ]
    }
```

### A.2 Space Fingerprint

```python
def compute_fingerprint(model, anchors):
    vecs = [model.encode(a.text) for a in anchors]
    n = len(vecs)
    matrix = np.zeros((n, n))
    for i in range(n):
        for j in range(i+1, n):
            d = cosine_distance(vecs[i], vecs[j])
            matrix[i][j] = round(d, 6)
            matrix[j][i] = round(d, 6)
    
    flat = matrix.flatten().tobytes()
    hash = sha256(flat).hexdigest()[:12]
    
    return {
        "matrix": matrix,
        "hash": hash,
        "esv": f"esp-v1:{hash}:{model.dimensions}:{0.05}"
    }
```

### A.3 Procrustes Alignment

```python
def compute_alignment(vecs_old, vecs_new):
    """Orthogonal Procrustes: find R such that R @ X ≈ Y"""
    X = np.array(vecs_old).T  # d × n
    Y = np.array(vecs_new).T  # d × n
    
    M = X @ Y.T
    U, _, Vt = np.linalg.svd(M)
    R = Vt.T @ U.T
    
    # Measure residual
    aligned = R @ X
    residuals = [cosine_distance(aligned[:, i], Y[:, i]) for i in range(X.shape[1])]
    
    return {
        "transform": R,
        "mean_residual": mean(residuals),
        "max_residual": max(residuals),
        "viable": mean(residuals) < 0.05
    }
```
