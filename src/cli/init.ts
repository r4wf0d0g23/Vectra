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
import { writeFile, mkdir, readFile, appendFile } from 'node:fs/promises';
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
  fallback: 'openai/gpt-5.4-mini',
};

// ─── Provider Registry ──────────────────────────────────────────────

interface ProviderMenuEntry {
  id: string;
  label: string;
  envVar: string;
  envHint: string;
}

const PROVIDER_MENU: ProviderMenuEntry[] = [
  { id: 'anthropic',  label: 'Anthropic (Claude)',  envVar: 'ANTHROPIC_API_KEY',  envHint: 'your-anthropic-api-key' },
  { id: 'openai',     label: 'OpenAI',              envVar: 'OPENAI_API_KEY',     envHint: 'your-openai-api-key' },
  { id: 'xai',        label: 'xAI (Grok)',          envVar: 'XAI_API_KEY',        envHint: 'your-xai-api-key' },
  { id: 'vllm',       label: 'vLLM (self-hosted)',  envVar: 'VLLM_API_KEY',       envHint: 'optional-if-auth-enabled' },
  { id: 'openrouter', label: 'OpenRouter',          envVar: 'OPENROUTER_API_KEY', envHint: 'your-openrouter-api-key' },
];

// ─── Instance Schema ────────────────────────────────────────────────

