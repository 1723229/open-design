import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveDaemonUrl } from '../daemon-url.js';
import type { CompanySessionResponse } from '@open-design/contracts';

const COOKIE = 'od_company_session';
interface CliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetchImpl?: typeof fetch;
}

export function createCompanyTaskFetch(options: { daemonUrl: string; token: string; fetchImpl?: typeof fetch }): typeof fetch {
  const nativeFetch = options.fetchImpl ?? globalThis.fetch;
  const base = new URL(options.daemonUrl);
  const apiPrefix = `${base.pathname.replace(/\/$/u, '')}/api/`;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(options.token)) throw new Error('Invalid company task token');
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(apiPrefix)) return nativeFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('cookie');
    headers.delete('x-csrf-token');
    headers.set('authorization', `Bearer ${options.token}`);
    return nativeFetch(input, { ...init, headers, redirect: 'error' });
  };
}

export function createCompanyCliFetch(options: { daemonUrl: string; token: string; fetchImpl?: typeof fetch }): typeof fetch {
  const nativeFetch = options.fetchImpl ?? globalThis.fetch;
  const origin = new URL(options.daemonUrl).origin;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(options.token)) throw new Error('Invalid company session token');
  let csrfToken: string | undefined;
  const cookie = `${COOKIE}=${options.token}`;
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin || !/^\/(?:api|artifacts|frames|powered)(?:\/|$)/u.test(url.pathname)) return nativeFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const previous = headers.get('cookie')?.split(';').filter((part) => !part.trim().startsWith(`${COOKIE}=`)).join(';');
    headers.set('cookie', previous ? `${previous}; ${cookie}` : cookie);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!csrfToken) {
        const response = await nativeFetch(`${origin}/api/company/session`, { headers: { cookie }, redirect: 'error' });
        const session = await response.json() as CompanySessionResponse;
        if (!response.ok || !session.user || !session.csrfToken) throw new Error('Company session expired; sign in again');
        csrfToken = session.csrfToken;
      }
      headers.set('origin', origin);
      headers.set('x-csrf-token', csrfToken);
    }
    // A redirect must never carry a session credential to another service.
    return nativeFetch(input, { ...init, headers, redirect: 'error' });
  };
}

function credential(env: NodeJS.ProcessEnv, daemonUrl: string): string | null {
  if (env.OD_COMPANY_SESSION) return env.OD_COMPANY_SESSION.trim();
  if (!env.OD_COMPANY_SESSION_FILE) return null;
  const stored = JSON.parse(readFileSync(env.OD_COMPANY_SESSION_FILE, 'utf8')) as { daemonOrigin?: string; token?: string };
  if (stored.daemonOrigin !== new URL(daemonUrl).origin || typeof stored.token !== 'string') throw new Error('Company session file belongs to a different daemon');
  return stored.token;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  return args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** Enable existing od subcommands using an explicitly supplied company credential. */
export async function installCompanyCliFetch(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.OD_COMPANY_SESSION && !env.OD_COMPANY_SESSION_FILE && !env.OD_COMPANY_TASK_TOKEN) return;
  const flagUrl = flagValue(args, 'daemon-url');
  const daemonUrl = await resolveDaemonUrl({ ...(flagUrl ? { flagUrl } : {}), env });
  if (env.OD_COMPANY_TASK_TOKEN) {
    globalThis.fetch = createCompanyTaskFetch({ daemonUrl, token: env.OD_COMPANY_TASK_TOKEN });
    return;
  }
  const token = credential(env, daemonUrl);
  if (token) globalThis.fetch = createCompanyCliFetch({ daemonUrl, token });
}

