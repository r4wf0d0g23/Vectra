/**
 * ESP Experiment 1: Cross-Model ESV Comparison
 *
 * Tests whether ESV fingerprints correlate with actual retrieval quality
 * across different embedding models — validating or falsifying the core ESP mechanism.
 *
 * @see docs/esp-research-roadmap.md §A Rank 1
 */

import { ANCHOR_TEXTS } from '../embedding/anchor-set.js';
import { computeESV, compareESV, cosineDistance } from '../embedding/esv.js';
import { computeCompatibilityProfile, type CompatibilityProfile } from '../embedding/compatibility.js';
import { Embedder } from '../embedding/embedder.js';

// ─── OpenAI Embedder ────────────────────────────────────────────────

class OpenAIEmbedder {
  constructor(private apiKey: string, private model: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    // OpenAI has a max of 2048 texts per request; batch if needed
    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`OpenAI embed failed: ${resp.status} — ${body}`);
      }

      const data = (await resp.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      const sorted = data.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));
    }

    return allEmbeddings;
  }
}

// ─── Test Corpus (inline constants) ─────────────────────────────────

const DOCUMENTS: { title: string; text: string }[] = [
  // Machine Learning
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
  // Ancient Rome
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
    title: 'Roman Architecture and Engineering',
    text: `Roman architecture and engineering represent some of antiquity's greatest technical achievements. The Romans developed and perfected the use of the arch, vault, and dome, enabling the construction of large interior spaces that the post-and-lintel architecture of the Greeks could not achieve. The Pantheon in Rome, built under Emperor Hadrian, features a remarkable unreinforced concrete dome 43 meters in diameter that remained the world's largest dome for over a millennium. Roman concrete, opus caementicium, was a revolutionary material that gained strength underwater, enabling the construction of harbor facilities. The Roman road network extended over 400,000 kilometers at its peak, built to precise engineering standards that made them durable enough for fragments to survive to the present day. The aqueduct system brought fresh water from distant mountain sources to cities through gravity-fed channels spanning hundreds of kilometers, supporting urban populations of hundreds of thousands.`,
  },
  // Climate Change
  {
    title: 'Climate Change: Causes and Mechanisms',
    text: `Climate change refers to long-term shifts in global temperatures and weather patterns. While climate has varied naturally throughout Earth's history, scientific evidence strongly indicates that human activities have been the main driver of climate change since the mid-20th century. The primary mechanism is the enhanced greenhouse effect: gases such as carbon dioxide, methane, and nitrous oxide trap heat from the sun that would otherwise escape into space. Carbon dioxide concentrations in the atmosphere have risen from approximately 280 parts per million before industrialization to over 420 parts per million today, primarily from burning fossil fuels such as coal, oil, and natural gas. Deforestation contributes both by releasing stored carbon and by reducing the forest's capacity to absorb atmospheric carbon dioxide through photosynthesis. Methane emissions from livestock, rice cultivation, and natural gas leakage also contribute significantly to warming, as methane is a far more potent greenhouse gas than carbon dioxide over short timescales.`,
  },
  {
    title: 'Climate Change Impacts and Adaptation',
    text: `The impacts of climate change are already being observed across the globe, with effects on ecosystems, human societies, and physical systems. Global average surface temperature has risen approximately 1.1 degrees Celsius above pre-industrial levels, and this warming is driving changes in precipitation patterns, sea levels, and the frequency and intensity of extreme weather events. Sea level rise, caused by thermal expansion of warming ocean water and melting of ice sheets and glaciers, threatens low-lying coastal communities and small island nations. Coral reefs, among the most biodiverse marine ecosystems, are experiencing mass bleaching events as water temperatures exceed their tolerance limits. Changes in precipitation and temperature affect agricultural productivity, water availability, and the distribution of plant and animal species. Adaptation strategies range from building sea walls and improving drought-resistant crops to redesigning urban areas to reduce heat island effects and flooding risks.`,
  },
  {
    title: 'Climate Policy and the Paris Agreement',
    text: `International climate policy has evolved significantly since the first major global agreement, the Kyoto Protocol, which was adopted in 1997. The landmark Paris Agreement of 2015 brought together nearly all nations in a commitment to limit global warming to well below 2 degrees Celsius above pre-industrial levels, with efforts to limit warming to 1.5 degrees Celsius. Unlike Kyoto, which imposed binding emissions reduction targets only on developed countries, Paris operates through nationally determined contributions, allowing each country to set its own targets and ambitions. The agreement includes mechanisms for transparency and review, with countries required to report on their progress and update their commitments over time. Scientific assessments by the Intergovernmental Panel on Climate Change, or IPCC, provide the evidence base for international negotiations and national climate policies. The transition to renewable energy sources such as solar and wind power has accelerated dramatically in recent years as costs have fallen and government support has grown.`,
  },
  {
    title: 'Renewable Energy Transition',
    text: `The global transition to renewable energy is accelerating as the costs of solar photovoltaic and wind power have fallen dramatically over the past decade. Solar energy costs have declined by more than 90 percent since 2010, making it the cheapest source of electricity generation in history in many markets. Wind power has experienced similar cost reductions, particularly offshore wind, which benefits from stronger and more consistent winds. Battery storage technology, critical for managing the intermittency of solar and wind generation, has also fallen in cost substantially, driven partly by the electric vehicle industry. Countries and regions with high renewable energy penetration, such as Denmark, Germany, and parts of the United States, have demonstrated that electrical grids can operate reliably with a large share of variable renewable generation. The energy transition also involves electrification of transportation, heating, and industrial processes, all of which require expanding the electricity system while reducing its carbon intensity.`,
  },
  // Quantum Computing
  {
    title: 'Quantum Computing Fundamentals',
    text: `Quantum computing harnesses the principles of quantum mechanics to perform computations that would be impractical or impossible for classical computers. While classical computers encode information in bits that are either zero or one, quantum computers use quantum bits, or qubits, which can exist in a superposition of both states simultaneously. This superposition, combined with the quantum phenomenon of entanglement, allows quantum computers to explore many possible solutions to a problem simultaneously. Quantum interference is used to amplify the probability of correct answers and cancel out wrong ones, enabling algorithms that solve certain problems exponentially faster than classical algorithms. The most famous quantum algorithms include Shor's algorithm for factoring large numbers, which threatens current encryption schemes, and Grover's algorithm, which provides a quadratic speedup for searching unsorted databases. Building practical quantum computers is extraordinarily challenging, as qubits are extremely fragile and any interaction with the environment causes decoherence, destroying quantum information.`,
  },
  {
    title: 'Quantum Hardware Approaches',
    text: `Several competing physical implementations are being pursued to build practical quantum computers. Superconducting qubits, used by companies such as IBM, Google, and Rigetti, are tiny circuits cooled to temperatures near absolute zero. They can be fabricated using existing semiconductor manufacturing techniques, allowing relatively rapid scaling, but require sophisticated cryogenic infrastructure. Trapped ion quantum computers, developed by IonQ and Honeywell, manipulate individual charged atoms using laser pulses. They tend to have higher qubit fidelity than superconducting systems but are more complex to scale. Photonic quantum computing encodes qubits in photons, the particles of light, and can operate at room temperature but presents challenges in creating interactions between photons. Topological qubits, pursued by Microsoft, would theoretically be more resistant to decoherence if realized, but remain unproven at scale. Quantum error correction, which uses redundant qubits to protect against decoherence, is widely considered necessary for practical fault-tolerant quantum computation.`,
  },
  {
    title: 'Quantum Computing Applications',
    text: `The most promising near-term applications of quantum computing are expected to be in simulation of quantum systems, optimization, and machine learning enhancement. Quantum chemistry simulation allows modeling of molecular and electronic structure with high precision, potentially accelerating drug discovery and materials science research. A quantum computer could simulate the behavior of complex molecules like FeMoco, the active site of nitrogenase, which fixes nitrogen from the air, potentially enabling more efficient fertilizer production. Quantum optimization algorithms may improve solutions to logistics, financial portfolio optimization, and supply chain management problems. Quantum machine learning algorithms promise speedups in training and inference, though the practical advantage over classical methods remains an active research area. In cryptography, quantum computers running Shor's algorithm could break widely used public-key encryption schemes such as RSA and elliptic curve cryptography, driving development of post-quantum cryptographic standards.`,
  },
  {
    title: 'Quantum Supremacy and Current State',
    text: `In 2019, Google announced that its Sycamore quantum processor had achieved quantum supremacy, completing a specific sampling computation in 200 seconds that it claimed would take the world's most powerful classical supercomputer 10,000 years. IBM disputed this claim, arguing the task could be performed classically in a few days. The demonstration highlighted both the rapid progress in quantum hardware and the difficulty of establishing clear practical advantages. By 2023, quantum computers with hundreds of noisy physical qubits were commercially available through cloud services, but none had demonstrated unambiguous quantum advantage on practically relevant problems. Quantum volume, a metric developed by IBM to measure the overall capability of a quantum computer accounting for qubit number, connectivity, and gate fidelity, has roughly doubled each year since its introduction. The consensus in the research community is that useful, fault-tolerant quantum computation likely requires thousands to millions of physical qubits implementing quantum error correction, a threshold not yet achieved.`,
  },
  // Cooking Techniques
  {
    title: 'The Maillard Reaction and Caramelization',
    text: `The Maillard reaction is a chemical process between amino acids and reducing sugars that gives browned food its distinctive flavor. Named after French chemist Louis-Camille Maillard who first described it in 1912, the reaction occurs when proteins and sugars are heated together, typically above 140 to 165 degrees Celsius. It is responsible for the complex flavors and brown colors of seared meat, toasted bread, roasted coffee, and baked goods. Unlike caramelization, which involves only the breakdown of sugars, the Maillard reaction requires both proteins and sugars and produces hundreds of different flavor compounds. For optimal browning, the food surface must be dry, since water evaporation absorbs heat and keeps the surface temperature from reaching the threshold needed for the reaction. Professional cooks use this understanding to pat meat dry before searing, preheat pans until very hot, and avoid overcrowding which would cause the pan temperature to drop.`,
  },
  {
    title: 'Emulsification and Sauce Making',
    text: `Emulsification is the process of combining two immiscible liquids, typically oil and water, into a stable mixture called an emulsion. In cooking, emulsifiers such as lecithin in egg yolks and proteins in mustard serve as intermediaries between oil and water molecules, coating oil droplets and preventing them from coalescing. Classic emulsified sauces include mayonnaise, hollandaise, and béarnaise. Mayonnaise is a cold emulsion made by slowly whisking oil into egg yolks, while hollandaise is a warm emulsion combining egg yolks with clarified butter over gentle heat. The stability of an emulsion depends on the proportion of oil to water, the type and amount of emulsifier, and the emulsification technique. Too much oil added too quickly can overwhelm the emulsifier and cause the sauce to break, or separate. A broken emulsion can often be rescued by starting fresh with a new emulsifier and slowly whisking the broken sauce into it to re-emulsify the mixture.`,
  },
  {
    title: 'Fermentation and Preservation',
    text: `Fermentation is one of humanity's oldest food preservation techniques, used for thousands of years to extend the shelf life of perishable foods and develop complex flavors. Microorganisms including bacteria, yeasts, and molds convert sugars and starches into acids, alcohols, and gases through anaerobic metabolic processes. Lactic acid fermentation, carried out by lactobacillus bacteria, preserves vegetables in sauerkraut and kimchi and sours dairy products in yogurt and aged cheeses. Alcoholic fermentation by yeasts converts sugars to ethanol and carbon dioxide, forming the basis of wine, beer, and spirits production. Acetic acid bacteria convert ethanol to acetic acid, producing vinegar. Beyond preservation, fermentation develops characteristic flavors: the tang of sourdough bread, the funkiness of aged cheese, and the complexity of fermented hot sauces. Koji mold plays a central role in Japanese fermented foods, including sake, miso, and soy sauce, producing enzymes that break down proteins and starches into savory amino acids and simple sugars.`,
  },
  {
    title: 'Knife Skills and Mise en Place',
    text: `Mise en place, French for "everything in its place," is a fundamental concept in professional cooking that emphasizes preparation and organization before cooking begins. It involves gathering, measuring, and preparing all ingredients before starting to cook, so that the actual cooking process proceeds smoothly without interruption. Proper knife skills are central to efficient mise en place. The French knife technique uses a rocking motion with the tip of the knife remaining in contact with the cutting board, suitable for mincing herbs and garlic. The push cut moves the knife forward through the food, good for precise slices of firm vegetables. The pull cut drags the knife backward, used with long blades for slicing proteins. A sharp knife is both safer and more efficient than a dull one, as it requires less force and is less likely to slip. Fundamental cuts include julienne thin matchstick strips, brunoise tiny cubes from julienned vegetables, chiffonade ribbons of leafy herbs, and tourné seven-sided football shapes for root vegetables.`,
  },
  {
    title: 'Heat Transfer Methods in Cooking',
    text: `Cooking involves transferring heat to food through three fundamental mechanisms: conduction, convection, and radiation. Conduction is the direct transfer of heat through contact between objects, as when a pan heats food placed on its surface. The thermal conductivity of cookware materials matters greatly: copper and aluminum are excellent conductors providing even heating, while cast iron heats slowly but retains heat well. Convection involves heat transfer through the movement of fluids, including both liquids and gases. In wet cooking methods like boiling and braising, hot water or stock circulates around the food transferring heat. In convection ovens, a fan circulates hot air, cooking food more quickly and evenly than conventional ovens. Radiation transfers heat through electromagnetic waves without requiring a medium, as in broiling under a flame or grilling over charcoal, where infrared radiation directly heats the food surface. Sous vide cooking uses precise temperature control in a water bath to cook food to exact internal temperatures impossible to achieve reliably with conventional methods.`,
  },
];

