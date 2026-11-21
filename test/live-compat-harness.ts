import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ModelSelection } from '../src/domain/model-ref.ts';
import { parseModelRef } from '../src/domain/model-ref.ts';

/**
 * Opt-in live compatibility harness (#148, #103 follow-up). It never calls `Service.discover()`
 * or starts/stops anything: the only endpoints it may touch are the explicit disposable URLs
 * supplied by the operator. Without the opt-in env vars every case records `not run`.
 */

export type CompatVersion = 'v2.3.1' | 'v2.3.2';
export type CompatTarget = Readonly<{ version: CompatVersion; url: string }>;
export type SmokeStatus = 'offline fixture pass' | 'live pass' | 'live failure' | 'not run';
export type SmokeResult = Readonly<{
  case: string;
  version: string;
  status: SmokeStatus;
  detail: string;
  observedAt: string;
}>;
export type CompatConfig = Readonly<{
  enabled: boolean;
  targets: readonly CompatTarget[];
  directory: string | undefined;
  model: ModelSelection | undefined;
  resultsPath: string | undefined;
}>;

function modelFrom(raw: string | undefined): ModelSelection | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseModelRef(raw);
  if (parsed === undefined) return undefined;
  return {
    providerID: parsed.providerID ?? 'opencode',
    modelID: parsed.modelID,
    ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
  };
}

export function compatConfig(env: NodeJS.ProcessEnv = process.env): CompatConfig {
  const targets: CompatTarget[] = [];
  const v231 = env['MARGARITA_COMPAT_V231_URL'];
  const v232 = env['MARGARITA_COMPAT_V232_URL'];
  if (v231 !== undefined && v231 !== '') targets.push({ version: 'v2.3.1', url: v231 });
  if (v232 !== undefined && v232 !== '') targets.push({ version: 'v2.3.2', url: v232 });
  return {
    enabled: env['MARGARITA_LIVE'] === '1',
    targets,
    directory: env['MARGARITA_COMPAT_DIRECTORY'] || undefined,
    model: modelFrom(env['MARGARITA_COMPAT_MODEL']),
    resultsPath: env['MARGARITA_COMPAT_RESULTS'] || undefined,
  };
}

/** Guards that make it impossible to aim the live suite at the user's own service by accident. */
export function disposableSetupErrors(config: CompatConfig): string[] {
  const errors: string[] = [];
  const urls = config.targets.map((target) => target.url);
  for (const target of config.targets) {
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      errors.push(`${target.version}: invalid URL`);
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`${target.version}: unsupported protocol`);
    }
    if (url.username !== '' || url.password !== '') {
      errors.push(`${target.version}: credentials belong in env, not the URL`);
    }
  }
  if (config.targets.length === 0) errors.push('no disposable server URLs configured');
  if (new Set(urls).size !== urls.length) errors.push('targets must use distinct URLs');
  if (config.directory === undefined) {
    errors.push('MARGARITA_COMPAT_DIRECTORY is required (isolated disposable workdir)');
  }
  if (config.model === undefined) {
    errors.push('MARGARITA_COMPAT_MODEL is required (provider/model#variant)');
  }
  return errors;
}

/** Strips credentials and known secrets before a detail line is written to a result file. */
export function redact(detail: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = detail.replace(/:\/\/[^@/\s]+@/g, '://***@');
  for (const key of ['MARGARITA_SERVER_PASSWORD', 'MARGARITA_COMPAT_TOKEN']) {
    const secret = env[key];
    if (secret !== undefined && secret !== '') out = out.split(secret).join('***');
  }
  return out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '***');
}

export function result(
  caseID: string,
  version: string,
  status: SmokeStatus,
  detail: string,
  now: () => number = Date.now,
): SmokeResult {
  return {
    case: caseID,
    version,
    status,
    detail: redact(detail),
    observedAt: new Date(now()).toISOString(),
  };
}

export async function recordResult(config: CompatConfig, entry: SmokeResult): Promise<void> {
  if (config.resultsPath === undefined) return;
  await mkdir(dirname(config.resultsPath), { recursive: true });
  await appendFile(config.resultsPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Bounded polling for opt-in live cases; never used by the default (skipped) suite. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
