/**
 * vectra init — interactive instance creator.
 *
 * Scaffolds a new Vectra instance by prompting for configuration,
 * then writes the instance JSON and optional blank ATP instance.
 *
 * GUARDRAIL: Never writes credentials — only env var names go in config.
 * Credentials are always referenced by environment variable name.
 *
 * Uses Node's built-in readline — no additional dependencies.
 */

import { createInterface } from 'node:readline/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';

// ─── Autonomy Level Descriptions ────────────────────────────────────

const AUTONOMY_LEVELS: Record<number, string> = {
  0: 'Fully manual — human approves every action',
  1: 'Assisted — suggests actions, human executes',
  2: 'Supervised — executes read-only, asks for writes',
  3: 'Semi-autonomous — executes within guardrails, escalates unknowns',
  4: 'Bounded autonomous — executes most tasks, escalates high-risk',
  5: 'Scheduled/event-driven — operates independently on schedule',
};

// ─── Default Models ─────────────────────────────────────────────────

const DEFAULT_MODELS = {
  main: 'anthropic/claude-sonnet-4-6',
  t1: 'xai/grok-4-1-fast',
  t2: 'anthropic/claude-sonnet-4-6',
  t3: 'anthropic/claude-opus-4-6',
};

// ─── Instance Schema ────────────────────────────────────────────────

interface InstanceConfig {
  instanceId: string;
  atpPath: string;
  models: {
    mainAgent: string;
    t1: string;
    t2: string;
    t3: string;
    fallback: string;
  };
  transport: {
    type: string;
    config: Record<string, unknown>;
  };
  autonomyLevel: number;
  costCeiling: number;
  timeoutMultiplier: number;
  maxRecursionDepth: number;
  captainTwo: {
    enabled: boolean;
    standbyEndpoint: string;
    heartbeatIntervalMs: number;
  };
}

// ─── Main ───────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log('\n⚓ Vectra Instance Creator\n');
    console.log('This will scaffold a new Vectra instance configuration.\n');

    // 1. Instance ID
    const instanceId = await askRequired(
      rl,
      'Instance ID (e.g. "my-agent"): ',
    );
    const sanitizedId = instanceId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (sanitizedId !== instanceId) {
      console.log(`  → Sanitized to: ${sanitizedId}`);
    }

    // 2. Transport type
    console.log('\nTransport types:');
    console.log('  discord  — Discord bot (requires bot token)');
    console.log('  webhook  — HTTP webhook endpoint');
    console.log('  cli      — Local CLI / stdin');
    const transport = await askChoice(
      rl,
      'Transport type: ',
      ['discord', 'webhook', 'cli'],
      'discord',
    );

    // 3. Transport-specific config
    const transportConfig: Record<string, unknown> = {};
    const envVars: Record<string, string> = {};

    if (transport === 'discord') {
      const tokenEnvVar = await askDefault(
        rl,
        'Discord bot token env var name: ',
        'DISCORD_BOT_TOKEN',
      );
      const guildId = await askRequired(rl, 'Discord guild (server) ID: ');
      transportConfig.tokenEnvVar = tokenEnvVar;
      transportConfig.guildId = guildId;
      transportConfig.channels = {
        primary: '',
        ops: '',
        telemetry: '',
      };
      envVars[tokenEnvVar] = 'your-discord-bot-token';
    } else if (transport === 'webhook') {
      const port = await askDefault(rl, 'Webhook listen port: ', '18801');
      transportConfig.port = parseInt(port, 10);
      transportConfig.secret_env_var = 'VECTRA_WEBHOOK_SECRET';
      envVars.VECTRA_WEBHOOK_SECRET = 'your-webhook-secret';
    }
    // cli needs no config

    // 4. Model assignments
    console.log('\nModel assignments (press Enter for defaults):');
    const mainModel = await askDefault(
      rl,
      `  Main agent [${DEFAULT_MODELS.main}]: `,
      DEFAULT_MODELS.main,
    );
    const t1Model = await askDefault(
      rl,
      `  T1 scanner [${DEFAULT_MODELS.t1}]: `,
      DEFAULT_MODELS.t1,
    );
    const t2Model = await askDefault(
      rl,
      `  T2 watcher [${DEFAULT_MODELS.t2}]: `,
      DEFAULT_MODELS.t2,
    );
    const t3Model = await askDefault(
      rl,
      `  T3 validator [${DEFAULT_MODELS.t3}]: `,
      DEFAULT_MODELS.t3,
    );

    // 5. Autonomy level
    console.log('\nAutonomy levels:');
    for (const [level, desc] of Object.entries(AUTONOMY_LEVELS)) {
      console.log(`  ${level} — ${desc}`);
    }
    const autonomyStr = await askDefault(rl, 'Autonomy level [4]: ', '4');
    const autonomyLevel = Math.max(
      0,
      Math.min(5, parseInt(autonomyStr, 10) || 4),
    );

    // 6. ATP instance path
    console.log('\nATP instance:');
    console.log('  new      — create a blank ATP instance');
    console.log('  existing — point to an existing ATP directory');
    const atpChoice = await askChoice(
      rl,
      'ATP instance: ',
      ['new', 'existing'],
      'new',
    );

    let atpPath: string;
    if (atpChoice === 'existing') {
      atpPath = await askRequired(rl, 'Path to existing ATP instance: ');
      atpPath = resolve(atpPath);
    } else {
      const baseDir = resolve('atp-instances');
      atpPath = join(baseDir, sanitizedId);
      console.log(`  → Will create: ${atpPath}`);
    }

    // ── Generate files ──────────────────────────────────────────────

    console.log('\nGenerating files...\n');

    // Instance config
    const config: InstanceConfig = {
      instanceId: sanitizedId,
      atpPath,
      models: {
        mainAgent: mainModel,
        t1: t1Model,
        t2: t2Model,
        t3: t3Model,
        fallback: 'openai/gpt-5.4-mini',
      },
      transport: {
        type: transport,
        config: transportConfig,
      },
      autonomyLevel,
      costCeiling: 5.0,
      timeoutMultiplier: 3.0,
      maxRecursionDepth: 3,
      captainTwo: {
        enabled: false,
        standbyEndpoint: '',
        heartbeatIntervalMs: 30000,
      },
    };

    // Write instance config
    const instanceDir = resolve('instances');
    await mkdir(instanceDir, { recursive: true });
    const instancePath = join(instanceDir, `${sanitizedId}.instance.json`);
    await writeFile(
      instancePath,
      JSON.stringify(config, null, 2) + '\n',
      'utf-8',
    );
    console.log(`  ✓ ${instancePath}`);

    // Create blank ATP instance if new
    if (atpChoice === 'new') {
      await scaffoldAtpInstance(atpPath, sanitizedId);
    }

    // Write .env.example
    const envLines = [
      '# Vectra environment variables',
      `# Instance: ${sanitizedId}`,
      '',
      '# OpenClaw gateway',
      'VECTRA_OPENCLAW_URL=http://localhost:18789',
      'VECTRA_OPENCLAW_TOKEN=',
      '',
    ];

    if (Object.keys(envVars).length > 0) {
      envLines.push('# Transport');
      for (const [key, hint] of Object.entries(envVars)) {
        envLines.push(`${key}=${hint}`);
      }
      envLines.push('');
    }

    const envPath = resolve('.env.example');
    await writeFile(envPath, envLines.join('\n') + '\n', 'utf-8');
    console.log(`  ✓ ${envPath}`);

    // Summary
    console.log('\n⚓ Instance created successfully!\n');
    console.log(`  Instance:  ${sanitizedId}`);
    console.log(`  Transport: ${transport}`);
    console.log(`  Autonomy:  ${autonomyLevel} — ${AUTONOMY_LEVELS[autonomyLevel]}`);
    console.log(`  ATP path:  ${atpPath}`);
    console.log(`\n  Next: copy .env.example to .env, fill in credentials, then run:`);
    console.log(`    vectra start\n`);
  } finally {
    rl.close();
  }
}

