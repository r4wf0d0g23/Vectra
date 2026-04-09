# Retrieval Quality Benchmark: Full Text vs Binary Retrieved Context

**Date:** 2026-04-09T19:56:16.314Z
**Hardware:** DGX GB10 (nemotron-embed @ 8004, nemotron3-super @ 8001)
**Runner:** Jetson1 (arm64, Linux 5.15)
**Embedding model:** nemotron-embed (2048 dims, 512 token max per chunk)
**Generation model:** nemotron3-super
**Methodology:** 3 runs per test, temperature=0, scored 0-3

## TL;DR

- **K=1:** Average quality retention = 100.0%
- **K=3:** Average quality retention = 100.0%
- **K=5:** Average quality retention = 100.0%

## Scoring Matrix

| Question Type | K | Full Text (avg) | Binary (avg) | Gap | Quality Retention | Correct Chunk Retrieved |
|---|---|---|---|---|---|---|
| fact_recall | 1 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| fact_recall | 3 | 0.00 | 0.00 | 0.00 | 100.0% | 3/3 |
| fact_recall | 5 | 0.00 | 0.00 | 0.00 | 100.0% | 3/3 |
| numerical_precision | 1 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| numerical_precision | 3 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| numerical_precision | 5 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| sequential_reasoning | 1 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| sequential_reasoning | 3 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| sequential_reasoning | 5 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| entity_specificity | 1 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| entity_specificity | 3 | 0.00 | 0.00 | 0.00 | 100.0% | 3/3 |
| entity_specificity | 5 | 0.00 | 0.00 | 0.00 | 100.0% | 3/3 |
| cross_chunk_synthesis | 1 | 0.00 | 0.00 | 0.00 | 100.0% | 0/3 |
| cross_chunk_synthesis | 3 | 0.00 | 0.00 | 0.00 | 100.0% | 3/3 |
| cross_chunk_synthesis | 5 | 0.00 | 0.00 | 0.00 | 100.0% | 3/3 |

## Analysis by Question Type

### fact_recall

**K=1:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** ERR-AUTH-7742...
>
> **Binary answer (sample):** We need to answer: "What was the error code returned by the authentication service during the incident?" Based on context: At 14:40 UTC — Auth service connection pool recovered. JWT refresh succeeded....
>
> **Retrieved chunk indices:** [1]

**K=3:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=3/3

> **Full-text answer (sample):** ERR-AUTH-7742...
>
> **Binary answer (sample):** ERR-AUTH-7742...
>
> **Retrieved chunk indices:** [1, 0]

**K=5:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=3/3

> **Full-text answer (sample):** ERR-AUTH-7742...
>
> **Binary answer (sample):** ERR-AUTH-7742...
>
> **Retrieved chunk indices:** [1, 0]

### numerical_precision

**K=1:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** 87.3%...
>
> **Binary answer (sample):** 87.3%...
>
> **Retrieved chunk indices:** [0]

**K=3:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** 87.3%...
>
> **Binary answer (sample):** 87.3%...
>
> **Retrieved chunk indices:** [0, 1]

**K=5:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** 87.3%...
>
> **Binary answer (sample):** 87.3%...
>
> **Retrieved chunk indices:** [0, 1]

### sequential_reasoning

**K=1:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB, reserving 4GB for system). The restart command wa...
>
> **Binary answer (sample):** We need to answer: "What happened after the first failure? What was the recovery action taken?" Based on context: after first failure (dgx-01 OOM), there was traffic overload on dgx-03, circuit breake...
>
> **Retrieved chunk indices:** [2]

**K=3:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB, reserving 4GB for system). The restart command wa...
>
> **Binary answer (sample):** The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB, reserving 4GB for system). The restart command wa...
>
> **Retrieved chunk indices:** [2, 1, 0]

**K=5:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB, reserving 4GB for system). The restart command wa...
>
> **Binary answer (sample):** The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB, reserving 4GB for system). The restart command wa...
>
> **Retrieved chunk indices:** [2, 1, 0]

### entity_specificity

**K=1:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** vnode-charlie-01.vectra.internal...
>
> **Binary answer (sample):** vnode-charlie-01.vectra.internal...
>
> **Retrieved chunk indices:** [2]

**K=3:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=3/3

> **Full-text answer (sample):** The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....
>
> **Binary answer (sample):** vnode-charlie-01.vectra.internal...
>
> **Retrieved chunk indices:** [2, 0, 1]

**K=5:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=3/3

> **Full-text answer (sample):** vnode-charlie-01.vectra.internal...
>
> **Binary answer (sample):** vnode-charlie-01.vectra.internal...
>
> **Retrieved chunk indices:** [2, 0, 1]

### cross_chunk_synthesis

**K=1:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=0/3

> **Full-text answer (sample):** The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 days without replacement), configuration change (ag...
>
> **Binary answer (sample):** We need to answer: "What was the root cause of the incident given all contributing factors?" Based on context, the root cause is the chain: certificate error → auto-scale amplification → NFS I/O storm...
>
> **Retrieved chunk indices:** [2]

**K=3:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=3/3

> **Full-text answer (sample):** The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 days without replacement), configuration change (ag...
>
> **Binary answer (sample):** The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration) → auto-scaling threshold change (65% vs 80%) → NFS I/O storm from mode...
>
> **Retrieved chunk indices:** [2, 0, 1]

**K=5:** Full=0.00, Binary=0.00, Retention=100.0%, Chunk hits=3/3

> **Full-text answer (sample):** The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 days without replacement), configuration change (ag...
>
> **Binary answer (sample):** The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration), auto-scaling threshold change (65% vs 80%), NFS I/O storm from model ...
>
> **Retrieved chunk indices:** [2, 0, 1]

