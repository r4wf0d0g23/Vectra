/**
 * ESP Calibration Pairs Benchmark
 *
 * Runs 3 labeled calibration pairs for CompatibilityProfile and computes
 * Pearson r between architectureDistance and retrievalOverlapRisk.
 *
 * This is the go/no-go test for the geometric ESP approach:
 * if r < 0.5, architecture distance does not predict retrieval compatibility.
 *
 * @see docs/esp-go-nogo.md
 */

import { ANCHOR_TEXTS } from '../embedding/anchor-set.js';
import { computeESV } from '../embedding/esv.js';
import { computeCompatibilityProfile, type CompatibilityProfile } from '../embedding/compatibility.js';
import { Embedder } from '../embedding/embedder.js';

// ─── Fetch with timeout + retry ──────────────────────────────────────

async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number = 120_000,
  maxRetries: number = 2,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastError = err as Error;
      if (attempt < maxRetries) {
        console.error(`  [retry ${attempt + 1}/${maxRetries}] ${lastError.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw lastError ?? new Error('fetchWithRetry: unknown error');
}

// ─── Embedder with timeout ───────────────────────────────────────────

class TimedEmbedder {
  private baseUrl: string;
  private cachedModelId: string | null = null;
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number = 120_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async getModelId(): Promise<string> {
    if (this.cachedModelId) return this.cachedModelId;
    const resp = await fetchWithRetry(`${this.baseUrl}/models`, {}, this.timeoutMs);
    if (!resp.ok) throw new Error(`Failed to list models: ${resp.status}`);
    const data = await resp.json() as { data: Array<{ id: string }> };
    if (!data.data?.length) throw new Error('No models at endpoint');
    this.cachedModelId = data.data[0].id;
    return this.cachedModelId;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const modelId = await this.getModelId();
    const resp = await fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, input: texts, encoding_format: 'float' }),
      },
      this.timeoutMs,
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Embed failed: ${resp.status} — ${body.slice(0, 200)}`);
    }
    const result = await resp.json() as { data: Array<{ embedding: number[]; index: number }> };
    return result.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

// ─── Corpus + Queries (copied from cross-model-esv-bench) ────────────

