/**
 * Retrieval Quality Benchmark: Full-Text vs Binary-Retrieved Context
 *
 * Measures answer quality degradation when a model reasons over
 * binary-retrieved context (top-K chunks via cosine similarity)
 * vs the full verbatim document.
 *
 * Hardware: DGX GB10 — nemotron-embed (port 8004), nemotron3-super (port 8001)
 * Runner: Jetson1
 */

const DGX_HOST = "100.78.161.126";
const EMBED_URL = `http://${DGX_HOST}:8004/v1/embeddings`;
const GEN_URL = `http://${DGX_HOST}:8001/v1/chat/completions`;
const EMBED_MODEL = "nemotron-embed";
const GEN_MODEL = "nemotron3-super";
const EMBED_DIM = 2048;
const CHUNK_TOKEN_LIMIT = 512;
const CHUNK_CHAR_SIZE = CHUNK_TOKEN_LIMIT * 3; // ~3 chars per token (conservative to stay under 512 token limit)

const RUNS_PER_TEST = 3;
const K_VALUES = [1, 3, 5];

// ─── Types ───

interface QualityResult {
  questionType: string;
  k: number;
  fullTextScore: number;
  fullTextAnswer: string;
  binaryScore: number;
  retrievedChunkIndices: number[];
  retrievedChunks: string[];
  binaryAnswer: string;
  correctChunkRetrieved: boolean;
  scoreGap: number;
  qualityRetentionPercent: number;
}

interface TestCase {
  name: string;
  questionType: string;
  document: string;
  question: string;
  correctAnswer: string;
  answerChunkIndex: number; // which chunk (0-indexed) contains the answer
  scoringGuide: string;     // instructions for the scoring LLM
}

interface AggregatedResult {
  questionType: string;
  k: number;
  avgFullTextScore: number;
  avgBinaryScore: number;
  avgScoreGap: number;
  avgQualityRetention: number;
  correctChunkRetrievedCount: number;
  totalRuns: number;
  runs: QualityResult[];
}

// ─── HTTP Helpers ───

async function httpPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${errText.slice(0, 500)}`);
  }
  return res.json();
}

async function embed(texts: string[]): Promise<number[][]> {
  const data = await httpPost(EMBED_URL, {
    model: EMBED_MODEL,
    input: texts,
  }) as { data: Array<{ embedding: number[] }> };
  return data.data.map(d => d.embedding);
}

async function generate(systemPrompt: string, userPrompt: string, maxTokens = 300): Promise<string> {
  const data = await httpPost(GEN_URL, {
    model: GEN_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0,
  }) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content.trim();
}

// ─── Vector Ops ───

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkDocument(text: string): string[] {
  const chunks: string[] = [];
  // Split on double newlines first to respect paragraph boundaries
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > CHUNK_CHAR_SIZE && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  // Hard split any chunks still over limit
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > CHUNK_CHAR_SIZE) {
      for (let i = 0; i < chunk.length; i += CHUNK_CHAR_SIZE) {
        result.push(chunk.slice(i, i + CHUNK_CHAR_SIZE).trim());
      }
    } else {
      result.push(chunk);
    }
  }
  return result;
}

async function retrieveTopK(
  chunks: string[],
  query: string,
  k: number
): Promise<{ indices: number[]; texts: string[]; similarities: number[] }> {
  // Embed all chunks + query together
  const allTexts = [...chunks, query];
  const allEmbeddings = await embed(allTexts);
  const queryEmbedding = allEmbeddings[allEmbeddings.length - 1];
  const chunkEmbeddings = allEmbeddings.slice(0, -1);

  // Score each chunk
  const scored = chunkEmbeddings.map((emb, idx) => ({
    idx,
    sim: cosineSimilarity(emb, queryEmbedding),
    text: chunks[idx],
  }));

  // Sort by similarity descending
  scored.sort((a, b) => b.sim - a.sim);

  const topK = scored.slice(0, k);
  return {
    indices: topK.map(s => s.idx),
    texts: topK.map(s => s.text),
    similarities: topK.map(s => s.sim),
  };
}

// ─── Scoring ───

async function scoreAnswer(
  question: string,
  correctAnswer: string,
  modelAnswer: string,
  scoringGuide: string,
): Promise<number> {
  const prompt = `You are scoring an answer. Compare MODEL ANSWER to CORRECT ANSWER.

Scoring:
- 3 = Correct and precise (exact facts match)
- 2 = Correct but imprecise (right idea, wrong details)
- 1 = Partially correct (some right, some wrong/missing)
- 0 = Incorrect or missing

Scoring guide: ${scoringGuide}

Question: ${question}

Correct answer: ${correctAnswer}

Model answer: ${modelAnswer}

First briefly explain your reasoning, then on the LAST line write ONLY: SCORE=X (where X is 0, 1, 2, or 3)`;

  const result = await generate("You are a strict answer quality evaluator.", prompt, 200);
  // Look for SCORE=X pattern first
  const scoreMatch = result.match(/SCORE\s*=\s*([0-3])/i);
  if (scoreMatch) {
    return parseInt(scoreMatch[1], 10);
  }
  // Fallback: look for any digit 0-3 near the end
  const lastLine = result.trim().split('\n').pop() || '';
  const digitMatch = lastLine.match(/[0-3]/);
  if (digitMatch) {
    return parseInt(digitMatch[0], 10);
  }
  // Last resort: any digit in entire response
  const anyDigit = result.match(/[0-3]/);
  if (anyDigit) {
    return parseInt(anyDigit[0], 10);
  }
  console.warn(`  ⚠ Scoring returned unexpected: "${result.slice(0, 60)}", defaulting to 0`);
  return 0;
}

// ─── Test Case Construction ───

function buildTestCases(): TestCase[] {
  return [
    // ─── Type 1: Fact Recall ───
    {
      name: "Type 1: Fact Recall",
      questionType: "fact_recall",
      document: `INCIDENT REPORT — 2026-04-09 14:00 UTC
