import type { ServiceName } from '@stuwith/contracts';
import { z } from 'zod';
import {
  apiEnvSchema,
  realtimeGatewayEnvSchema,
  type ApiEnv,
  type RealtimeGatewayEnv,
} from './schema';

export type EnvSource = Record<string, string | undefined>;

export type ConfigProblem =
  | { readonly kind: 'missing'; readonly variable: string }
  | { readonly kind: 'invalid'; readonly variable: string; readonly reason: string };

export type ConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

function toProblems(error: z.ZodError, source: EnvSource): ConfigProblem[] {
  return error.issues.map((issue): ConfigProblem => {
    const variable = issue.path.map(String).join('.') || '(root)';
    // A key that is simply not set reads as "missing"; a key that is set but wrong
    // reads as "invalid". Conflating the two is what makes startup failures
    // expensive to debug at 2am.
    if (source[variable] === undefined || source[variable] === '') {
      return { kind: 'missing', variable };
    }
    return { kind: 'invalid', variable, reason: issue.message };
  });
}

function parse<T>(schema: z.ZodType<T>, source: EnvSource): ConfigResult<T> {
  const parsed = schema.safeParse(source);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  return { ok: false, problems: toProblems(parsed.error, source) };
}

export function parseApiEnv(source: EnvSource = process.env): ConfigResult<ApiEnv> {
  return parse(apiEnvSchema, source);
}

export function parseRealtimeGatewayEnv(
  source: EnvSource = process.env,
): ConfigResult<RealtimeGatewayEnv> {
  return parse(realtimeGatewayEnvSchema, source);
}

/**
 * Human-readable report. Deliberately names the exact variables, and deliberately
 * never echoes their values — a bad secret must not be printed to prove it is bad.
 */
export function formatProblems(service: ServiceName, problems: readonly ConfigProblem[]): string {
  const lines = [`[config] ${service}: refusing to start — environment is not valid.`];
  const missing = problems.filter((p) => p.kind === 'missing').map((p) => p.variable);
  const invalid = problems.filter(
    (p): p is Extract<ConfigProblem, { kind: 'invalid' }> => p.kind === 'invalid',
  );

  if (missing.length > 0) {
    lines.push(`[config] ${service}: missing required environment variable(s):`);
    for (const variable of missing) {
      lines.push(`[config]   - ${variable}`);
    }
  }
  for (const problem of invalid) {
    lines.push(`[config] ${service}: invalid value for ${problem.variable} — ${problem.reason}`);
  }
  lines.push('[config] See .env.example for the full list. No secret has a default value.');
  return lines.join('\n');
}

export interface ExitBehaviour {
  readonly write: (message: string) => void;
  readonly exit: (code: number) => never;
}

const processExitBehaviour: ExitBehaviour = {
  write: (message) => {
    process.stderr.write(`${message}\n`);
  },
  exit: (code) => process.exit(code) as never,
};

function loadOrExit<T>(
  service: ServiceName,
  result: ConfigResult<T>,
  behaviour: ExitBehaviour,
): T {
  if (result.ok) {
    return result.config;
  }
  behaviour.write(formatProblems(service, result.problems));
  return behaviour.exit(1);
}

/**
 * Fail fast, before any port is opened. Both bootstraps call this as their very
 * first statement so an incomplete environment can never reach `listen()`.
 */
export function loadApiConfig(
  source: EnvSource = process.env,
  behaviour: ExitBehaviour = processExitBehaviour,
): ApiEnv {
  return loadOrExit('api', parseApiEnv(source), behaviour);
}

export function loadRealtimeGatewayConfig(
  source: EnvSource = process.env,
  behaviour: ExitBehaviour = processExitBehaviour,
): RealtimeGatewayEnv {
  return loadOrExit('realtime-gateway', parseRealtimeGatewayEnv(source), behaviour);
}