const DOCUMENTS: { title: string; text: string }[] = [
  {
    title: 'Machine Learning Fundamentals',
    text: `Machine learning is a branch of artificial intelligence that focuses on building systems that learn from and make decisions based on data. Rather than being explicitly programmed to perform a task, these systems learn from training examples to improve their performance over time. The field draws heavily from statistics, optimization theory, and computer science to develop algorithms capable of recognizing patterns in large datasets. Supervised learning is the most common paradigm, where models are trained on labeled examples consisting of input-output pairs. Common supervised learning algorithms include linear regression for continuous outputs and logistic regression for classification tasks. Deep learning, a subset of machine learning, uses neural networks with many layers to learn hierarchical representations of data. These deep neural networks have achieved remarkable success in tasks such as image recognition, natural language processing, and game playing. Unsupervised learning, in contrast, finds hidden structure in data without labeled examples, using techniques like clustering and dimensionality reduction.`,
  },
  {
    title: 'Neural Networks and Training',
    text: `Artificial neural networks are inspired by the biological neural networks that constitute animal brains. They consist of layers of interconnected nodes, or neurons, each performing simple computations. The training process involves feeding data through the network, computing a loss function that measures prediction error, and then using backpropagation to adjust the network weights to minimize this error. Gradient descent is the optimization algorithm most commonly used, iteratively moving the weights in the direction that reduces the loss. Modern deep learning frameworks like PyTorch and TensorFlow provide automatic differentiation, making it straightforward to compute these gradients. Regularization techniques such as dropout and weight decay help prevent overfitting, where a model memorizes training examples rather than learning generalizable patterns. Batch normalization and residual connections have become standard components of deep architectures, enabling the training of very deep networks that were previously difficult to optimize.`,
  },
  {
    title: 'Transformer Architecture',
    text: `The transformer architecture, introduced in the paper "Attention Is All You Need" by Vaswani et al. in 2017, revolutionized natural language processing and subsequently many other domains. Unlike recurrent neural networks that process sequences sequentially, transformers use self-attention mechanisms to process all tokens in parallel, enabling much faster training on modern hardware. The self-attention mechanism allows each token to attend to all other tokens in the sequence, capturing long-range dependencies efficiently. Positional encodings are added to the input embeddings to provide the model with information about token positions in the sequence. The transformer encoder-decoder architecture was originally designed for machine translation, but encoder-only models like BERT and decoder-only models like GPT have proven highly effective for a wide range of downstream tasks through fine-tuning or prompting.`,
  },
  {
    title: 'Embedding Models and Semantic Search',
    text: `Text embedding models convert text into dense numerical vectors in a high-dimensional space, where semantically similar texts are placed close together. These representations enable efficient semantic search, where queries are matched to documents based on meaning rather than keyword overlap. Early word embeddings like Word2Vec and GloVe represent individual words as fixed vectors. Modern sentence and document embedding models, built on transformer architectures, produce context-aware representations that capture meaning at the phrase and document level. Models like BERT, RoBERTa, and more specialized sentence transformers are widely used for semantic similarity and retrieval tasks. The quality of embeddings is typically evaluated on benchmarks measuring semantic textual similarity, natural language inference, and information retrieval. Embedding models trained on large text corpora with contrastive learning objectives have shown strong zero-shot generalization to new domains and tasks.`,
  },
  {
    title: 'The Roman Republic',
    text: `The Roman Republic was the era of classical Roman civilization beginning with the overthrow of the Roman Kingdom, traditionally dated to 509 BCE, and ending in 27 BCE with the establishment of the Roman Empire. During this period, Rome expanded from a small city-state on the Italian peninsula into the dominant power in the Mediterranean world. The republic was governed by elected magistrates and an advisory body known as the Senate. The two highest magistrates were the consuls, who held executive power and commanded the military. Roman law, developed extensively during the republic, distinguished between patricians, the aristocratic ruling class, and plebeians, the common citizens. Political conflict between these groups, known as the Conflict of the Orders, led to gradual expansion of plebeian political rights. Rome's military success during the republic was built on the legion, a disciplined heavy infantry formation that proved effective against the diverse armies encountered across the Mediterranean basin.`,
  },
  {
    title: 'Julius Caesar and the Late Republic',
    text: `Julius Caesar was a Roman general, statesman, and writer who played a critical role in the events that led to the demise of the Roman Republic and the rise of the Roman Empire. Born into a patrician family, Caesar rose through the cursus honorum, the traditional sequence of Roman political offices. His military campaigns in Gaul from 58 to 50 BCE expanded Roman territory significantly and made him enormously wealthy and popular with his soldiers. The Senate, fearing his power, ordered him to disband his army. Caesar instead crossed the Rubicon river with his troops, precipitating a civil war. After defeating his rivals, Caesar became dictator perpetuo, dictator in perpetuity, of Rome. His assassination on the Ides of March in 44 BCE by a group of senators led by Brutus and Cassius plunged Rome into another cycle of civil war. The vacuum left by his death was eventually filled by his adopted son Octavian, later Augustus.`,
  },
  {
    title: 'The Roman Empire at its Height',
    text: `The Roman Empire reached its greatest territorial extent under Emperor Trajan in 117 CE, encompassing territories from Britain in the northwest to Mesopotamia in the east, and from the Rhine and Danube rivers in central Europe to the Sahara Desert in North Africa. The empire was unified by an extensive road network, a common legal system, and widespread use of the Latin language in the western provinces and Greek in the eastern provinces. The Pax Romana, or Roman Peace, a period of relative internal stability lasting roughly two centuries from the reign of Augustus to the death of Marcus Aurelius, allowed trade and culture to flourish across these vast territories. Roman engineering achievements included aqueducts that supplied cities with fresh water, amphitheaters such as the Colosseum in Rome, and defensive fortifications like Hadrian's Wall in Britain. Roman culture, including its language, law, architecture, and religious traditions, profoundly shaped the subsequent development of European and Mediterranean civilization.`,
  },
  {
    title: 'Climate Change: Causes and Mechanisms',
    text: `Climate change refers to long-term shifts in global temperatures and weather patterns. While climate has varied naturally throughout Earth's history, scientific evidence strongly indicates that human activities have been the main driver of climate change since the mid-20th century. The primary mechanism is the enhanced greenhouse effect: gases such as carbon dioxide, methane, and nitrous oxide trap heat from the sun that would otherwise escape into space. Carbon dioxide concentrations in the atmosphere have risen from approximately 280 parts per million before industrialization to over 420 parts per million today, primarily from burning fossil fuels such as coal, oil, and natural gas. Deforestation contributes both by releasing stored carbon and by reducing the forest's capacity to absorb atmospheric carbon dioxide through photosynthesis. Methane emissions from livestock, rice cultivation, and natural gas leakage also contribute significantly to warming, as methane is a far more potent greenhouse gas than carbon dioxide over short timescales.`,
  },
  {
    title: 'Climate Change Impacts and Adaptation',
    text: `The impacts of climate change are already being observed across the globe, with effects on ecosystems, human societies, and physical systems. Global average surface temperature has risen approximately 1.1 degrees Celsius above pre-industrial levels, and this warming is driving changes in precipitation patterns, sea levels, and the frequency and intensity of extreme weather events. Sea level rise, caused by thermal expansion of warming ocean water and melting of ice sheets and glaciers, threatens low-lying coastal communities and small island nations. Coral reefs, among the most biodiverse marine ecosystems, are experiencing mass bleaching events as water temperatures exceed their tolerance limits. Changes in precipitation and temperature affect agricultural productivity, water availability, and the distribution of plant and animal species. Adaptation strategies range from building sea walls and improving drought-resistant crops to redesigning urban areas to reduce heat island effects and flooding risks.`,
  },
  {
    title: 'Quantum Computing Fundamentals',
    text: `Quantum computing harnesses the principles of quantum mechanics to perform computations that would be impractical or impossible for classical computers. While classical computers encode information in bits that are either zero or one, quantum computers use quantum bits, or qubits, which can exist in a superposition of both states simultaneously. This superposition, combined with the quantum phenomenon of entanglement, allows quantum computers to explore many possible solutions to a problem simultaneously. Quantum interference is used to amplify the probability of correct answers and cancel out wrong ones, enabling algorithms that solve certain problems exponentially faster than classical algorithms. The most famous quantum algorithms include Shor's algorithm for factoring large numbers, which threatens current encryption schemes, and Grover's algorithm, which provides a quadratic speedup for searching unsorted databases. Building practical quantum computers is extraordinarily challenging, as qubits are extremely fragile and any interaction with the environment causes decoherence, destroying quantum information.`,
  },
  {
    title: 'The Maillard Reaction and Caramelization',
    text: `The Maillard reaction is a chemical process between amino acids and reducing sugars that gives browned food its distinctive flavor. Named after French chemist Louis-Camille Maillard who first described it in 1912, the reaction occurs when proteins and sugars are heated together, typically above 140 to 165 degrees Celsius. It is responsible for the complex flavors and brown colors of seared meat, toasted bread, roasted coffee, and baked goods. Unlike caramelization, which involves only the breakdown of sugars, the Maillard reaction requires both proteins and sugars and produces hundreds of different flavor compounds. For optimal browning, the food surface must be dry, since water evaporation absorbs heat and keeps the surface temperature from reaching the threshold needed for the reaction. Professional cooks use this understanding to pat meat dry before searing, preheat pans until very hot, and avoid overcrowding which would cause the pan temperature to drop.`,
  },
];