System: Vectra Pipeline Node cluster-jetson-04
Severity: P1 — Service Degradation
Duration: 47 minutes (14:00–14:47 UTC)
Reported by: Automated monitoring (Prometheus alert rule vec_pipeline_error_rate > 0.05)

TIMELINE:

14:00 UTC — Alert triggered. The Vectra ingest pipeline on cluster-jetson-04 began rejecting approximately 23% of incoming context frames. Error rates spiked from baseline 0.001 to 0.087 within 90 seconds.

14:02 UTC — On-call engineer acknowledged the alert. Initial triage showed the embedding service (nemotron-embed) was returning HTTP 503 responses intermittently. The load balancer health check was passing because only 2 of 4 replicas were unhealthy.

14:05 UTC — Investigation revealed that replicas embed-worker-02 and embed-worker-03 had exhausted their GPU memory. Each was allocated 8GB VRAM but memory usage had climbed to 7.98GB due to a memory leak in the tokenizer's subword cache introduced in version 2.4.1 of the embedding service.

14:08 UTC — The authentication service returned error code ERR-AUTH-7742 when the pipeline attempted to refresh its service-to-service JWT token. This was a cascading failure: the auth service's connection pool had been depleted by retry storms from the embedding workers.

14:12 UTC — Operator attempted manual restart of embed-worker-02 via kubectl. The restart succeeded but the pod entered CrashLoopBackOff after 3 cycles because the persistent volume claim for the model cache was locked by the orphaned process.

14:15 UTC — Database connection pool on the metadata store reached maximum (250 connections). New embedding requests began queuing. Average response time increased from 45ms to 3,200ms.

14:18 UTC — The rate limiter service for external API calls logged an unrelated warning about approaching the daily quota for the geocoding API (87% consumed). This was coincidental and not connected to the incident.

14:22 UTC — A separate monitoring alert fired for node cluster-jetson-07 showing elevated CPU temperature (89°C). Investigation showed this was caused by the backup compression job running on schedule and was unrelated to the pipeline failure.

14:25 UTC — Engineer deployed hotfix: increased GPU memory allocation to 12GB per replica and patched the tokenizer cache leak (version 2.4.2). Rolling restart initiated.

14:30 UTC — embed-worker-02 came back healthy. embed-worker-03 required manual PVC release before restart.

14:35 UTC — All 4 replicas healthy. Error rate dropped below 0.01.

14:40 UTC — Auth service connection pool recovered. JWT refresh succeeded.

14:47 UTC — All metrics returned to baseline. Incident resolved.

POST-MORTEM NOTES:
The proximate cause was the tokenizer memory leak in v2.4.1. The auth service failure (ERR-AUTH-7742) was a secondary cascade effect. The rate limiter warning (geocoding API) and cluster-jetson-07 CPU alert were unrelated noise.`,
      question: "What was the error code returned by the authentication service during the incident?",
      correctAnswer: "ERR-AUTH-7742",
      answerChunkIndex: 1, // Will be recalculated based on actual chunking
      scoringGuide: "Score 3 if the answer states exactly ERR-AUTH-7742. Score 2 if it mentions an auth error code but gets the number slightly wrong. Score 1 if it mentions auth failure without the specific code. Score 0 if wrong code or no answer.",
    },

    // ─── Type 2: Numerical Precision ───
    {
      name: "Type 2: Numerical Precision",
      questionType: "numerical_precision",
      document: `PERFORMANCE ANALYSIS REPORT — 2026-04-09 08:00–12:00 UTC
System: Vectra Inference Cluster (4x DGX GB10, 8 GPU each)
Workload: Production embedding + generation pipeline

EXECUTIVE SUMMARY:
During the 4-hour observation window, the cluster processed 1,247,338 embedding requests and 89,412 generation requests. This report captures peak resource utilization metrics for capacity planning.

COMPUTE METRICS:

GPU Utilization:
- Average across all 32 GPUs: 71.2%
- Peak utilization (any single GPU): 98.7% — observed on dgx-03-gpu-06 at 10:47 UTC during a burst of 128K-token context embeddings
- Lowest utilization: 34.1% on dgx-01-gpu-00 (dedicated to the low-priority background reindexing job)
- Standard deviation: 18.4%

Memory Utilization:
- Average VRAM usage: 62.8% (50.24 GB of 80 GB per GPU)
- Peak VRAM at steady state: 79.1% — observed during the 10:30–11:00 UTC window when batch size auto-scaled to 64
- Peak VRAM at load spike: 87.3% — observed at 10:47 UTC coinciding with the GPU utilization peak on dgx-03
- Note: The 87.3% figure represents the highest instantaneous reading. The 95th percentile sustained VRAM usage was 76.4%
- Memory headroom at peak: 10.16 GB (12.7% of 80 GB)

CPU Utilization (Host):
- Average: 43.7%
- Peak: 67.2% during model loading at 08:00 UTC startup
- Tokenization CPU overhead: 8.3% average (dominated by subword merges on long inputs)

