/**
 * Vectra Capability Registry
 *
 * Maps agents to the task classes they can execute, with model class
 * and tool scope constraints. Used by the dispatcher to validate that
 * a job can be fulfilled by an available agent.
 */

import type { ModelClass, TaskClass, ToolName } from './job.js';
import { MODEL_CLASS_ORDER } from './job.js';

// ─── Agent Capability ───────────────────────────────────────────────

export interface AgentCapability {
  /** Agent identifier (e.g., 'captain', 'navigator', 'sub-agent'). */
  agentId: string;
  /** Task classes this agent can handle. */
  taskClasses: TaskClass[];
  /** Maximum model class this agent supports. */
  maxModelClass: ModelClass;
  /** Tools this agent has access to. */
  availableTools: ToolName[];
  /** Whether this agent is currently available. */
  online: boolean;
  /** Execution environment (local, ssh, api). */
  executionEnv: 'local' | 'ssh' | 'api';
}

// ─── Registry ───────────────────────────────────────────────────────

export class CapabilityRegistry {
  private agents: Map<string, AgentCapability> = new Map();

  register(capability: AgentCapability): void {
    this.agents.set(capability.agentId, capability);
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  get(agentId: string): AgentCapability | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Find agents capable of handling a given task class and model class.
   */
  findCapable(taskClass: TaskClass, modelClass: ModelClass): AgentCapability[] {
    return [...this.agents.values()].filter(
      (a) =>
        a.online &&
        a.taskClasses.includes(taskClass) &&
        MODEL_CLASS_ORDER[a.maxModelClass] >= MODEL_CLASS_ORDER[modelClass]
    );
  }

  /**
   * List all registered agents.
   */
  listAll(): AgentCapability[] {
    return [...this.agents.values()];
  }

  /**
   * Check if any agent can handle a task class.
   */
  canHandle(taskClass: TaskClass): boolean {
    return [...this.agents.values()].some(
      (a) => a.online && a.taskClasses.includes(taskClass)
    );
  }
}