// ─── ATP Instance Scaffold ──────────────────────────────────────────

async function scaffoldAtpInstance(
  atpPath: string,
  instanceId: string,
): Promise<void> {
  const dirs = ['protocols', 'vars', 'artifacts', 'intake', 'reports', 'workers'];

  for (const dir of dirs) {
    await mkdir(join(atpPath, dir), { recursive: true });
  }

  // README
  await writeFile(
    join(atpPath, 'README.md'),
    [
      `# ATP Instance: ${instanceId}`,
      '',
      'Agent Task Protocol instance for Vectra.',
      '',
      '## Structure',
      '- `protocols/` — Protocol definitions (markdown with YAML frontmatter)',
      '- `vars/` — Variable files (state snapshots)',
      '- `artifacts/` — Handoff artifacts from completed jobs',
      '- `intake/` — Held tasks awaiting review',
      '- `reports/` — Telemetry and audit reports',
      '- `workers/` — Worker definitions',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Minimal orchestration-main protocol
  await writeFile(
    join(atpPath, 'protocols', 'orchestration-main.md'),
    [
      '---',
      'id: orchestration-main',
      `name: ${instanceId} Orchestration Protocol`,
      'version: 0.1.0',
      'status: active',
      'tier: orchestration',
      'classification: private',
      `created: ${new Date().toISOString().split('T')[0]}`,
      '',
      'triggers:',
      '  - "*"',
      '',
      'routing:',
      '  - task_pattern: "*"',
      '    execution_protocol: conversational',
      '    var_ids: []',
      '    model_class: fast',
      '    priority: 0',
      '---',
      '',
      '# Orchestration Protocol',
      '',
      'Add routing entries above to match task patterns to execution protocols.',
      '',
    ].join('\n'),
    'utf-8',
  );

  // ATP hook
  await writeFile(
    join(atpPath, 'ATP_HOOK.md'),
    [
      '# ATP Hook',
      '',
      `Instance: ${instanceId}`,
      '',
      'This file is loaded by the agent at session start.',
      'Add instance-specific directives here.',
      '',
    ].join('\n'),
    'utf-8',
  );

  console.log(`  ✓ ${atpPath}/ (blank ATP instance)`);
}

// ─── Prompt Helpers ─────────────────────────────────────────────────

async function askRequired(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  let answer = '';
  while (!answer) {
    answer = (await rl.question(prompt)).trim();
    if (!answer) {
      console.log('  This field is required.');
    }
  }
  return answer;
}

async function askDefault(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultVal: string,
): Promise<string> {
  const answer = (await rl.question(prompt)).trim();
  return answer || defaultVal;
}

async function askChoice(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  choices: string[],
  defaultVal: string,
): Promise<string> {
  let answer = '';
  while (!answer) {
    const raw = (await rl.question(prompt)).trim().toLowerCase();
    if (!raw) {
      answer = defaultVal;
    } else if (choices.includes(raw)) {
      answer = raw;
    } else {
      console.log(`  Choose one of: ${choices.join(', ')}`);
    }
  }
  return answer;
}