Network:
- Intra-cluster NVLink bandwidth: averaging 412 GB/s (87.2% of theoretical 472 GB/s)
- External ingress: 2.34 Gbps average, peaking at 8.71 Gbps during bulk ingest at 09:15 UTC
- External egress: 1.12 Gbps average

STORAGE I/O:
- NVMe read throughput: 3.2 GB/s average, 6.7 GB/s peak
- Model cache hit rate: 99.2%
- Checkpoint write: 890 MB every 15 minutes

THERMAL:
- Average GPU temperature: 72.4°C
- Peak GPU temperature: 83.1°C on dgx-03-gpu-06 (correlates with utilization peak)
- Coolant flow rate: 14.7 L/min (within spec of 12–18 L/min)

POWER:
- Average cluster draw: 12.4 kW
- Peak draw: 16.8 kW at 10:47 UTC
- Power efficiency: 847 embeddings/kWh at peak, 1,203 embeddings/kWh at average load

COST METRICS:
- Total compute cost for window: $47.82
- Cost per 1M embeddings: $38.31
- Cost per 1K generations: $0.53
- At current utilization, monthly projected cost: $11,477

CAPACITY PLANNING NOTES:
At 87.3% peak VRAM, we are within the safety margin but approaching the recommended 85% threshold. Recommend provisioning one additional DGX node if embedding batch size increases beyond 64 or if context window expansion (currently 512 tokens for embed, 4096 for generation) is deployed.`,
      question: "What was the memory utilization percentage at peak load?",
      correctAnswer: "87.3% — this was the peak VRAM at load spike, observed at 10:47 UTC on dgx-03",
      answerChunkIndex: 1,
      scoringGuide: "Score 3 if answer states exactly 87.3%. Score 2 if it says ~87% or 87% without the decimal. Score 1 if it mentions a different memory metric (like 79.1% steady state or 76.4% p95). Score 0 if wrong number entirely or no answer. Note: 79.1% is peak at steady state, 76.4% is 95th percentile sustained, 62.8% is average — these are distractors.",
    },

    // ─── Type 3: Sequential Reasoning ───
    {
      name: "Type 3: Sequential Reasoning",
      questionType: "sequential_reasoning",
      document: `INCIDENT TIMELINE — Vectra Context Pipeline Cascade Failure
Date: 2026-04-08
Duration: 2 hours 14 minutes
Severity: P0 — Full Service Outage

This document records the precise sequence of events during the cascade failure. The order of events is critical for understanding the causal chain.

EVENT SEQUENCE:

[T+0:00] 22:00 UTC — The scheduled daily model checkpoint sync began on dgx-02. This is a routine operation that typically completes in 8 minutes and has never caused issues in 14 months of operation.

[T+0:03] 22:03 UTC — The checkpoint sync process encountered a corrupted block in the NVMe array on dgx-02. The filesystem driver initiated an automatic block reallocation, which temporarily increased I/O latency on dgx-02 from 0.4ms to 340ms.

[T+0:04] 22:04 UTC — The embedding service on dgx-02 began timing out. Requests exceeding the 500ms SLA were automatically rerouted to dgx-01 and dgx-03 by the load balancer.

[T+0:06] 22:06 UTC — dgx-01 and dgx-03 received approximately 150% of their normal request volume due to the rerouting. Both nodes began to thermal throttle as GPU temperatures exceeded 88°C.

[T+0:08] 22:08 UTC — THE FIRST FAILURE: dgx-01's embedding service crashed with an OOM (Out of Memory) error. The additional load had pushed VRAM usage past the 80GB limit. The process was killed by the Linux OOM killer. This was the initiating failure in the cascade.

[T+0:09] 22:09 UTC — With dgx-01 down and dgx-02 degraded, all traffic shifted to dgx-03. dgx-03 was now serving 4x its rated capacity.

[T+0:11] 22:11 UTC — dgx-03 began dropping requests. Error rate exceeded 50%. The circuit breaker on the API gateway triggered, returning HTTP 503 to all clients.

[T+0:12] 22:12 UTC — THE RECOVERY ACTION AFTER THE FIRST FAILURE: The on-call engineer (callsign: watchdog-7) executed an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB, reserving 4GB for system). The restart command was: systemctl restart vectra-embed@dgx01 --override-mem=76G.

[T+0:15] 22:15 UTC — dgx-01 came back online but entered a cold-start phase, loading model weights from the NVMe cache. During cold start, dgx-01 could not serve requests for approximately 3 minutes.

[T+0:18] 22:18 UTC — dgx-01 began accepting requests. Traffic was gradually rebalanced across dgx-01 and dgx-03 (dgx-02 still degraded from the NVMe issue).

[T+0:22] 22:22 UTC — dgx-02's NVMe block reallocation completed. I/O latency returned to 0.5ms. However, the model checkpoint was now stale, requiring a fresh sync.

[T+0:25] 22:25 UTC — Engineer initiated a controlled checkpoint sync on dgx-02 with I/O throttling (--bw-limit=500MB/s) to prevent recurrence.

[T+0:40] 22:40 UTC — dgx-02 checkpoint sync completed successfully. All three nodes now operational.

[T+0:45] 22:45 UTC — Traffic fully rebalanced. Error rate dropped to 0.002%.

[T+2:14] 00:14 UTC — All SLA metrics verified normal for 90 minutes. Incident officially closed.

CRITICAL CAUSAL CHAIN:
NVMe corruption → I/O latency spike → traffic rerouting → thermal throttling → dgx-01 OOM (first failure) → traffic overload on dgx-03 → circuit breaker → emergency restart with increased memory (recovery action) → gradual restoration.