const QUERIES: string[] = [
  'What is machine learning and how does it differ from traditional programming?',
  'How does backpropagation work in training neural networks?',
  'What is the transformer architecture and what makes it different from RNNs?',
  'How do embedding models enable semantic search?',
  'What is gradient descent and why is it used in machine learning?',
  'What was the Roman Republic and how was it governed?',
  'What role did Julius Caesar play in the fall of the Roman Republic?',
  'How large was the Roman Empire at its greatest extent?',
  'What are the main causes of climate change?',
  'How does the greenhouse effect contribute to global warming?',
  'What is a qubit and how is it different from a classical bit?',
  'What is the Maillard reaction and why does it matter for cooking?',
  'How does emulsification work in sauce making?',
  'What is fermentation and how is it used in food preservation?',
  'What is quantum supremacy and has it been achieved?',
];

// ─── Retrieval utilities ─────────────────────────────────────────────

function chunkText(text: string, maxSentences: number = 3): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += maxSentences) {
    const chunk = sentences.slice(i, i + maxSentences).join(' ').trim();
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getTopK(queryVec: number[], chunkVecs: number[][], k: number): number[] {
  return chunkVecs
    .map((c, i) => ({ i, sim: cosineSimilarity(queryVec, c) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map((s) => s.i);
}

function jaccardSimilarity(setA: number[], setB: number[]): number {
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function kendallTau(rankA: number[], rankB: number[]): number {
  const posB = new Map<number, number>();
  rankB.forEach((item, idx) => posB.set(item, idx));
  let concordant = 0, discordant = 0;
  for (let i = 0; i < rankA.length; i++) {
    for (let j = i + 1; j < rankA.length; j++) {
      const posI = posB.get(rankA[i]);
      const posJ = posB.get(rankA[j]);
      if (posI === undefined || posJ === undefined) continue;
      if (posI < posJ) concordant++; else discordant++;
    }
  }
  const total = concordant + discordant;
  return total > 0 ? (concordant - discordant) / total : 0;
}

function computeRetrievalMetrics(
  queryVecsA: number[][],
  chunkVecsA: number[][],
  queryVecsB: number[][],
  chunkVecsB: number[][],
  nChunks: number,
): { jaccardAtK3: number; kendallTauAtK10: number; queriesEvaluated: number; corpusChunks: number } {
  const K_TAU = 10;
  const jaccards: number[] = [];
  const taus: number[] = [];

  for (let qi = 0; qi < queryVecsA.length; qi++) {
    const topA = getTopK(queryVecsA[qi], chunkVecsA, K_TAU);
    const topB = getTopK(queryVecsB[qi], chunkVecsB, K_TAU);
    jaccards.push(jaccardSimilarity(topA.slice(0, 3), topB.slice(0, 3)));
    taus.push(kendallTau(topA, topB));
  }

  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  return {
    jaccardAtK3: Math.round(mean(jaccards) * 1e4) / 1e4,
    kendallTauAtK10: Math.round(mean(taus) * 1e4) / 1e4,
    queriesEvaluated: queryVecsA.length,
    corpusChunks: nChunks,
  };
}

// ─── Pearson r ───────────────────────────────────────────────────────

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(
    xs.reduce((s, x) => s + (x - mx) ** 2, 0) *
    ys.reduce((s, y) => s + (y - my) ** 2, 0),
  );
  return den === 0 ? NaN : num / den;
}

function interpretR(r: number, n: number): { interpretation: string; goNoGo: string } {
  if (n < 3 || isNaN(r)) {
    return { interpretation: 'insufficient-data', goNoGo: 'insufficient-data' };
  }
  if (r >= 0.7) {
    return { interpretation: 'strong', goNoGo: 'go' };
  } else if (r >= 0.5) {
    return { interpretation: 'moderate', goNoGo: 'go-with-caveat' };
  } else if (r >= 0) {
    return { interpretation: 'weak', goNoGo: 'no-go' };
  } else {
    return { interpretation: 'uncorrelated', goNoGo: 'no-go' };
  }
}

// ─── Main ────────────────────────────────────────────────────────────

interface CalibrationPair {
  pairId: string;
  modelA: string;
  modelB: string;
  pairType: 'transparent' | 'same-family' | 'cross-family';
  expectedRange: { architectureDistance: string; retrievalOverlapRisk: string };
  profile: CompatibilityProfile | null;
  error?: string;
}

async function main(): Promise<void> {
  console.error('=== ESP Calibration Pairs Benchmark ===');
  console.error(`Started at: ${new Date().toISOString()}`);

  // Build corpus
  const allChunks: string[] = [];
  for (const doc of DOCUMENTS) {
    allChunks.push(...chunkText(doc.text, 3));
  }
  console.error(`Corpus: ${DOCUMENTS.length} docs, ${allChunks.length} chunks, ${QUERIES.length} queries`);

  // Instantiate embedders
  const dgxEmbedder = new TimedEmbedder('http://100.78.161.126:8004/v1', 120_000);
  const localEmbedder = new TimedEmbedder('http://localhost:8006/v1', 120_000);

  // Pre-embed with each distinct model (cache for reuse across pairs)
  interface ModelCache {
    modelId: string;
    anchorVecs: number[][];
    chunkVecs: number[][];
    queryVecs: number[][];
  }

  const modelCache = new Map<string, ModelCache>();

  async function getOrEmbed(label: string, embedder: TimedEmbedder): Promise<ModelCache> {
    if (modelCache.has(label)) {
      console.error(`  [cache hit] ${label}`);
      return modelCache.get(label)!;
    }

    console.error(`\nEmbedding with ${label}...`);

    const modelId = await embedder.getModelId();
    console.error(`  model id: ${modelId}`);

    console.error(`  anchors (${ANCHOR_TEXTS.length})...`);
    const anchorVecs = await embedder.embed(ANCHOR_TEXTS);

    console.error(`  corpus chunks (${allChunks.length})...`);
    const chunkVecs = await embedder.embed(allChunks);

    console.error(`  queries (${QUERIES.length})...`);
    const queryVecs = await embedder.embed(QUERIES);

    console.error(`  Done (dims: ${anchorVecs[0].length})`);

    const cache: ModelCache = { modelId, anchorVecs, chunkVecs, queryVecs };
    modelCache.set(label, cache);
    return cache;
  }

  // Define calibration pairs
  const pairDefs: Array<{
    pairId: string;
    modelALabel: string;
    modelBLabel: string;
    modelAEmbedder: TimedEmbedder;
    modelBEmbedder: TimedEmbedder;
    pairType: CalibrationPair['pairType'];
    expectedRange: CalibrationPair['expectedRange'];
  }> = [
    {
      pairId: 'nemotron-self',
      modelALabel: 'nemotron-embed@dgx',
      modelBLabel: 'nemotron-embed@dgx',
      modelAEmbedder: dgxEmbedder,
      modelBEmbedder: dgxEmbedder,
      pairType: 'transparent',
      expectedRange: { architectureDistance: '~0', retrievalOverlapRisk: '~0' },
    },
    {
      pairId: 'minilm-self',
      modelALabel: 'all-MiniLM-L6-v2@local',
      modelBLabel: 'all-MiniLM-L6-v2@local',
      modelAEmbedder: localEmbedder,
      modelBEmbedder: localEmbedder,
      pairType: 'transparent',
      expectedRange: { architectureDistance: '~0', retrievalOverlapRisk: '~0' },
    },
    {
      pairId: 'nemotron-vs-minilm',
      modelALabel: 'nemotron-embed@dgx',
      modelBLabel: 'all-MiniLM-L6-v2@local',
      modelAEmbedder: dgxEmbedder,
      modelBEmbedder: localEmbedder,
      pairType: 'cross-family',
      expectedRange: { architectureDistance: '~0.138', retrievalOverlapRisk: '~0.31' },
    },
  ];

  const calibrationPairs: CalibrationPair[] = [];

  for (const def of pairDefs) {
    console.error(`\n--- Pair: ${def.pairId} (${def.pairType}) ---`);
    try {
      const dataA = await getOrEmbed(def.modelALabel, def.modelAEmbedder);
      const dataB = await getOrEmbed(def.modelBLabel, def.modelBEmbedder);

      // Compute ESVs
      console.error(`  Computing ESVs...`);
      const esvA = computeESV(dataA.anchorVecs, def.modelALabel);
      const esvB = computeESV(dataB.anchorVecs, def.modelBLabel);

      console.error(`  ESV A: ${esvA.compact}`);
      console.error(`  ESV B: ${esvB.compact}`);

      // Compute retrieval metrics
      console.error(`  Computing retrieval metrics...`);
      const retrievalMetrics = computeRetrievalMetrics(
        dataA.queryVecs, dataA.chunkVecs,
        dataB.queryVecs, dataB.chunkVecs,
        allChunks.length,
      );
      console.error(`  Jaccard@K3: ${retrievalMetrics.jaccardAtK3}, KendallTau@K10: ${retrievalMetrics.kendallTauAtK10}`);

      // Compute full CompatibilityProfile
      const profile = computeCompatibilityProfile(
        esvA,
        esvB,
        retrievalMetrics,
        { confidence: 'pilot', labeledPairs: pairDefs.length },
      );

      console.error(`  architectureDistance: ${profile.architectureDistance.toFixed(4)}`);
      console.error(`  retrievalOverlapRisk: ${profile.retrievalOverlapRisk?.toFixed(4)}`);
      console.error(`  rankingInstabilityRisk: ${profile.rankingInstabilityRisk.toFixed(4)}`);
      console.error(`  verdict: ${profile.operationalVerdict}`);

      calibrationPairs.push({
        pairId: def.pairId,
        modelA: def.modelALabel,
        modelB: def.modelBLabel,
        pairType: def.pairType,
        expectedRange: def.expectedRange,
        profile,
      });
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
      calibrationPairs.push({
        pairId: def.pairId,
        modelA: def.modelALabel,
        modelB: def.modelBLabel,
        pairType: def.pairType,
        expectedRange: def.expectedRange,
        profile: null,
        error: (err as Error).message,
      });
    }
  }

  // Compute Pearson r on pairs with both metrics
  const measuredPairs = calibrationPairs.filter(
    (p) => p.profile !== null && p.profile.retrievalOverlapRisk !== null,
  );

  const archDistances = measuredPairs.map((p) => p.profile!.architectureDistance);
  const overlapRisks = measuredPairs.map((p) => p.profile!.retrievalOverlapRisk as number);

  const r = pearsonR(archDistances, overlapRisks);
  const { interpretation, goNoGo } = interpretR(r, measuredPairs.length);

  console.error(`\n=== Pearson r Results ===`);
  console.error(`n pairs: ${measuredPairs.length}`);
  console.error(`r (architectureDistance vs retrievalOverlapRisk): ${isNaN(r) ? 'NaN' : r.toFixed(4)}`);
  console.error(`interpretation: ${interpretation}`);
  console.error(`go/no-go: ${goNoGo}`);

  const result = {
    runAt: new Date().toISOString(),
    calibrationPairs,
    pearsonR: {
      architectureDistance_vs_retrievalOverlapRisk: isNaN(r) ? null : Math.round(r * 1e4) / 1e4,
      n: measuredPairs.length,
      interpretation,
      goNoGo,
    },
    summary: {
      calibrationConfidence: measuredPairs.length >= 3 ? 'pilot' : 'uncalibrated',
      verdict: goNoGo === 'go'
        ? `Geometric architecture distance is a strong predictor of retrieval compatibility (r=${r.toFixed(3)}). The ESP geometric approach is validated as a decision gate.`
        : goNoGo === 'go-with-caveat'
        ? `Geometric architecture distance shows moderate correlation with retrieval risk (r=${r.toFixed(3)}). ESP geometric approach may be used with caution; more pairs recommended.`
        : goNoGo === 'no-go'
        ? `Geometric architecture distance does not predict retrieval compatibility (r=${isNaN(r) ? 'NaN' : r.toFixed(3)}). Abandon geometric approach as decision gate; rely on direct retrieval measurement.`
        : `Insufficient labeled pairs (n=${measuredPairs.length}) to determine correlation. More pairs required.`,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
