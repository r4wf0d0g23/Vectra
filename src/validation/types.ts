export interface ValidatorAdapter {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ValidatorDaemonConfig {
  socketPath: string;
  adapters: ValidatorAdapter[];
  allowedExecutableRoots: string[];
  allowedWorkingRoots: string[];
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  maxConcurrent?: number;
}

export interface ValidationRequest {
  adapterId: string;
  correlationId: string;
}

export interface ValidationResult {
  ok: boolean;
  adapterId: string;
  correlationId: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface ValidatorHealth {
  status: 'ok' | 'degraded';
  component: 'vectra-validator';
  configHash: string;
  startedAt: string;
  active: number;
  completed: number;
  failed: number;
  lastCompletionAt: string | null;
}