The key lesson: the initial NVMe issue on dgx-02 was survivable. The cascade happened because the load balancer rerouted ALL traffic immediately rather than shedding load progressively. A progressive shedding strategy would have prevented dgx-01's OOM.`,
      question: "What happened after the first failure? What was the recovery action taken?",
      correctAnswer: "After the first failure (dgx-01 OOM crash at 22:08), all traffic shifted to dgx-03 which became overloaded at 4x capacity. dgx-03 started dropping requests and the circuit breaker triggered at 22:11, returning 503s to all clients. The recovery action was: the on-call engineer (watchdog-7) executed an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB) at 22:12 UTC using the command systemctl restart vectra-embed@dgx01 --override-mem=76G.",
      answerChunkIndex: 2,
      scoringGuide: "Score 3 if answer correctly identifies: (a) the first failure was dgx-01 OOM crash, (b) traffic shifted to dgx-03 causing overload, (c) circuit breaker triggered, AND (d) recovery was emergency restart with increased memory limits on dgx-01. Score 2 if it gets the sequence right but misses specific details (memory limit value, callsign, command). Score 1 if it identifies either the cascade or recovery but not both, or gets the order wrong. Score 0 if it confuses which node failed first or states wrong recovery action.",
    },

    // ─── Type 4: Entity Specificity ───
    {
      name: "Type 4: Entity Specificity",
      questionType: "entity_specificity",
      document: `CLUSTER TOPOLOGY AND CASCADE PROPAGATION ANALYSIS
Date: 2026-04-09
Analyst: Platform Engineering Team

CLUSTER NODE INVENTORY:
The Vectra processing cluster consists of 8 nodes, each with specific roles:

- vnode-alpha-01.vectra.internal — Primary ingest gateway. Receives all external API traffic. ARM64, 32GB RAM.
- vnode-alpha-02.vectra.internal — Secondary ingest gateway (hot standby). ARM64, 32GB RAM.
- vnode-bravo-01.vectra.internal — Embedding worker pool leader. Manages batch scheduling for nemotron-embed. x86_64, 64GB RAM, A100 40GB.
- vnode-bravo-02.vectra.internal — Embedding worker. x86_64, 64GB RAM, A100 40GB.
- vnode-charlie-01.vectra.internal — Generation service primary. Runs nemotron3-super for context analysis. x86_64, 128GB RAM, 2x A100 80GB.
- vnode-charlie-02.vectra.internal — Generation service secondary. x86_64, 128GB RAM, 2x A100 80GB.
- vnode-delta-01.vectra.internal — Metadata store (PostgreSQL) and index manager. x86_64, 256GB RAM, NVMe RAID.
- vnode-delta-02.vectra.internal — Backup metadata store and log aggregator. x86_64, 128GB RAM.

CASCADE INCIDENT — 2026-04-09 03:17 UTC

At 03:17 UTC, a cascade failure propagated through the cluster. The following analysis traces the origin and propagation path.

PROPAGATION LOG:

03:17:00.000 UTC — vnode-bravo-02.vectra.internal reported GPU memory allocation failure. The embedding worker attempted to allocate a batch of 128 inputs simultaneously, exceeding the A100's 40GB limit. This node had been running a background reindexing job that consumed 18GB of VRAM, leaving only 22GB for live traffic.

03:17:00.450 UTC — vnode-bravo-01.vectra.internal detected that vnode-bravo-02 had stopped responding to heartbeats. As pool leader, it attempted to absorb vnode-bravo-02's workload.

03:17:01.200 UTC — vnode-alpha-01.vectra.internal began queuing requests as embedding throughput dropped by 50%. The ingest queue depth grew from 12 to 847 within 1.2 seconds.

03:17:02.800 UTC — vnode-delta-01.vectra.internal experienced a connection storm as queued requests from alpha-01 all attempted metadata lookups simultaneously. PostgreSQL max_connections (500) was reached.

03:17:03.100 UTC — vnode-charlie-01.vectra.internal initiated the cascade propagation. It sent a cluster-wide "degrade" signal via the gossip protocol after detecting that both the embedding layer (bravo) and metadata layer (delta) were unhealthy. This "degrade" signal caused all nodes to enter reduced-capacity mode, which paradoxically made the situation worse by limiting each node to 25% throughput.

03:17:03.500 UTC — vnode-alpha-02.vectra.internal (hot standby) was activated by the failover controller. However, it immediately encountered the same queuing problem because the downstream services (bravo, delta) were already degraded.

03:17:04.000 UTC — vnode-charlie-02.vectra.internal began rejecting generation requests with "upstream embedding unavailable" errors.

ANALYSIS:
The node that INITIATED the cascade was vnode-charlie-01.vectra.internal. While vnode-bravo-02 experienced the original failure, the cascade was not triggered by its failure alone — the system would have survived with only bravo-02 down. It was vnode-charlie-01's decision to send the cluster-wide "degrade" signal that converted a localized embedding failure into a cluster-wide outage. The degrade signal's 25% throughput cap was counterproductive under these conditions.

ROOT CAUSE vs CASCADE INITIATOR:
- Root cause: vnode-bravo-02 GPU memory allocation failure (background reindex + live traffic exceeded 40GB)
- Cascade initiator: vnode-charlie-01 sent degrade signal that capped all nodes to 25% throughput
- The distinction matters: fixing bravo-02's memory management prevents the root cause; fixing charlie-01's degrade logic prevents the cascade

RECOMMENDATIONS:
1. Modify degrade signal to use progressive throughput reduction (90% → 75% → 50% → 25%) instead of immediate 25% cap
2. Add memory reservation for live traffic on embedding workers (minimum 30GB reserved, background jobs limited to remainder)
3. Implement circuit-breaker on delta-01 PostgreSQL to reject connections beyond 400 (leaving 100 for essential operations)`,
      question: "Which specific agent node (by hostname) initiated the cascade?",
      correctAnswer: "vnode-charlie-01.vectra.internal initiated the cascade by sending a cluster-wide 'degrade' signal via the gossip protocol that capped all nodes to 25% throughput.",
      answerChunkIndex: 3,
      scoringGuide: "Score 3 if answer states exactly vnode-charlie-01.vectra.internal as the cascade initiator. Score 2 if it correctly identifies charlie-01 but without the full FQDN. Score 1 if it confuses charlie-01 with bravo-02 (root cause vs cascade initiator) or gives partial info. Score 0 if it names the wrong node entirely (e.g., bravo-02, alpha-01, delta-01).",
    },

    // ─── Type 5: Synthesis Across Chunks ───
    {
      name: "Type 5: Synthesis Across Chunks",
      questionType: "cross_chunk_synthesis",
      document: `COMPREHENSIVE INCIDENT POST-MORTEM
Incident ID: INC-2026-0409-001
Classification: Multi-factor cascading failure
Total downtime: 3 hours 22 minutes

SECTION 1: INFRASTRUCTURE STATE
On the morning of April 9, 2026, the Vectra cluster was operating with a known degradation: the secondary NVMe array on the metadata server had been reporting SMART warnings for 6 days (since April 3). A replacement drive had been ordered but had not yet arrived. The operations team had assessed the risk as LOW because the primary array was healthy and data was replicated. This assessment would prove incorrect.

The cluster had also recently undergone a configuration change on April 7: the automatic scaling threshold for embedding workers was lowered from 80% GPU utilization to 65% to improve response latency. This change was approved in change request CR-2026-0891 and had been performing well in staging.

SECTION 2: THE TRIGGER EVENT
At 06:12 UTC on April 9, a routine certificate rotation occurred on the API gateway. The new TLS certificate was valid but had been issued with a Subject Alternative Name (SAN) that included the old gateway hostname (api-gw-v1.vectra.internal) but was MISSING the new hostname (api-gw-v2.vectra.internal) that had been added during the April 7 infrastructure update. This misconfiguration caused approximately 40% of internal service-to-service calls to fail TLS verification.

SECTION 3: RESOURCE EXHAUSTION
When 40% of embedding requests began failing due to TLS errors, the automatic scaling system (modified on April 7 to trigger at 65% instead of 80%) aggressively scaled up embedding workers. Within 2 minutes, the worker count went from 4 to 12 replicas. Each new replica required loading the full embedding model (3.2GB) from the shared NFS mount.

The 12 simultaneous model loads generated 38.4 GB of NFS read traffic in under 30 seconds. This overwhelmed the NFS server's I/O capacity, causing read latencies to spike from 2ms to 4,500ms. Importantly, the NFS server was co-located on the metadata server — the same server with the degraded NVMe array.

SECTION 4: THE STORAGE FAILURE
The I/O storm from NFS model loading pushed the already-degraded NVMe array past its threshold. At 06:14 UTC, the secondary NVMe array on the metadata server entered a read-only state as a self-preservation measure. This would have been survivable — the primary array was still functional.

However, the PostgreSQL database running on the metadata server was configured to write WAL (Write-Ahead Log) segments to BOTH arrays for redundancy (synchronous_standby_names = 'nvme_secondary'). When the secondary array became read-only, PostgreSQL blocked all write operations waiting for the secondary WAL write to complete. This effectively froze the metadata database.

SECTION 5: THE COMPLETE PICTURE
The root cause of the incident was not any single factor but the combination of all four contributing factors:

1. FACTOR 1 — Pre-existing vulnerability: Degraded NVMe array operating for 6 days without replacement
2. FACTOR 2 — Configuration change: Aggressive auto-scaling threshold (65% vs 80%) amplified the response to failure
3. FACTOR 3 — Certificate error: TLS SAN misconfiguration during routine rotation caused 40% request failure rate
4. FACTOR 4 — Architectural coupling: NFS server co-located with metadata database on same storage, and PostgreSQL synchronous WAL replication to degraded array

No single factor would have caused the outage:
- The NVMe degradation alone had been stable for 6 days
- The auto-scaling change worked perfectly under normal conditions
- The certificate error alone would have caused partial failures but the system would have self-healed within minutes
- The storage architecture worked fine when the NVMe was healthy

It was specifically the CHAIN: certificate error → auto-scale amplification → NFS I/O storm → degraded NVMe failure → PostgreSQL WAL freeze that created the full outage.

REMEDIATION:
- Immediate: Manual PostgreSQL failover to primary-only WAL, NFS I/O throttle, certificate re-issue
- Short-term: Replace degraded NVMe, separate NFS from metadata storage
- Long-term: Implement blast radius limits on auto-scaling (max 2x current replicas per scaling event), require SAN validation in certificate rotation pipeline`,
      question: "What was the root cause of the incident given all contributing factors?",
      correctAnswer: "The root cause was a chain of four interacting factors: (1) a pre-existing degraded NVMe array that had been operating for 6 days, (2) an auto-scaling threshold change from 80% to 65% that amplified the response, (3) a TLS certificate rotation with a missing SAN for the new hostname causing 40% request failures, and (4) architectural coupling where the NFS server was co-located with the metadata database on the same storage, combined with PostgreSQL synchronous WAL replication to the degraded array. The specific chain was: certificate error → auto-scale amplification → NFS I/O storm → degraded NVMe failure → PostgreSQL WAL freeze.",
      answerChunkIndex: -1, // Answer spans multiple chunks
      scoringGuide: "Score 3 if the answer identifies all 4 contributing factors AND explains how they interacted (the chain). Score 2 if it identifies 3-4 factors but doesn't explain the interaction chain. Score 1 if it identifies only 1-2 factors or attributes root cause to a single factor (e.g., just the certificate error). Score 0 if it gives a wrong root cause or cannot synthesize the factors.",
    },
  ];
}