const USAGE = `Usage:
  od company session [--json]
  od company login --username <name> --password-file <path|-> [--session-file <path>] [--json]
  od company logout [--json]
  od company password --password-file <current-path|-> --new-password-file <new-path|-> [--session-file <path>] [--json]
  od company users [list|update|revoke] [userId] [--role admin|member] [--disabled true|false] [--json]
  od company users create --username <name> --password-file <path|-> [--role admin|member] [--json]
  od company member list <projectId> [--json]
  od company member set <projectId> <userId> --role editor|viewer [--json]
  od company member remove <projectId> <userId> [--json]
  od company audit [--json]
  od company models list [--json]
  od company models provider-save|provider-delete|test|activate|catalog --prompt-file <path|-> [--json]

All commands accept --daemon-url <url>. Login/password also accept --prompt-file <path|->
containing the corresponding JSON request body. Passwords are never accepted as arguments.
Set OD_COMPANY_SESSION_FILE to an explicitly saved session file, or OD_COMPANY_SESSION
to a session token, to authenticate other od commands. A saved session is private (0600).
`;

function parse(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const strings = new Set(['daemon-url', 'username', 'password-file', 'new-password-file', 'session-file', 'prompt-file', 'role', 'disabled']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    if (['--json', '--help', '-h'].includes(argument)) { flags[argument === '-h' ? 'help' : argument.slice(2)] = true; continue; }
    const [name, inline] = argument.slice(2).split('=', 2);
    if (!name || !strings.has(name)) throw new Error(`Unknown company option ${argument.split('=')[0]}`);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing --${name} value`);
    flags[name] = value;
  }
  return { flags, positional };
}

function inputFile(value: string): string { return readFileSync(value === '-' ? 0 : value, 'utf8').replace(/\r?\n$/u, ''); }

export async function runCompanyCli(args: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((value: string) => { process.stdout.write(value); });
  const stderr = options.stderr ?? ((value: string) => { process.stderr.write(value); });
  try {
    const { positional, flags } = parse(args);
    if (flags.help || positional.length === 0) { stdout(USAGE); return 0; }
    const env = options.env ?? process.env;
    const flagUrl = typeof flags['daemon-url'] === 'string' ? flags['daemon-url'] : undefined;
    const daemonUrl = await resolveDaemonUrl({ ...(flagUrl ? { flagUrl } : {}), env });
    const origin = new URL(daemonUrl).origin;
    const token = credential(env, daemonUrl);
    const nativeFetch = options.fetchImpl ?? globalThis.fetch;
    const client = token ? createCompanyCliFetch({ daemonUrl, token, fetchImpl: nativeFetch }) : nativeFetch;
    const command = positional[0];
    let endpoint = '/api/company/session';
    let method = 'GET';
    let body: Record<string, unknown> | undefined;
    if (command === 'login' || command === 'password') {
      method = 'POST';
      endpoint = `/api/company/auth/${command}`;
      if (typeof flags['prompt-file'] === 'string') {
        body = JSON.parse(inputFile(flags['prompt-file'])) as Record<string, unknown>;
      } else {
        const passwordFile = flags['password-file'];
        if (typeof passwordFile !== 'string') throw new Error('--password-file is required');
        const password = inputFile(passwordFile);
        if (command === 'login') {
          if (typeof flags.username !== 'string') throw new Error('--username is required');
          body = { username: flags.username, password };
        } else {
          const newPasswordFile = flags['new-password-file'];
          if (typeof newPasswordFile !== 'string' || (passwordFile === '-' && newPasswordFile === '-')) throw new Error('Provide distinct current and new password files');
          body = { currentPassword: password, newPassword: inputFile(newPasswordFile) };
        }
      }
    } else if (command === 'logout') { endpoint = '/api/company/auth/logout'; method = 'POST'; body = {}; }
    else if (command === 'users') {
      endpoint = '/api/company/users';
      const operation = positional[1] ?? 'list';
      if (operation === 'create') {
        if (typeof flags.username !== 'string' || typeof flags['password-file'] !== 'string') throw new Error('Local user creation requires --username and --password-file');
        method = 'POST'; body = { username: flags.username, password: inputFile(flags['password-file']), role: flags.role ?? 'member' };
      } else if (operation !== 'list') {
        const id = positional[2];
        if (!id || !['update', 'revoke'].includes(operation)) throw new Error('Use users list|update|revoke with a user ID');
        endpoint += `/${encodeURIComponent(id)}`;
        if (operation === 'revoke') { endpoint += '/revoke'; method = 'POST'; body = {}; }
        else {
          method = 'PATCH'; body = {};
          if (flags.role !== undefined) body.role = flags.role;
          if (flags.disabled !== undefined) {
            if (flags.disabled !== 'true' && flags.disabled !== 'false') throw new Error('--disabled must be true or false');
            body.disabled = flags.disabled === 'true';
          }
        }
      }
    } else if (command === 'member' || command === 'members') {
      const [, operation, projectId, userId] = positional;
      if (!projectId || !['list', 'set', 'remove'].includes(operation ?? '')) throw new Error('Use member list|set|remove with a project ID');
      endpoint = `/api/company/projects/${encodeURIComponent(projectId)}/members`;
      if (operation !== 'list') {
        if (!userId) throw new Error('A user ID is required');
        if (operation === 'remove') { endpoint += `/${encodeURIComponent(userId)}`; method = 'DELETE'; }
        else { method = 'PUT'; body = { userId, role: flags.role }; }
      }
    } else if (command === 'models') {
      const operation = positional[1] ?? 'list';
      endpoint = '/api/company/models';
      if (operation !== 'list') {
        const suffix = { 'provider-delete': 'providers', 'provider-save': 'providers', test: 'test', activate: 'activate', catalog: 'catalog' }[operation];
        if (!suffix || typeof flags['prompt-file'] !== 'string') throw new Error('Use models provider-save|provider-delete|test|activate|catalog --prompt-file <path|->');
        endpoint += `/${suffix}`;
        method = operation === 'provider-save' ? 'PUT' : 'POST';
        const input: unknown = JSON.parse(inputFile(flags['prompt-file']));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Model request must be a JSON object');
        body = input as Record<string,unknown>;
        if (operation === 'provider-delete') {
          if (typeof body.providerId !== 'string' || !body.providerId.trim()) throw new Error('providerId is required');
          endpoint += `/${encodeURIComponent(body.providerId)}`;
          method = 'DELETE';
          body = { expectedRevision: body.expectedRevision };
        }
      }
    } else if (command === 'audit') endpoint = '/api/company/audit';
    else if (command !== 'session') throw new Error('Unknown company command');
    if (method !== 'GET' && command !== 'login' && !token) throw new Error('Supply OD_COMPANY_SESSION_FILE or OD_COMPANY_SESSION');
    const response = await (command === 'login' ? nativeFetch : client)(`${origin}${endpoint}`, {
      method, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok) { stdout(`${JSON.stringify(result)}\n`); return 1; }
    if (command === 'login' || command === 'password') {
      const sessionToken = response.headers.get('set-cookie')?.match(/(?:^|;\s*)od_company_session=([A-Za-z0-9_-]{43})(?:;|$)/u)?.[1];
      const sessionFile = flags['session-file'] ?? (command === 'password' ? env.OD_COMPANY_SESSION_FILE : undefined);
      if (typeof sessionFile === 'string') {
        if (!sessionToken) throw new Error('Daemon did not issue a company session');
        writeFileSync(sessionFile, `${JSON.stringify({ daemonOrigin: origin, token: sessionToken })}\n`, { mode: 0o600 });
        chmodSync(sessionFile, 0o600);
      } else if (command === 'login') stderr('Session is not saved; pass --session-file to authenticate later commands.\n');
    }
    stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (failure) {
    // Request bodies contain passwords; report only structural errors, never raw payloads.
    const message = failure instanceof SyntaxError ? 'Invalid JSON input' : failure instanceof Error ? failure.message : 'Company command failed';
    stderr(`${JSON.stringify({ error: message })}\n`);
    return 1;
  }
}