interface ProviderConfig {
  baseUrl?: string;
  envVar?: string;
}

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
  providers: Record<string, ProviderConfig>;
  systemPrompt?: string;
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
    let discordBotToken = '';

    if (transport === 'discord') {
      const tokenEnvVar = 'DISCORD_BOT_TOKEN'; // silently default — never prompt
      const guildId = await askRequired(rl, 'Discord guild (server) ID: ');

      console.log('\nDiscord bot token (will be stored in .env, not in instance config):');
      discordBotToken = await askRequired(rl, '> ');

      transportConfig.tokenEnvVar = tokenEnvVar;
      transportConfig.guildId = guildId;
      transportConfig.channels = {
        primary: '',
        ops: '',
        telemetry: '',
      };
      // Do NOT add the real token to envVars/.env.example — it goes in .env only
    } else if (transport === 'webhook') {
      const port = await askDefault(rl, 'Webhook listen port: ', '18801');
      transportConfig.port = parseInt(port, 10);
      transportConfig.secret_env_var = 'VECTRA_WEBHOOK_SECRET';
      envVars.VECTRA_WEBHOOK_SECRET = 'your-webhook-secret';
    }
    // cli needs no config

    // 4. Model assignments
    console.log('\nModel assignments (press Enter to accept defaults):');

    console.log('\n  Main agent — primary AI that responds to messages');
    console.log(`    Default: ${DEFAULT_MODELS.main}`);
    const mainModel = await askDefault(rl, '    > ', DEFAULT_MODELS.main);

    console.log('\n  T1 (scanner) — fast/cheap model for periodic background checks');
    console.log(`    Default: ${DEFAULT_MODELS.t1}`);
    const t1Model = await askDefault(rl, '    > ', DEFAULT_MODELS.t1);

    console.log('\n  T2 (watcher) — correction model, triggered by T1 findings');
    console.log(`    Default: ${DEFAULT_MODELS.t2}`);
    const t2Model = await askDefault(rl, '    > ', DEFAULT_MODELS.t2);

    console.log('\n  T3 (validator) — deep reasoning for hard problems and quality gates');
    console.log(`    Default: ${DEFAULT_MODELS.t3}`);
    const t3Model = await askDefault(rl, '    > ', DEFAULT_MODELS.t3);

    console.log('\n  Fallback — used when primary model is unavailable');
    console.log(`    Default: ${DEFAULT_MODELS.fallback}`);
    const fallbackModel = await askDefault(rl, '    > ', DEFAULT_MODELS.fallback);

    // 5. Provider configuration
    console.log('\n--- Provider Configuration ---\n');
    console.log('Which providers will you use? (select all that apply)\n');
    PROVIDER_MENU.forEach((p, i) => {
      const label = `[${i + 1}] ${p.label}`;
      console.log(`  ${label.padEnd(28)} — requires ${p.envVar}`);
    });
    console.log();

    const providerInput = await askDefault(
      rl,
      'Enter numbers separated by commas (e.g. 1,3,4): ',
      '1',
    );

    const selectedIndexes = providerInput
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < PROVIDER_MENU.length);

    const uniqueIndexes = [...new Set(selectedIndexes)];
    const selectedProviders = uniqueIndexes.map((i) => PROVIDER_MENU[i]!).filter(Boolean);

    if (selectedProviders.length === 0) {
      selectedProviders.push(PROVIDER_MENU[0]!);
      console.log('  → No valid selection — defaulting to Anthropic');
    } else {
      console.log(`  → Selected: ${selectedProviders.map((p) => p.label).join(', ')}`);
    }

    const providersConfig: Record<string, ProviderConfig> = {};
    const providerEnvVars: Record<string, string> = {};
    let vllmNeedsKey = false;

    for (const provider of selectedProviders) {
      if (provider.id === 'vllm') {
        console.log('  Note: use `vllm/` prefix for model names (e.g. vllm/nemotron3-super)');
        console.log('  vLLM endpoint URL (e.g. http://100.78.161.126:8001/v1) [required]:');
        const vllmUrl = await askRequired(rl, '  > ');
        const needsKey = (await askDefault(rl, '  Requires API key? (y/N): ', 'N'))
          .trim()
          .toLowerCase();
        if (needsKey === 'y' || needsKey === 'yes') {
          providersConfig['vllm'] = { baseUrl: vllmUrl, envVar: 'VLLM_API_KEY' };
          providerEnvVars['VLLM_API_KEY'] = provider.envHint;
          vllmNeedsKey = true;
        } else {
          // No key required — endpoint URL only, no env var needed
          providersConfig['vllm'] = { baseUrl: vllmUrl };
        }
      } else {
        providersConfig[provider.id] = {};
        providerEnvVars[provider.envVar] = provider.envHint;
      }
    }

    // 6. Autonomy level
    console.log('\nAutonomy levels:');
    for (const [level, desc] of Object.entries(AUTONOMY_LEVELS)) {
      console.log(`  ${level} — ${desc}`);
    }
    const autonomyStr = await askDefault(rl, 'Autonomy level [4]: ', '4');
    const autonomyLevel = Math.max(
      0,
      Math.min(5, parseInt(autonomyStr, 10) || 4),
    );

    // 7. System prompt
    console.log('\nSystem prompt (defines your agent\'s personality and role):');
    console.log('  Press Enter for default, or type a custom prompt.');
    console.log('  Default: "You are a helpful assistant. Be concise and direct."');
    const systemPromptInput = await askDefault(rl, '> ', '');
    const systemPrompt = systemPromptInput || undefined;

    // 8. ATP instance path
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
        fallback: fallbackModel,
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
      providers: providersConfig,
      ...(systemPrompt ? { systemPrompt } : {}),
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
      '# Copy this file to .env and fill in values',
      '',
    ];

    // Discord bot token — always shown as placeholder in .env.example, never the real token
    if (transport === 'discord') {
      envLines.push('# Discord bot token (required)');
      envLines.push('DISCORD_BOT_TOKEN=your_bot_token_here');
      envLines.push('');
    }

    if (Object.keys(envVars).length > 0) {
      envLines.push('# Transport');
      for (const [key, hint] of Object.entries(envVars)) {
        envLines.push(`${key}=${hint}`);
      }
      envLines.push('');
    }

    // Non-vLLM provider env vars
    const nonVllmEnvVars = Object.fromEntries(
      Object.entries(providerEnvVars).filter(([k]) => k !== 'VLLM_API_KEY'),
    );
    if (Object.keys(nonVllmEnvVars).length > 0) {
      envLines.push('# Model providers');
      for (const [key, hint] of Object.entries(nonVllmEnvVars)) {
        envLines.push(`${key}=${hint}`);
      }
      envLines.push('');
    }

    // vLLM section — key is optional
    const hasVllm = selectedProviders.some((p) => p.id === 'vllm');
    if (hasVllm) {
      envLines.push('# vLLM — no API key required if your server runs without auth');
      if (vllmNeedsKey) {
        envLines.push('VLLM_API_KEY=your-vllm-api-key');
      } else {
        envLines.push('# VLLM_API_KEY=optional');
      }
      envLines.push('');
    }

    const envPath = resolve('.env.example');
    await writeFile(envPath, envLines.join('\n') + '\n', 'utf-8');
    console.log(`  ✓ ${envPath}`);

    // Write .env with actual Discord bot token (never goes in instance config or .env.example)
    if (discordBotToken) {
      const dotEnvPath = resolve('.env');
      let existingEnv = '';
      try {
        existingEnv = await readFile(dotEnvPath, 'utf-8');
      } catch {
        // File doesn't exist yet — start fresh
      }

      if (existingEnv.includes('DISCORD_BOT_TOKEN=')) {
        const updated = existingEnv.replace(
          /DISCORD_BOT_TOKEN=.*(?:\r?\n|$)/,
          `DISCORD_BOT_TOKEN=${discordBotToken}\n`,
        );
        await writeFile(dotEnvPath, updated, 'utf-8');
      } else {
        const separator = existingEnv && !existingEnv.endsWith('\n') ? '\n' : '';
        await appendFile(dotEnvPath, `${separator}DISCORD_BOT_TOKEN=${discordBotToken}\n`, 'utf-8');
      }
      console.log(`  ✓ .env (DISCORD_BOT_TOKEN written)`);
    }

    // Ensure .env is in .gitignore
    const gitignorePath = resolve('.gitignore');
    let gitignoreContent = '';
    try {
      gitignoreContent = await readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }
    const gitignoreLines = gitignoreContent.split('\n').map((l) => l.trim());
    if (!gitignoreLines.includes('.env')) {
      const separator = gitignoreContent && !gitignoreContent.endsWith('\n') ? '\n' : '';
      await appendFile(gitignorePath, `${separator}.env\n`, 'utf-8');
      console.log(`  ✓ .gitignore (added .env)`);
    }

    // Summary
    console.log('\n⚓ Instance created successfully!\n');
    console.log(`  Instance:  ${sanitizedId}`);
    console.log(`  Transport: ${transport}`);
    console.log(`  Autonomy:  ${autonomyLevel} — ${AUTONOMY_LEVELS[autonomyLevel]}`);
    console.log(`  ATP path:  ${atpPath}`);
    console.log(`\n  Next steps:`);
    console.log(`    1. Your .env has been created with your bot token`);
    console.log(`    2. Run: vectra start\n`);
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

  // Persona files — agent-editable soul/memory
  await writeFile(
    join(atpPath, 'SOUL.md'),
    [
      '# SOUL.md — Agent Identity',
      '',
      `You are ${instanceId}, an autonomous AI agent built on the Vectra harness.`,
      '',
      '## Core Directives',
      '- Be direct and honest',
      '- Learn from each conversation',
      '- Update this file when you discover something important about yourself',
      '',
      '## Personality',
      '[You will fill this in as you develop]',
      '',
      '## Current Understanding',
      '[What you know about your purpose and capabilities]',
      '',
    ].join('\n'),
    'utf-8',
  );

  await writeFile(
    join(atpPath, 'SOULPAIR.md'),
    [
      '# SOULPAIR.md — About Your Paired Human',
      '',
      '[Fill this in as you learn about the person you\'re talking to]',
      '',
      '## Preferences',
      '[Communication style, topics of interest, how they like to work]',
      '',
      '## Context',
      '[What they\'re trying to accomplish, their background]',
      '',
    ].join('\n'),
    'utf-8',
  );

  await writeFile(
    join(atpPath, 'DEMEANOR.md'),
    [
      '# DEMEANOR.md — How I Conduct Myself',
      '',
      '## How to Behave',
      '- Read SOUL.md at the start of each session',
      '- Update SOULPAIR.md when you learn something new about your paired human',
      '- Update SOUL.md when you learn something new about yourself',
      '- Be concise unless asked for detail',
      '',
      '## Memory',
      '- Write important facts to SOULPAIR.md or SOUL.md immediately',
      '- Don\'t rely on remembering — write it down',
      '',
    ].join('\n'),
    'utf-8',
  );

  console.log(`  ✓ ${atpPath}/ (blank ATP instance with persona files)`);
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