// ─── Query Set (30 inline constants) ────────────────────────────────

const QUERIES: string[] = [
  // Machine learning queries
  'What is machine learning and how does it differ from traditional programming?',
  'How does backpropagation work in training neural networks?',
  'What is the transformer architecture and what makes it different from RNNs?',
  'How do embedding models enable semantic search?',
  'What is gradient descent and why is it used in machine learning?',
  'What is overfitting and how can regularization help prevent it?',
  // Ancient Rome queries
  'What was the Roman Republic and how was it governed?',
  'What role did Julius Caesar play in the fall of the Roman Republic?',
  'How large was the Roman Empire at its greatest extent?',
  'What were the major engineering achievements of ancient Rome?',
  'Who were the patricians and plebeians in Roman society?',
  'What was the Pax Romana?',
  // Climate change queries
  'What are the main causes of climate change?',
  'How does the greenhouse effect contribute to global warming?',
  'What is the Paris Agreement on climate change?',
  'How have solar energy costs changed in recent years?',
  'What are the impacts of climate change on ecosystems?',
  'What is the role of renewable energy in reducing emissions?',
  // Quantum computing queries
  'What is a qubit and how is it different from a classical bit?',
  'What physical implementations are being used to build quantum computers?',
  'What is quantum supremacy and has it been achieved?',
  'What applications might benefit most from quantum computers?',
  'What is quantum error correction and why is it needed?',
  'What is Shor\'s algorithm and why does it matter for cryptography?',
  // Cooking queries
  'What is the Maillard reaction and why does it matter for cooking?',
  'How does emulsification work in sauce making?',
  'What is fermentation and how is it used in food preservation?',
  'What does mise en place mean in professional cooking?',
  'What are the three main heat transfer methods in cooking?',
  'What is sous vide cooking and what advantages does it offer?',
];

