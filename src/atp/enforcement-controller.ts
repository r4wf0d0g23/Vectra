import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { classifyOperation, decideAdmission, ENFORCEMENT_CONTRACT_VERSION, type DefinitionPin, type EnforcementMode, type ImmutableExecutionPins, type OperationImpact } from '../core/enforcement-contract.js';
import type { OpenAiApiKind, OpenAiRequest } from '../model/openai-api.js';
import { extractTaskDescription } from '../model/openai-api.js';
import type { ModelExchange, ReleaseDecision, ResponseReleaseController } from '../model/response-release.js';
import { validate as callValidator, validatorHealth } from '../validation/client.js';

export interface RouteBinding {
  kind: 'single' | 'composite' | 'ambiguous' | 'none';
  protocolId?: string;
  protocolVersion?: string;
  protocolSchemaVersion?: string;
  protocolBytes?: Uint8Array;
  requiredVariables: Array<{ id: string; version: string; schemaVersion: string; bytes: Uint8Array; adapterId?: string }>;
  toolImpacts: Array<'read-only' | 'write-capable' | 'destructive' | 'privileged' | 'unknown'>;
  allowReadOnlyDegradation: boolean;
}

export interface RouteResolver { resolve(task: string): Promise<RouteBinding> }
export interface ReceiptVerifier {
  verify(run: EnforcementRun, exchange: ModelExchange): Promise<{ valid: boolean; receiptSha256?: string; reason?: string }>;
}
export interface FreshnessValidator {
  health(): Promise<{ status: 'ok' | 'degraded'; configHash: string }>;
  validate(adapterId: string, correlationId: string): Promise<{ ok: boolean }>;
}

export interface EnforcementControllerOptions {
  mode: EnforcementMode;
  instancePath: string;
  snapshotPath: string;
  ledgerPath: string;
  validatorSocketPath: string;
  pluginVersion: string;
  routes: RouteResolver;
  receipts: ReceiptVerifier;
  validator?: FreshnessValidator;
  now?: () => Date;
}

export interface EnforcementRun {
  runId: string;
  bundleId: string;
  protocolId: string;
  impact: OperationImpact;
  pins: ImmutableExecutionPins;
  pinsSha256: string;
  snapshotPath: string;
  degraded: boolean;
}

interface PendingContext { run: EnforcementRun }

interface DurableEvent {
  sequence: number; runId: string; bundleId: string; protocolId: string;
  type: 'pending' | 'executing' | 'verifying' | 'completed' | 'failed' | 'violated';
  occurredAt: string; pinsSha256: string; receiptSha256?: string; reason?: string;
}

const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;

async function atomicWrite(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

async function immutableWrite(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, 'wx', 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== bytes) throw new Error('immutable-snapshot-collision-or-tamper');
  }
}

export class DurableRunLedger {
  constructor(private readonly root: string) {}
  private path(runId: string): string {
    if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new Error('invalid-run-id');
    return join(this.root, `${runId}.json`);
  }
  async read(runId: string): Promise<DurableEvent[]> {
    try { return JSON.parse(await readFile(this.path(runId), 'utf8')) as DurableEvent[]; }
    catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  }
  async append(event: DurableEvent): Promise<void> {
    await this.withLock(event.runId, async () => {
      const events = await this.read(event.runId);
      if (events.some((entry) => ['completed', 'failed', 'violated'].includes(entry.type))) throw new Error('ledger-terminal-immutable');
      if (event.sequence !== events.length) throw new Error('ledger-sequence-invalid');
      if (events.length === 0 && event.type !== 'pending') throw new Error('ledger-must-start-pending');
      if (events.length && ['runId', 'bundleId', 'protocolId', 'pinsSha256'].some((field) => (events[0] as any)[field] !== (event as any)[field])) throw new Error('ledger-correlation-or-pins-changed');
      if (event.type === 'completed' && !event.receiptSha256) throw new Error('completion-requires-receipt');
      await atomicWrite(this.path(event.runId), `${JSON.stringify([...events, event], null, 2)}\n`);
    });
  }
  private async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lock = `${this.path(runId)}.lock`;
    const deadline = Date.now() + 5_000;
    let handle;
    while (!handle) {
      try { handle = await open(lock, 'wx', 0o600); await handle.writeFile(`${process.pid}\n${Date.now()}\n`); await handle.sync(); }
      catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > 30_000) { await unlink(lock).catch(() => undefined); continue; }
        if (Date.now() >= deadline) throw new Error('ledger-lock-timeout');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try { return await operation(); }
    finally { await handle.close(); await unlink(lock).catch(() => undefined); }
  }
  async reconcile(now: string): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const violated: string[] = [];
    for (const name of await readdir(this.root)) {
      if (!/^run_[a-f0-9]{32}\.json$/.test(name)) continue;
      const runId = name.slice(0, -5);
      const events = await this.read(runId);
      const last = events.at(-1);
      if (last && !['completed', 'failed', 'violated'].includes(last.type)) {
        await this.append({ ...last, sequence: events.length, type: 'violated', occurredAt: now, reason: 'startup-reconciliation-interrupted-run' });
        violated.push(runId);
      }
    }
    return violated;
  }
}