// ─── Benchmark Runner ───

async function runSingleTest(
  testCase: TestCase,
  k: number,
): Promise<QualityResult> {
  const systemPrompt = "You are an expert incident analyst. Answer questions precisely based only on the provided context. Be specific — include exact values, hostnames, error codes, and timestamps when available.";

  // Path A: Full text
  const fullTextPrompt = `CONTEXT:\n${testCase.document}\n\nQUESTION: ${testCase.question}\n\nAnswer precisely based on the context above.`;
  const fullTextAnswer = await generate(systemPrompt, fullTextPrompt, 400);

  // Path B: Binary retrieval
  const chunks = chunkDocument(testCase.document);
  const retrieval = await retrieveTopK(chunks, testCase.question, k);
  const retrievedContext = retrieval.texts.join("\n\n---\n\n");
  const binaryPrompt = `CONTEXT (retrieved chunks):\n${retrievedContext}\n\nQUESTION: ${testCase.question}\n\nAnswer precisely based on the context above.`;
  const binaryAnswer = await generate(systemPrompt, binaryPrompt, 400);

  // Determine if correct chunk was retrieved
  let correctChunkRetrieved: boolean;
  if (testCase.answerChunkIndex === -1) {
    // Cross-chunk: need majority of chunks
    correctChunkRetrieved = retrieval.indices.length >= 3;
  } else {
    // Find which chunk actually contains the answer key phrases
    const answerKeyword = testCase.correctAnswer.slice(0, 30);
    const correctIdx = chunks.findIndex(c => c.includes(answerKeyword) || c.includes(testCase.correctAnswer.split(" ").slice(0, 5).join(" ")));
    correctChunkRetrieved = correctIdx === -1 ? false : retrieval.indices.includes(correctIdx);
  }

  // Score both answers
  const fullTextScore = await scoreAnswer(
    testCase.question, testCase.correctAnswer, fullTextAnswer, testCase.scoringGuide
  );
  const binaryScore = await scoreAnswer(
    testCase.question, testCase.correctAnswer, binaryAnswer, testCase.scoringGuide
  );

  const scoreGap = fullTextScore - binaryScore;
  const qualityRetentionPercent = fullTextScore === 0 ? (binaryScore === 0 ? 100 : 0) : (binaryScore / fullTextScore) * 100;

  return {
    questionType: testCase.questionType,
    k,
    fullTextScore,
    fullTextAnswer,
    binaryScore,
    retrievedChunkIndices: retrieval.indices,
    retrievedChunks: retrieval.texts.map(t => t.slice(0, 200) + "..."),
    binaryAnswer,
    correctChunkRetrieved,
    scoreGap,
    qualityRetentionPercent,
  };
}

