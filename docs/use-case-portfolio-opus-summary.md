# Use Case Portfolio — Executive Summary

**Date:** 2026-04-09 | **Source:** Benchmark Retrieval Quality v2 (45 Opus-judged Q&A pairs) + Context Pipeline Benchmark (DGX GB10)

---

## Key Finding

Binary vector retrieval at K=3 achieves **100% quality retention** versus full-text baseline across all five tested question types, with a **70x latency improvement** in multi-hop pipelines (327s → 4.7s at 128K tokens, 5 hops). At K=1, quality drops to **57%** — fact recall falls to 0%, cross-chunk synthesis to 33%. The crossover point is sharp and consistent: K≥3 matches full text; K<3 does not.

## Critical Caveat

The benchmark tested a single ~2K-token document (~4 chunks). **K=3 retrieves ~75% of the document.** Whether K=3 remains the crossover point when retrieving from 500+ chunks (where K=3 = 0.6% coverage) is untested. This is the #1 validation gap.

## Top 10 Use Cases (by readiness + impact)

1. **Agentic tool selection** — K=1 viable for distinctive tool descriptions; immediate Vectra integration
2. **Code search / developer tools** — Sub-200ms retrieval fits IDE latency budgets; large existing market
3. **Multi-agent pipeline coordination** — Core value prop; 5-stage pipeline goes from 5+ minutes to <5 seconds
4. **Conversational agent memory** — K≥3 mandatory; direct UX improvement for memory-augmented assistants
5. **Gaming NPC memory** — Binary retrieval fits game frame budgets; text inference does not
6. **Edge AI / embedded systems** — Vector math on constrained hardware; requires confidence-gated K expansion
7. **Legal discovery** — 70x transforms overnight batch into interactive query sessions
8. **Financial retrieval** — Sub-second retrieval for trading/compliance; K≥3 mandatory for risk assessment
9. **Robotics** — Inline knowledge retrieval during task execution; safety procedures need text fallback
10. **Medical knowledge bases** — Highest revenue potential; highest validation barrier; K≥3 non-negotiable

## Competitive Moat

**Structural:** Dual-space architecture (binary speed + text correctness) is a design pattern, not a model trick. ESP as a compatibility protocol has no equivalent. The O(1)-per-hop vs O(n)-per-hop advantage scales with pipeline depth regardless of hardware improvements.

**Temporary:** Absolute speed numbers are hardware-specific. As inference costs drop, the raw multiplier shrinks (but never to 1x — re-inference will always cost more than vector transfer).

## Methodology Contribution

The v1→v2 correction (self-judging inflated K=1 retention from 57% to 80%, created impossible K=5=120% artifact) demonstrates that **self-evaluation bias distorts RAG benchmarks by 20+ percentage points.** This finding, and the external-judge methodology, is a standalone contribution to RAG evaluation literature.

## Top 5 Recommendations

| # | Action | Priority | Effort |
|---|--------|----------|--------|
| 1 | **Multi-document benchmark at scale** — validate K=3 across 50+ documents | Critical | 1-2 weeks |
| 2 | **K-adaptive retrieval with confidence scoring** — K=1 for easy queries, auto-expand for synthesis | High | 2-3 weeks |
| 3 | **Cross-model ESV validation** — test drift detection against real model variants, not just synthetic noise | High | 3-5 days |
| 4 | **Build "zero-loss speedup" demo** — live side-by-side showing 70x speed at identical quality | High | 1 week |
| 5 | **Publish external judge methodology** — position as RAG evaluation contribution, open-source framework | Medium | 1 week |

## Bottom Line

The data supports the product thesis: binary retrieval is a verified acceleration layer, not a quality compromise — **when K≥3 and the corpus is well-structured.** The binding constraint is not speed or quality; it's validating that K=3 generalizes beyond small single-document retrieval. Recommendation #1 is the gate for everything else.

---

*Full analysis: [`use-case-portfolio-opus.md`](./use-case-portfolio-opus.md)*