## Crossover Analysis

- **fact_recall:** Binary matches full-text quality (≥95% retention) at K=1
- **numerical_precision:** Binary matches full-text quality (≥95% retention) at K=1
- **sequential_reasoning:** Binary matches full-text quality (≥95% retention) at K=1
- **entity_specificity:** Binary matches full-text quality (≥95% retention) at K=1
- **cross_chunk_synthesis:** Binary matches full-text quality (≥95% retention) at K=1

## Robustness Classification

| Category | Question Types |
|---|---|
| **Robust** (≥90% retention at best K) | fact_recall, numerical_precision, sequential_reasoning, entity_specificity, cross_chunk_synthesis |
| **Degraded** (<90% retention at best K) | None |

## Detailed Run Data

<details><summary>Click to expand full run data</summary>

### fact_recall K=1

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1]
- Correct chunk: false
- Full answer: ERR-AUTH-7742...
- Binary answer: We need to answer: "What was the error code returned by the authentication service during the incident?" Based on context: At 14:40 UTC — Auth service...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1]
- Correct chunk: false
- Full answer: ERR-AUTH-7742...
- Binary answer: We need to answer: "What was the error code returned by the authentication service during the incident?" Based on context: At 14:40 UTC — Auth service...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1]
- Correct chunk: false
- Full answer: ERR-AUTH-7742...
- Binary answer: We need to answer: "What was the error code returned by the authentication service during the incident?" Based on context: At 14:40 UTC — Auth service...

### fact_recall K=3

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1, 0]
- Correct chunk: true
- Full answer: ERR-AUTH-7742...
- Binary answer: ERR-AUTH-7742...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1, 0]
- Correct chunk: true
- Full answer: ERR-AUTH-7742...
- Binary answer: ERR-AUTH-7742...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1, 0]
- Correct chunk: true
- Full answer: ERR-AUTH-7742...
- Binary answer: ERR-AUTH-7742...

### fact_recall K=5

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1, 0]
- Correct chunk: true
- Full answer: ERR-AUTH-7742...
- Binary answer: ERR-AUTH-7742...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1, 0]
- Correct chunk: true
- Full answer: ERR-AUTH-7742...
- Binary answer: The authentication service returned error code ERR-AUTH-7742....

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [1, 0]
- Correct chunk: true
- Full answer: ERR-AUTH-7742...
- Binary answer: ERR-AUTH-7742...

### numerical_precision K=1

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: The memory utilization percentage at peak load is 87.3%....

### numerical_precision K=3

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0, 1]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0, 1]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0, 1]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

### numerical_precision K=5

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0, 1]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0, 1]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [0, 1]
- Correct chunk: false
- Full answer: 87.3%...
- Binary answer: 87.3%...

### sequential_reasoning K=1

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: We need to answer: "What happened after the first failure? What was the recovery action taken?" Based on context: after first failure (dgx-01 OOM), th...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The recovery action after the first failure was the on-call engineer (callsign: watchdog-7) executing an emergency restart of the embedding service on...
- Binary answer: We need to answer: "What happened after the first failure? What was the recovery action taken?" Based on context: after first failure (dgx-01 OOM), th...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: We need to answer: "What happened after the first failure? What was the recovery action taken?" Based on context: after first failure (dgx-01 OOM), th...

### sequential_reasoning K=3

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 1, 0]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 1, 0]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 1, 0]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...

### sequential_reasoning K=5

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 1, 0]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 1, 0]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 1, 0]
- Correct chunk: false
- Full answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...
- Binary answer: The recovery action after the first failure was an emergency restart of the embedding service on dgx-01 with increased memory limits (--max-vram=76GB,...

### entity_specificity K=1

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: vnode-charlie-01.vectra.internal...
- Binary answer: vnode-charlie-01.vectra.internal...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: vnode-charlie-01.vectra.internal...
- Binary answer: vnode-charlie-01.vectra.internal...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....
- Binary answer: vnode-charlie-01.vectra.internal...

### entity_specificity K=3

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....
- Binary answer: vnode-charlie-01.vectra.internal...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....
- Binary answer: vnode-charlie-01.vectra.internal...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: vnode-charlie-01.vectra.internal...
- Binary answer: The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....

### entity_specificity K=5

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: vnode-charlie-01.vectra.internal...
- Binary answer: vnode-charlie-01.vectra.internal...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....
- Binary answer: vnode-charlie-01.vectra.internal...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The specific agent node that initiated the cascade is vnode-charlie-01.vectra.internal....
- Binary answer: vnode-charlie-01.vectra.internal...

### cross_chunk_synthesis K=1

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: We need to answer: "What was the root cause of the incident given all contributing factors?" Based on context, the root cause is the chain: certificat...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: We need to answer: "What was the root cause of the incident given all contributing factors?" Based on context, the root cause is the chain: certificat...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2]
- Correct chunk: false
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: We need to answer: "What was the root cause of the incident given all contributing factors?" Based on context, the root cause is the chain: certificat...

### cross_chunk_synthesis K=3

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration) → auto-scaling thres...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration), auto-scaling thresh...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array), configuration c...
- Binary answer: The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration) → auto-scaling thres...

### cross_chunk_synthesis K=5

**Run 1:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration), auto-scaling thresh...

**Run 2:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration), auto-scaling thresh...

**Run 3:** Full=0, Binary=0, Gap=0, Retention=100.0%
- Chunk indices: [2, 0, 1]
- Correct chunk: true
- Full answer: The root cause of the incident was the combination of all four contributing factors: pre-existing vulnerability (degraded NVMe array operating for 6 d...
- Binary answer: The root cause of the incident was the combination of all four contributing factors: certificate error (TLS SAN misconfiguration), auto-scaling thresh...

</details>