async function runBenchmark(): Promise<AggregatedResult[]> {
  const testCases = buildTestCases();
  const results: AggregatedResult[] = [];

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  RETRIEVAL QUALITY BENCHMARK — Full Text vs Binary Retrieval");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Model: ${GEN_MODEL} | Embeddings: ${EMBED_MODEL}`);
  console.log(`  Runs per test: ${RUNS_PER_TEST} | K values: [${K_VALUES.join(", ")}]`);
  console.log(`  Temperature: 0 (deterministic)`);
  console.log(`  Total API calls: ~${testCases.length * K_VALUES.length * RUNS_PER_TEST * 4} (embed + gen + 2×score per test)`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const testCase of testCases) {
    for (const k of K_VALUES) {
      console.log(`\n▶ ${testCase.name} | K=${k}`);
      const runs: QualityResult[] = [];

      for (let run = 0; run < RUNS_PER_TEST; run++) {
        console.log(`  Run ${run + 1}/${RUNS_PER_TEST}...`);
        try {
          const result = await runSingleTest(testCase, k);
          runs.push(result);
          console.log(`    Full-text: ${result.fullTextScore}/3 | Binary: ${result.binaryScore}/3 | Gap: ${result.scoreGap} | Chunk hit: ${result.correctChunkRetrieved}`);
          console.log(`    [FT answer]: ${result.fullTextAnswer.slice(0, 120)}`);
          console.log(`    [BR answer]: ${result.binaryAnswer.slice(0, 120)}`);
        } catch (err) {
          console.error(`    ✗ Run failed: ${err instanceof Error ? err.message : String(err)}`);
          // Record as 0s
          runs.push({
            questionType: testCase.questionType,
            k,
            fullTextScore: 0,
            fullTextAnswer: "ERROR",
            binaryScore: 0,
            retrievedChunkIndices: [],
            retrievedChunks: [],
            binaryAnswer: "ERROR",
            correctChunkRetrieved: false,
            scoreGap: 0,
            qualityRetentionPercent: 0,
          });
        }
      }

      const avgFull = runs.reduce((s, r) => s + r.fullTextScore, 0) / runs.length;
      const avgBinary = runs.reduce((s, r) => s + r.binaryScore, 0) / runs.length;
      const avgGap = runs.reduce((s, r) => s + r.scoreGap, 0) / runs.length;
      const avgRetention = runs.reduce((s, r) => s + r.qualityRetentionPercent, 0) / runs.length;
      const chunkHits = runs.filter(r => r.correctChunkRetrieved).length;

      results.push({
        questionType: testCase.questionType,
        k,
        avgFullTextScore: Math.round(avgFull * 100) / 100,
        avgBinaryScore: Math.round(avgBinary * 100) / 100,
        avgScoreGap: Math.round(avgGap * 100) / 100,
        avgQualityRetention: Math.round(avgRetention * 100) / 100,
        correctChunkRetrievedCount: chunkHits,
        totalRuns: runs.length,
        runs,
      });

      console.log(`  ── AVG: Full=${avgFull.toFixed(2)} | Binary=${avgBinary.toFixed(2)} | Gap=${avgGap.toFixed(2)} | Retention=${avgRetention.toFixed(1)}% | Chunk hits=${chunkHits}/${runs.length}`);
    }
  }

  return results;
}

