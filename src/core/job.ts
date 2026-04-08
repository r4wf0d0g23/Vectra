/**
 * Vectra Job Envelope — the fundamental unit of work in the harness.
 *
 * Every task that enters Vectra becomes a Job. The job envelope carries
 * all metadata needed for dispatch, execution, verification, and audit.
 * The harness owns the envelope; the model never modifies it directly.
 */

// ─── Source Identity ────────────────────────────────────────────────

/** Where a job originated. Determines trust level at intake. */
export type JobSource = 'human' | 'cron' | 'subagent-completion' | 'webhook';

/** Trust level derived from source. Higher = more permissive admission. */
export type TrustLevel = 'highest' | 'high' | 'medium' | 'lowest';

export const SOURCE_TRUST: Record<JobSource, TrustLevel> = {
  human: 'highest',
  cron: 'high',
  'subagent-completion': 'medium',
  webhook: 'lowest',
} as const;

// ─── Task Classification ────────────────────────────────────────────

/**
 * Task family identifier — generic string at the harness level.
 * Valid task classes are defined by the instance's ATP routing configuration,
 * not by the harness. Examples: 'orchestration', 'config-ops', 'conversational'.
 */
export type TaskClass = string;

/**
 * ATP protocol identifier — generic string at the harness level.
 * Valid protocol IDs are loaded at runtime from the instance's ATP directory.
 * Examples: 'orchestration-main', 'conversational'.
 */
export type ProtocolId = string;

// ─── Model Classification ───────────────────────────────────────────

/**
 * Model tier identifier — generic string at the harness level.
 * Instances map tier names to concrete provider/model strings in instance config.
 * Built-in defaults: 'fast', 'agent', 'balanced', 'capable'.
 */
export type ModelClass = string;

/**
 * Default tier ordering for built-in model classes.
 * Operators may extend this via instance config for custom tier names.
 * Higher number = more capable / more expensive.
 */
export const MODEL_CLASS_ORDER: Record<string, number> = {
  fast: 0,
  agent: 1,
  balanced: 2,
  capable: 3,
};

// ─── Tool Scope ─────────────────────────────────────────────────────

/**
 * Tool name — generic string at the harness level.
 * The valid tool set is determined by the runtime and the instance's ATP
 * tool_allowlist fields, not by a compiled-in union.
 * Examples: 'read', 'write', 'exec', 'memory_search', 'sessions_spawn'.
 */
export type ToolName = string;

/** Impact classification for tools. */
export type ToolImpact = 'read-only' | 'write-capable' | 'destructive' | 'privileged';

// ─── Approval Policy ────────────────────────────────────────────────

/** How a job's actions are approved. */
export type ApprovalPolicy =
  | 'auto'           // Within protocol scope, no gate
  | 'require-t3'     // T3 must validate before execution proceeds
  | 'require-human'  // Human must explicitly approve
  | 'never';         // Action is categorically forbidden

// ─── Verification Policy ────────────────────────────────────────────

/** How job completion is verified. */
export interface VerificationPolicy {
  /** Whether the executor can self-verify (answer: never in Vectra). */
  selfVerify: false;
  /** Require a receipt artifact matching the handoff-artifact schema. */
  requireReceipt: boolean;
  /** Run T2 receipt scan after completion. */
  t2Scan: boolean;
  /** Run verify_cmd from the protocol's var files. */
  runVerifyCmd: boolean;
}

// ─── Escalation Rules ───────────────────────────────────────────────

export interface EscalationRule {
  /** Condition that triggers escalation. */
  condition: string;
  /** Target: 't3' for analysis, 'human' for direct escalation, 'retry' for auto-retry. */
  target: 't3' | 'human' | 'retry';
  /** Maximum retries before escalating to next level. */
  maxRetries: number;
  /** Next escalation target if retries exhaust. */
  fallback: 't3' | 'human';
}

// ─── Budget ─────────────────────────────────────────────────────────

export interface JobBudget {
  /** Maximum wall-clock time in milliseconds. */
  timeoutMs: number;
  /** Maximum estimated cost in USD. */
  maxCostUsd: number;
  /** Maximum sub-agent recursion depth. */
  maxRecursionDepth: number;
  /** Maximum number of tool calls. */
  maxToolCalls: number;
}

// ─── Context Layers ─────────────────────────────────────────────────

/** Context composition layers. Harness decides what goes in each. */
export interface ContextLayers {
  /** Static context: protocol definition, guardrails, role prompt. */
  static: string[];
  /** Task context: task description, objectives, constraints. */
  task: string[];
  /** Working context: var file contents (JIT or cached). */
  working: string[];
  /** Persistent context: checkpoints from prior attempts. */
  persistent: string[];
  /** Retrieval context: memory search results, web fetch results. */
  retrieval: string[];
}

// ─── Checkpoint ─────────────────────────────────────────────────────

export interface Checkpoint {
  /** Checkpoint ID (job_id + sequence number). */
  id: string;
  /** When the checkpoint was created. */
  createdAt: string;
  /** Job state at checkpoint time. */
  state: JobState;
  /** Which context layers were active. */
  contextSnapshot: ContextLayers;
  /** Tool calls completed before this checkpoint. */
  toolCallsCompleted: number;
  /** Elapsed time in ms. */
  elapsedMs: number;
  /** Free-form notes from the harness. */
  notes: string;
}

// ─── Job State ──────────────────────────────────────────────────────

