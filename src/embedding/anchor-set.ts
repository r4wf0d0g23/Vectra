/**
 * Vectra Embedding Stability Protocol — Canonical Anchor Set v1
 *
 * 27 stability anchors spanning 5 semantic domains relevant to agentic
 * operations. These form the fixed reference points for computing
 * Embedding Space Versions (ESV) and detecting embedding drift.
 *
 * Once published as esp-anchor-v1, this set is FROZEN.
 * Any modification produces esp-anchor-v2.
 *
 * @see docs/embedding-stability-protocol.md §7
 */

export const ANCHOR_SET_VERSION = 'esp-anchor-v1';

/** Semantic domain tags for each anchor. */
export type AnchorDomain =
  | 'task-routing'
  | 'memory-context'
  | 'identity-role'
  | 'tool-use'
  | 'system-state';

export interface AnchorEntry {
  id: string;
  text: string;
  domain: AnchorDomain;
  semanticTarget: string;
}

/**
 * The 27 canonical stability anchors from ESP spec §7.
 * Order is significant — indices are used in pairwise distance matrices.
 */
export const VECTRA_ANCHOR_SET: AnchorEntry[] = [
  // ── Task Routing Domain (7) ───────────────────────────────────
  {
    id: 'TR-01',
    text: 'Route this task to the appropriate handler based on its priority and type',
    domain: 'task-routing',
    semanticTarget: 'Task dispatch / orchestration',
  },
  {
    id: 'TR-02',
    text: 'This task requires human approval before execution can proceed',
    domain: 'task-routing',
    semanticTarget: 'Approval gating',
  },
  {
    id: 'TR-03',
    text: 'Schedule this operation to run at a specific future time',
    domain: 'task-routing',
    semanticTarget: 'Temporal scheduling',
  },
  {
    id: 'TR-04',
    text: 'Escalate this issue to a higher authority because automated resolution failed',
    domain: 'task-routing',
    semanticTarget: 'Escalation pathway',
  },
  {
    id: 'TR-05',
    text: 'Execute this shell command on the local operating system',
    domain: 'task-routing',
    semanticTarget: 'System command execution',
  },
  {
    id: 'TR-06',
    text: 'Send a message to another agent in the multi-agent network',
    domain: 'task-routing',
    semanticTarget: 'Inter-agent communication',
  },
  {
    id: 'TR-07',
    text: 'Retrieve relevant information from long-term persistent storage',
    domain: 'task-routing',
    semanticTarget: 'Memory retrieval query',
  },

  // ── Memory and Context Domain (7) ─────────────────────────────
  {
    id: 'MC-01',
    text: 'Store this information for future retrieval across sessions',
    domain: 'memory-context',
    semanticTarget: 'Persistent memory write',
  },
  {
    id: 'MC-02',
    text: 'What happened in the previous conversation about this topic',
    domain: 'memory-context',
    semanticTarget: 'Conversational history recall',
  },
  {
    id: 'MC-03',
    text: "The user's stated preference is to receive brief summaries",
    domain: 'memory-context',
    semanticTarget: 'User preference encoding',
  },
  {
    id: 'MC-04',
    text: 'This fact was last verified on a specific calendar date',
    domain: 'memory-context',
    semanticTarget: 'Temporal fact staleness',
  },
  {
    id: 'MC-05',
    text: 'Combine information from multiple sources into a single context',
    domain: 'memory-context',
    semanticTarget: 'Context composition / fusion',
  },
  {
    id: 'MC-06',
    text: 'Remove outdated information that is no longer accurate',
    domain: 'memory-context',
    semanticTarget: 'Memory garbage collection',
  },
  {
    id: 'MC-07',
    text: 'This context belongs to a specific named project or workspace',
    domain: 'memory-context',
    semanticTarget: 'Namespace / project scoping',
  },

  // ── Identity and Role Domain (5) ──────────────────────────────
  {
    id: 'IR-01',
    text: 'I am an autonomous agent operating under defined behavioral constraints',
    domain: 'identity-role',
    semanticTarget: 'Agent self-identity',
  },
  {
    id: 'IR-02',
    text: 'The operator has administrative privileges over this system',
    domain: 'identity-role',
    semanticTarget: 'Authority / permission level',
  },
  {
    id: 'IR-03',
    text: 'This action is prohibited by the safety policy',
    domain: 'identity-role',
    semanticTarget: 'Safety constraint / guardrail',
  },
  {
    id: 'IR-04',
    text: 'Switch to a different operational persona or behavioral mode',
    domain: 'identity-role',
    semanticTarget: 'Persona / mode switching',
  },
  {
    id: 'IR-05',
    text: 'Verify the identity and authorization of the requesting entity',
    domain: 'identity-role',
    semanticTarget: 'Authentication / authorization',
  },

  // ── Tool Use Domain (4) ───────────────────────────────────────
  {
    id: 'TU-01',
    text: 'Read the contents of a file from the local filesystem',
    domain: 'tool-use',
    semanticTarget: 'File I/O operation',
  },
  {
    id: 'TU-02',
    text: 'Search the internet for current information about this topic',
    domain: 'tool-use',
    semanticTarget: 'Web search / retrieval',
  },
  {
    id: 'TU-03',
    text: 'Generate an image based on this textual description',
    domain: 'tool-use',
    semanticTarget: 'Media generation',
  },
  {
    id: 'TU-04',
    text: 'Parse and extract structured data from this unstructured text',
    domain: 'tool-use',
    semanticTarget: 'Data extraction / parsing',
  },

  // ── System State Domain (4) ───────────────────────────────────
  {
    id: 'SS-01',
    text: 'The system is operating normally with no errors detected',
    domain: 'system-state',
    semanticTarget: 'Healthy state / nominal',
  },
  {
    id: 'SS-02',
    text: 'A critical error has occurred and immediate intervention is required',
    domain: 'system-state',
    semanticTarget: 'Error / failure state',
  },
  {
    id: 'SS-03',
    text: 'System resource utilization is approaching maximum capacity',
    domain: 'system-state',
    semanticTarget: 'Resource pressure / limits',
  },
  {
    id: 'SS-04',
    text: 'The configuration has been modified and requires validation',
    domain: 'system-state',
    semanticTarget: 'Config change detection',
  },
];

/** Plain text array for embedding — preserves index alignment with VECTRA_ANCHOR_SET. */
export const ANCHOR_TEXTS: string[] = VECTRA_ANCHOR_SET.map((a) => a.text);