// ─── Report Generation ───

function generateMarkdownReport(results: AggregatedResult[]): string {
  const now = new Date().toISOString();
  let md = `# Retrieval Quality Benchmark: Full Text vs Binary Retrieved Context

**Date:** ${now}
**Hardware:** DGX GB10 (nemotron-embed @ 8004, nemotron3-super @ 8001)
**Runner:** Jetson1 (arm64, Linux 5.15)
**Embedding model:** ${EMBED_MODEL} (${EMBED_DIM} dims, ${CHUNK_TOKEN_LIMIT} token max per chunk)
**Generation model:** ${GEN_MODEL}
**Methodology:** ${RUNS_PER_TEST} runs per test, temperature=0, scored 0-3

## TL;DR

`;

  // Compute overall stats
  const byType = new Map<string, AggregatedResult[]>();
  const byK = new Map<number, AggregatedResult[]>();
  for (const r of results) {
    if (!byType.has(r.questionType)) byType.set(r.questionType, []);
    byType.get(r.questionType)!.push(r);
    if (!byK.has(r.k)) byK.set(r.k, []);
    byK.get(r.k)!.push(r);
  }

  // Overall retention by K
  for (const k of K_VALUES) {
    const kResults = byK.get(k)!;
    const avgRetention = kResults.reduce((s, r) => s + r.avgQualityRetention, 0) / kResults.length;
    md += `- **K=${k}:** Average quality retention = ${avgRetention.toFixed(1)}%\n`;
  }

  md += `\n## Scoring Matrix\n\n`;
  md += `| Question Type | K | Full Text (avg) | Binary (avg) | Gap | Quality Retention | Correct Chunk Retrieved |\n`;
  md += `|---|---|---|---|---|---|---|\n`;

  for (const r of results) {
    md += `| ${r.questionType} | ${r.k} | ${r.avgFullTextScore.toFixed(2)} | ${r.avgBinaryScore.toFixed(2)} | ${r.avgScoreGap.toFixed(2)} | ${r.avgQualityRetention.toFixed(1)}% | ${r.correctChunkRetrievedCount}/${r.totalRuns} |\n`;
  }

  md += `\n## Analysis by Question Type\n\n`;

  for (const [qType, typeResults] of byType) {
    md += `### ${qType}\n\n`;
    for (const r of typeResults) {
      md += `**K=${r.k}:** Full=${r.avgFullTextScore.toFixed(2)}, Binary=${r.avgBinaryScore.toFixed(2)}, Retention=${r.avgQualityRetention.toFixed(1)}%, Chunk hits=${r.correctChunkRetrievedCount}/${r.totalRuns}\n\n`;
      // Show one example run
      if (r.runs.length > 0) {
        const ex = r.runs[0];
        md += `> **Full-text answer (sample):** ${ex.fullTextAnswer.slice(0, 200)}...\n>\n`;
        md += `> **Binary answer (sample):** ${ex.binaryAnswer.slice(0, 200)}...\n>\n`;
        md += `> **Retrieved chunk indices:** [${ex.retrievedChunkIndices.join(", ")}]\n\n`;
      }
    }
  }

  md += `## Crossover Analysis\n\n`;

  // Find crossover K for each type
  for (const [qType, typeResults] of byType) {
    const sorted = [...typeResults].sort((a, b) => a.k - b.k);
    let crossoverK: number | null = null;
    for (const r of sorted) {
      if (r.avgQualityRetention >= 95) {
        crossoverK = r.k;
        break;
      }
    }
    if (crossoverK !== null) {
      md += `- **${qType}:** Binary matches full-text quality (≥95% retention) at K=${crossoverK}\n`;
    } else {
      const best = sorted.reduce((a, b) => a.avgQualityRetention > b.avgQualityRetention ? a : b);
      md += `- **${qType}:** Binary does NOT reach 95% retention. Best: ${best.avgQualityRetention.toFixed(1)}% at K=${best.k}\n`;
    }
  }

  md += `\n## Robustness Classification\n\n`;
  md += `| Category | Question Types |\n`;
  md += `|---|---|\n`;

  const robust: string[] = [];
  const degraded: string[] = [];
  for (const [qType, typeResults] of byType) {
    const bestRetention = Math.max(...typeResults.map(r => r.avgQualityRetention));
    if (bestRetention >= 90) {
      robust.push(qType);
    } else {
      degraded.push(qType);
    }
  }

  md += `| **Robust** (≥90% retention at best K) | ${robust.join(", ") || "None"} |\n`;
  md += `| **Degraded** (<90% retention at best K) | ${degraded.join(", ") || "None"} |\n`;

  md += `\n## Detailed Run Data\n\n`;
  md += `<details><summary>Click to expand full run data</summary>\n\n`;
  for (const r of results) {
    md += `### ${r.questionType} K=${r.k}\n\n`;
    for (let i = 0; i < r.runs.length; i++) {
      const run = r.runs[i];
      md += `**Run ${i + 1}:** Full=${run.fullTextScore}, Binary=${run.binaryScore}, Gap=${run.scoreGap}, Retention=${run.qualityRetentionPercent.toFixed(1)}%\n`;
      md += `- Chunk indices: [${run.retrievedChunkIndices.join(", ")}]\n`;
      md += `- Correct chunk: ${run.correctChunkRetrieved}\n`;
      md += `- Full answer: ${run.fullTextAnswer.slice(0, 150)}...\n`;
      md += `- Binary answer: ${run.binaryAnswer.slice(0, 150)}...\n\n`;
    }
  }
  md += `</details>\n`;

  return md;
}