/** All legal job states. See state-machine.ts for transitions. */
export type JobState =
  | 'queued'       // Received, awaiting admission
  | 'admitted'     // Passed intake gate, protocol matched
  | 'prepared'     // Context bundle assembled and validated
  | 'planning'     // Model is generating execution plan
  | 'executing'    // Model is executing tool calls
  | 'blocked'      // Awaiting approval, external event, or human input
  | 'verifying'    // Receipt gate + T2 scan running
  | 'completed'    // All success conditions met
  | 'failed'       // Unrecoverable failure
  | 'halted'       // Stop condition triggered
  | 'archived';    // Post-completion, telemetry finalized

// ─── Job Envelope ───────────────────────────────────────────────────

/**
 * The complete job envelope. Created at intake, carried through the
 * entire lifecycle, and archived with the telemetry record.
 */
export interface JobEnvelope {
  /** Unique job identifier (UUID v4). */
  id: string;

  /** Human-readable job description. */
  description: string;

  /** When the job was created (ISO 8601). */
  createdAt: string;

  /** When the job last changed state (ISO 8601). */
  updatedAt: string;

  /** Current state in the lifecycle. */
  state: JobState;

  /** Full state transition history. */
  stateHistory: Array<{
    from: JobState;
    to: JobState;
    timestamp: string;
    reason: string;
  }>;

  // ── Source & Trust ──

  /** Where this job originated. */
  source: JobSource;

  /** Trust level (derived from source). */
  trustLevel: TrustLevel;

  /** ID of the originating entity (user ID, cron job name, parent job ID, webhook ID). */
  originatorId: string;

  /** Parent job ID if this is a sub-agent task. Null for root jobs. */
  parentJobId: string | null;

  /** Current recursion depth (0 for root jobs). */
  recursionDepth: number;

  // ── Protocol Binding ──

  /** Matched ATP protocol ID. Set at admission. */
  protocolId: ProtocolId;

  /** Task class derived from protocol match. */
  taskClass: TaskClass;

  /** ATP var IDs required by this protocol. */
  varIds: string[];

  /** Model class assigned by protocol routing table. */
  modelClass: ModelClass;

  /** Tools the job is authorized to use. */
  toolAllowlist: ToolName[];

  /** Protocol guardrails (injected as constraints). */
  guardrails: string[];

  // ── Budget ──

  /** Resource limits for this job. */
  budget: JobBudget;

  // ── Context ──

  /** Assembled context layers. */
  context: ContextLayers;

  /** Bundle ID for the context bundle (matches manifest entry). */
  bundleId: string;

  // ── Execution ──

  /** Approval policy for this job's actions. */
  approvalPolicy: ApprovalPolicy;

  /** How completion is verified. */
  verificationPolicy: VerificationPolicy;

  /** Escalation rules for failure modes. */
  escalationRules: EscalationRule[];

  /** Checkpoints taken during execution. */
  checkpoints: Checkpoint[];

  /** Tool calls made during execution. */
  toolCalls: Array<{
    tool: ToolName;
    timestamp: string;
    durationMs: number;
    success: boolean;
    checkpointBefore: string | null;
    checkpointAfter: string | null;
  }>;

  // ── Result ──

  /** Path to the handoff artifact, if produced. */
  artifactPath: string | null;

  /** Terminal failure reason, if the job failed. */
  failureReason: string | null;

  /** Stop condition that triggered halt, if any. */
  haltCondition: string | null;

  /** Var files updated as a result of this job. */
  varUpdates: Array<{
    varId: string;
    field: string;
    oldValue: string;
    newValue: string;
  }>;

  // ── Telemetry ──

  /** Estimated cost in USD accumulated so far. */
  estimatedCostUsd: number;

  /** Wall-clock elapsed time in ms. */
  elapsedMs: number;

  /** Number of tool calls made. */
  toolCallCount: number;
}

/**
 * Create a new job envelope with defaults.
 */
export function createJobEnvelope(params: {
  description: string;
  source: JobSource;
  originatorId: string;
  parentJobId?: string;
  recursionDepth?: number;
}): JobEnvelope {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id,
    description: params.description,
    createdAt: now,
    updatedAt: now,
    state: 'queued',
    stateHistory: [],
    source: params.source,
    trustLevel: SOURCE_TRUST[params.source],
    originatorId: params.originatorId,
    parentJobId: params.parentJobId ?? null,
    recursionDepth: params.recursionDepth ?? 0,

    // Set at admission — defaults to conversational until dispatcher binds a protocol
    protocolId: 'conversational',
    taskClass: 'conversational',
    varIds: [],
    modelClass: 'fast',
    toolAllowlist: [],
    guardrails: [],

    budget: {
      timeoutMs: 0,
      maxCostUsd: 0,
      maxRecursionDepth: 3,
      maxToolCalls: 50,
    },

    context: {
      static: [],
      task: [],
      working: [],
      persistent: [],
      retrieval: [],
    },

    bundleId: `${id}-bundle`,

    approvalPolicy: 'auto',
    verificationPolicy: {
      selfVerify: false,
      requireReceipt: true,
      t2Scan: true,
      runVerifyCmd: false,
    },
    escalationRules: [],
    checkpoints: [],
    toolCalls: [],

    artifactPath: null,
    failureReason: null,
    haltCondition: null,
    varUpdates: [],

    estimatedCostUsd: 0,
    elapsedMs: 0,
    toolCallCount: 0,
  };
}