export class AtpEnforcementController implements ResponseReleaseController {
  private readonly pending = new WeakMap<OpenAiRequest, PendingContext>();
  private readonly ledger: DurableRunLedger;
  private readonly now: () => Date;
  private readonly validator: FreshnessValidator;
  constructor(private readonly options: EnforcementControllerOptions) {
    this.ledger = new DurableRunLedger(options.ledgerPath);
    this.now = options.now ?? (() => new Date());
    this.validator = options.validator ?? {
      health: () => validatorHealth(options.validatorSocketPath),
      validate: (adapterId, correlationId) => callValidator(options.validatorSocketPath, adapterId, correlationId),
    };
  }

  async reconcile(): Promise<string[]> { return this.ledger.reconcile(this.now().toISOString()); }

  async requiresHold(api: OpenAiApiKind, request: OpenAiRequest): Promise<boolean> {
    const task = extractTaskDescription(api, request);
    const route = await this.options.routes.resolve(task);
    const impact = classifyOperation(route.toolImpacts);
    const routeResolved = route.kind === 'single' && Boolean(route.protocolId && route.protocolBytes && route.protocolVersion && route.protocolSchemaVersion);
    let varsFresh = true;
    const pins: DefinitionPin[] = [];
    try {
      const health = await this.validator.health();
      if (health.status !== 'ok') varsFresh = false;
      for (const variable of route.requiredVariables) {
        if (!variable.adapterId) { varsFresh = false; continue; }
        const result = await this.validator.validate(variable.adapterId, randomUUID());
        if (!result.ok) varsFresh = false;
        pins.push({ id: variable.id, version: variable.version, schemaVersion: variable.schemaVersion, contentSha256: sha(variable.bytes), validatorSha256: health.configHash, attestationId: sha(canonical(result)) });
      }
    } catch { varsFresh = false; }

    const protocolPin: DefinitionPin = { id: route.protocolId ?? 'unresolved', version: route.protocolVersion ?? '0.0.0', schemaVersion: route.protocolSchemaVersion ?? '0', contentSha256: sha(route.protocolBytes ?? new Uint8Array()) };
    const pinBase = { protocol: protocolPin, variables: pins.sort((a, b) => a.id.localeCompare(b.id)), pluginVersion: this.options.pluginVersion, contractVersion: ENFORCEMENT_CONTRACT_VERSION };
    const bundleSha256 = sha(canonical(pinBase));
    const immutablePins: ImmutableExecutionPins = { ...pinBase, bundleSha256 };
    const pinsValid = routeResolved && pins.length === route.requiredVariables.length;
    const decision = decideAdmission({ mode: this.options.mode, impact, routeResolved, pinsValid, requiredVarsFresh: varsFresh, protocolAllowsReadOnlyDegradation: route.allowReadOnlyDegradation });
    if (!decision.upstreamAllowed) throw new Error(`ATP admission denied: ${decision.reason}`);

    const runId = `run_${sha(`${randomUUID()}\0${task}`).slice(0, 32)}`;
    const bundleId = `bnd_${bundleSha256.slice(0, 32)}`;
    const snapshot = { schemaVersion: '1.0.0', bundleId, pins: immutablePins,
      definitions: routeResolved ? [{ kind: 'protocol', id: route.protocolId, rawBase64: Buffer.from(route.protocolBytes!).toString('base64') }, ...route.requiredVariables.map((v) => ({ kind: 'variable', id: v.id, rawBase64: Buffer.from(v.bytes).toString('base64') }))] : [] };
    const snapshotPath = join(this.options.snapshotPath, `${bundleSha256}.json`);
    await immutableWrite(snapshotPath, `${canonical(snapshot)}\n`);
    const run: EnforcementRun = { runId, bundleId, protocolId: route.protocolId ?? 'unresolved', impact, pins: immutablePins, pinsSha256: sha(canonical(immutablePins)), snapshotPath, degraded: decision.degraded };
    await this.ledger.append({ sequence: 0, runId, bundleId, protocolId: run.protocolId, type: 'pending', occurredAt: this.now().toISOString(), pinsSha256: run.pinsSha256, reason: decision.reason });
    this.pending.set(request, { run });
    return true;
  }

  async evaluate(exchange: ModelExchange): Promise<ReleaseDecision> {
    const context = this.pending.get(exchange.request);
    if (!context) return { release: false, status: 503, code: 'missing_enforcement_run', message: 'No durable ATP run exists for this response' };
    const { run } = context;
    const base = { runId: run.runId, bundleId: run.bundleId, protocolId: run.protocolId, pinsSha256: run.pinsSha256, occurredAt: this.now().toISOString() };
    try {
      await this.ledger.append({ ...base, sequence: 1, type: 'executing' });
      await this.ledger.append({ ...base, sequence: 2, type: 'verifying' });
      const receipt = await this.options.receipts.verify(run, exchange);
      if (!receipt.valid || !receipt.receiptSha256) {
        await this.ledger.append({ ...base, sequence: 3, type: 'violated', reason: receipt.reason ?? 'receipt-invalid' });
        return { release: false, status: 409, code: 'receipt_invalid', message: 'ATP receipt validation failed' };
      }
      await this.ledger.append({ ...base, sequence: 3, type: 'completed', receiptSha256: receipt.receiptSha256 });
      return { release: true };
    } catch (error) {
      const events = await this.ledger.read(run.runId).catch(() => []);
      if (!events.some((event) => ['completed', 'failed', 'violated'].includes(event.type))) {
        await this.ledger.append({ ...base, sequence: events.length, type: 'violated', reason: error instanceof Error ? error.message : 'enforcement-error' }).catch(() => undefined);
      }
      return { release: false, status: 503, code: 'enforcement_unavailable', message: 'ATP enforcement could not verify completion' };
    }
  }
}