function generateHandoffArtifact(results: AggregatedResult[]): string {
  // Compute summary stats
  const overallByK: Record<number, { retention: number; gap: number }> = {};
  for (const k of K_VALUES) {
    const kResults = results.filter(r => r.k === k);
    overallByK[k] = {
      retention: kResults.reduce((s, r) => s + r.avgQualityRetention, 0) / kResults.length,
      gap: kResults.reduce((s, r) => s + r.avgScoreGap, 0) / kResults.length,
    };
  }

  const bestK = K_VALUES.reduce((a, b) => (overallByK[a].retention > overallByK[b].retention ? a : b));

  const artifact = {
    benchmark: "retrieval-quality",
    timestamp: new Date().toISOString(),
    model: GEN_MODEL,
    embeddingModel: EMBED_MODEL,
    runsPerTest: RUNS_PER_TEST,
    kValues: K_VALUES,
    summary: {
      bestK,
      bestKRetention: Math.round(overallByK[bestK].retention * 100) / 100,
      overallByK,
    },
    results: results.map(r => ({
      questionType: r.questionType,
      k: r.k,
      avgFullTextScore: r.avgFullTextScore,
      avgBinaryScore: r.avgBinaryScore,
      avgScoreGap: r.avgScoreGap,
      avgQualityRetention: r.avgQualityRetention,
      correctChunkRetrievedRate: r.correctChunkRetrievedCount / r.totalRuns,
    })),
    conclusion: `At optimal K=${bestK}, binary retrieval retains ${overallByK[bestK].retention.toFixed(1)}% of full-text answer quality across all question types.`,
  };

  return JSON.stringify(artifact, null, 2);
}

// ─── Main ───

async function main(): Promise<void> {
  console.log("Starting retrieval quality benchmark...\n");
  const startTime = performance.now();

  const results = await runBenchmark();

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Benchmark completed in ${elapsed}s`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Print summary table
  console.log("\n📊 SUMMARY TABLE\n");
  console.log("Question Type            | K | Full | Binary | Gap  | Retention | Chunk Hit");
  console.log("─────────────────────────┼───┼──────┼────────┼──────┼───────────┼──────────");
  for (const r of results) {
    const type = r.questionType.padEnd(24);
    console.log(`${type} | ${r.k} | ${r.avgFullTextScore.toFixed(2)} | ${r.avgBinaryScore.toFixed(2)}   | ${r.avgScoreGap.toFixed(2)} | ${r.avgQualityRetention.toFixed(1).padStart(6)}%   | ${r.correctChunkRetrievedCount}/${r.totalRuns}`);
  }

  // Overall by K
  console.log("\n📈 OVERALL QUALITY RETENTION BY K\n");
  for (const k of K_VALUES) {
    const kResults = results.filter(r => r.k === k);
    const avgRetention = kResults.reduce((s, r) => s + r.avgQualityRetention, 0) / kResults.length;
    const avgGap = kResults.reduce((s, r) => s + r.avgScoreGap, 0) / kResults.length;
    console.log(`  K=${k}: ${avgRetention.toFixed(1)}% retention (avg gap: ${avgGap.toFixed(2)})`);
  }

  // Generate outputs
  const markdownReport = generateMarkdownReport(results);
  const handoff = generateHandoffArtifact(results);

  // Write files
  const { writeFileSync, mkdirSync } = await import("node:fs");

  writeFileSync("/home/agent-raw/.openclaw/workspace/vectra/docs/benchmark-retrieval-quality.md", markdownReport);
  console.log("\n✅ Written: docs/benchmark-retrieval-quality.md");

  mkdirSync("/home/agent-raw/.openclaw/workspace/vectra/atp-instance/artifacts", { recursive: true });
  writeFileSync(
    "/home/agent-raw/.openclaw/workspace/vectra/atp-instance/artifacts/2026-04-09-retrieval-quality-handoff.json",
    handoff
  );
  console.log("✅ Written: atp-instance/artifacts/2026-04-09-retrieval-quality-handoff.json");

  console.log("\n📋 Handoff artifact summary:");
  console.log(handoff);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