// ─── Text Chunking ───────────────────────────────────────────────────

function chunkText(text: string, maxSentences: number = 3): string[] {
  // Split by sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks: string[] = [];

  for (let i = 0; i < sentences.length; i += maxSentences) {
    const chunk = sentences.slice(i, i + maxSentences).join(' ').trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

// ─── Retrieval Utilities ─────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getTopK(queryVec: number[], chunkVecs: number[][], k: number): number[] {
  const scored = chunkVecs.map((c, i) => ({ i, sim: cosineSimilarity(queryVec, c) }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map((s) => s.i);
}

// ─── Frobenius Distance ──────────────────────────────────────────────

function frobeniusDistance(a: number[][], b: number[][]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i].length; j++) {
      const diff = a[i][j] - b[i][j];
      sum += diff * diff;
    }
  }
  return Math.sqrt(sum);
}

// ─── Kendall's τ ────────────────────────────────────────────────────

function kendallTau(rankA: number[], rankB: number[]): number {
  // Build position maps
  const posB = new Map<number, number>();
  rankB.forEach((item, idx) => posB.set(item, idx));

  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < rankA.length; i++) {
    for (let j = i + 1; j < rankA.length; j++) {
      const posI = posB.get(rankA[i]);
      const posJ = posB.get(rankA[j]);
      if (posI === undefined || posJ === undefined) continue;
      // i comes before j in rankA (by construction); check if same in rankB
      if (posI < posJ) concordant++;
      else discordant++;
    }
  }

  const total = concordant + discordant;
  return total > 0 ? (concordant - discordant) / total : 0;
}

// ─── Jaccard Similarity ──────────────────────────────────────────────

function jaccardSimilarity(setA: number[], setB: number[]): number {
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Main Experiment ─────────────────────────────────────────────────

interface ModelInfo {
  name: string;
  embedder: { embed(texts: string[]): Promise<number[][]> };
  dimensions: number;
}

async function main(): Promise<void> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error('ERROR: OPENAI_API_KEY not set — halting');
    process.exit(1);
  }

  const skipDGX = process.env.SKIP_DGX === '1';

  // ── Step A: Build corpus ───────────────────────────────────────
  console.error('Building corpus...');
  const allChunks: string[] = [];
  const chunkDocIndex: number[] = []; // which document each chunk belongs to

  for (let docIdx = 0; docIdx < DOCUMENTS.length; docIdx++) {
    const chunks = chunkText(DOCUMENTS[docIdx].text, 3);
    for (const chunk of chunks) {
      allChunks.push(chunk);
      chunkDocIndex.push(docIdx);
    }
  }
  console.error(`Corpus: ${DOCUMENTS.length} documents, ${allChunks.length} chunks, ${QUERIES.length} queries`);

  // ── Step B: Configure models ────────────────────────────────────
  const models: ModelInfo[] = [];

  if (!skipDGX) {
    try {
      console.error('Checking DGX nemotron-embed...');
      const dgxEmbedder = new Embedder('http://100.78.161.126:8004/v1');
      const modelId = await dgxEmbedder.getModelId();
      console.error(`DGX model: ${modelId}`);

      // Quick test
      const testEmbed = await dgxEmbedder.embed(['test']);
      models.push({
        name: 'nemotron-embed@dgx',
        embedder: dgxEmbedder,
        dimensions: testEmbed[0].length,
      });
      console.error(`DGX nemotron-embed ready (dims: ${testEmbed[0].length})`);
    } catch (e) {
      console.error(`DGX unreachable: ${(e as Error).message} — skipping`);
    }
  } else {
    console.error('SKIP_DGX=1 — skipping DGX model');
  }

  // Local all-MiniLM-L6-v2 via xenova/transformers ONNX server on port 8006
  try {
    console.error('Checking local all-MiniLM-L6-v2 server...');
    const localEmbedder = new Embedder('http://localhost:8006/v1');
    const testEmbed = await localEmbedder.embed(['test']);
    models.push({
      name: 'all-MiniLM-L6-v2@local',
      embedder: localEmbedder,
      dimensions: testEmbed[0].length,
    });
    console.error(`Local all-MiniLM-L6-v2 ready (dims: ${testEmbed[0].length})`);
  } catch (e) {
    console.error(`Local embed server unreachable: ${(e as Error).message} — skipping`);
  }

  // OpenAI models (if accessible)
  for (const oaiModel of ['text-embedding-3-small', 'text-embedding-3-large']) {
    try {
      console.error(`Configuring OpenAI ${oaiModel}...`);
      const oaiEmbedder = new OpenAIEmbedder(openaiKey, oaiModel);
      // Discover dimensions via single test embed
      const testEmbed = await oaiEmbedder.embed(['test']);
      models.push({
        name: oaiModel,
        embedder: oaiEmbedder,
        dimensions: testEmbed[0].length,
      });
      console.error(`OpenAI ${oaiModel} ready (dims: ${testEmbed[0].length})`);
    } catch (e) {
      console.error(`OpenAI ${oaiModel} unavailable: ${(e as Error).message} — skipping`);
    }
  }

  if (models.length < 2) {
    console.error('ERROR: Need at least 2 models — halting');
    process.exit(1);
  }

  // ── Step C: Embed anchors, corpus, queries for each model ───────
  interface ModelData {
    name: string;
    anchorVecs: number[][];
    chunkVecs: number[][];
    queryVecs: number[][];
  }

  const modelData: ModelData[] = [];

  for (const model of models) {
    console.error(`\nEmbedding with ${model.name}...`);

    console.error(`  - anchors (${ANCHOR_TEXTS.length})...`);
    const anchorVecs = await model.embedder.embed(ANCHOR_TEXTS);

    console.error(`  - corpus chunks (${allChunks.length})...`);
    const chunkVecs = await model.embedder.embed(allChunks);

    console.error(`  - queries (${QUERIES.length})...`);
    const queryVecs = await model.embedder.embed(QUERIES);

    modelData.push({ name: model.name, anchorVecs, chunkVecs, queryVecs });
    console.error(`  Done.`);
  }

  // ── Step D: Compute ESVs ─────────────────────────────────────────
  console.error('\nComputing ESVs...');
  const esvMap = new Map<string, ReturnType<typeof computeESV>>();
  for (const data of modelData) {
    const esv = computeESV(data.anchorVecs, data.name);
    esvMap.set(data.name, esv);
    console.error(`  ${data.name}: ${esv.compact}`);
  }

  // ── Step E: Pairwise comparisons ─────────────────────────────────
  console.error('\nComputing pairwise comparisons...');

  const K_VALUES = [1, 3, 5];
  const K_TAU = 10;

  interface PairwiseResult {
    modelA: string;
    modelB: string;
    frobeniusDistance: number;
    espVerdict: string;
    espPredictedIncompatible: boolean;
    retrievalOverlapAtK1: number;
    retrievalOverlapAtK3: number;
    retrievalOverlapAtK5: number;
    kendallTauAtK10: number;
    actualQualityDivergent: boolean;
    espCorrect: boolean;
    compatibilityProfile: CompatibilityProfile;
  }

  const pairwiseComparisons: PairwiseResult[] = [];

  for (let i = 0; i < modelData.length; i++) {
    for (let j = i + 1; j < modelData.length; j++) {
      const a = modelData[i];
      const b = modelData[j];
      const esvA = esvMap.get(a.name)!;
      const esvB = esvMap.get(b.name)!;

      console.error(`  ${a.name} vs ${b.name}...`);

      // ESV comparison
      const comparison = compareESV(esvA, esvB);
      const frob = frobeniusDistance(esvA.fingerprint, esvB.fingerprint);

      // Per-query retrieval rankings
      const overlapsK: Record<number, number[]> = {};
      for (const k of K_VALUES) {
        overlapsK[k] = [];
      }
      const taus: number[] = [];

      for (let qi = 0; qi < QUERIES.length; qi++) {
        const topKA_10 = getTopK(a.queryVecs[qi], a.chunkVecs, K_TAU);
        const topKB_10 = getTopK(b.queryVecs[qi], b.chunkVecs, K_TAU);

        for (const k of K_VALUES) {
          const topKA = topKA_10.slice(0, k);
          const topKB = topKB_10.slice(0, k);
          overlapsK[k].push(jaccardSimilarity(topKA, topKB));
        }

        taus.push(kendallTau(topKA_10, topKB_10));
      }

      const meanOverlap: Record<number, number> = {};
      for (const k of K_VALUES) {
        meanOverlap[k] = overlapsK[k].reduce((s, v) => s + v, 0) / overlapsK[k].length;
      }
      const meanTau = taus.reduce((s, v) => s + v, 0) / taus.length;

      // Divergence determination:
      // "Divergent" if mean Jaccard at K=3 < 0.5 (models retrieve substantially different chunks)
      const DIVERGENCE_THRESHOLD = 0.5;
      const actualQualityDivergent = meanOverlap[3] < DIVERGENCE_THRESHOLD;
      const espPredictedIncompatible = comparison.recommendation === 'incompatible';
      const espCorrect = espPredictedIncompatible === actualQualityDivergent;

      // Compute layered CompatibilityProfile
      const compatibilityProfile = computeCompatibilityProfile(
        esvA,
        esvB,
        {
          jaccardAtK3: Math.round(meanOverlap[3] * 1e4) / 1e4,
          kendallTauAtK10: Math.round(meanTau * 1e4) / 1e4,
          queriesEvaluated: QUERIES.length,
          corpusChunks: allChunks.length,
        },
      );

      pairwiseComparisons.push({
        modelA: a.name,
        modelB: b.name,
        frobeniusDistance: Math.round(frob * 1e6) / 1e6,
        espVerdict: comparison.recommendation,
        espPredictedIncompatible,
        retrievalOverlapAtK1: Math.round(meanOverlap[1] * 1e4) / 1e4,
        retrievalOverlapAtK3: Math.round(meanOverlap[3] * 1e4) / 1e4,
        retrievalOverlapAtK5: Math.round(meanOverlap[5] * 1e4) / 1e4,
        kendallTauAtK10: Math.round(meanTau * 1e4) / 1e4,
        actualQualityDivergent,
        espCorrect,
        compatibilityProfile,
      });
    }
  }

  // ── Step F: Build summary ─────────────────────────────────────────
  const correctPairs = pairwiseComparisons.filter((p) => p.espCorrect).length;
  const totalPairs = pairwiseComparisons.length;

  const esvOutput: Record<string, object> = {};
  for (const [name, esv] of esvMap.entries()) {
    esvOutput[name] = {
      version: esv.version,
      dimensions: esv.dimensions,
      compact: esv.compact,
      meanDistance: esv.meanDistance,
      stdDistance: esv.stdDistance,
      anchorCount: esv.anchorCount,
      computedAt: esv.computedAt,
    };
  }

  // Determine overall conclusion
  const allDivergent = pairwiseComparisons.every((p) => p.actualQualityDivergent);
  const allIncompatible = pairwiseComparisons.every((p) => p.espPredictedIncompatible);
  let conclusion: string;

  if (correctPairs === totalPairs) {
    conclusion = 'ESP verdicts perfectly matched retrieval divergence across all model pairs. The core ESP mechanism is validated for these models.';
  } else if (correctPairs > totalPairs / 2) {
    conclusion = `ESP verdicts partially correlated with retrieval divergence (${correctPairs}/${totalPairs} pairs). Mechanism shows promise but thresholds may need calibration.`;
  } else if (allIncompatible) {
    conclusion = 'ESP classified all pairs as incompatible (trivially true for different architectures). The protocol may need threshold recalibration to distinguish degrees of incompatibility.';
  } else {
    conclusion = `ESP verdicts poorly correlated with retrieval divergence (${correctPairs}/${totalPairs} pairs). Core mechanism may need redesign.`;
  }

  const result = {
    runAt: new Date().toISOString(),
    models: models.map((m) => m.name),
    corpusStats: {
      documents: DOCUMENTS.length,
      chunks: allChunks.length,
      queries: QUERIES.length,
    },
    esvs: esvOutput,
    pairwiseComparisons,
    summary: {
      espAccuracy: `${correctPairs}/${totalPairs} pairs where ESP verdict matched retrieval divergence`,
      totalPairs,
      correctPairs,
      divergenceThreshold: 'Jaccard@K3 < 0.5',
      conclusion,
    },
  };

  // Output JSON to stdout
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
