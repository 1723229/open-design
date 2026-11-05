import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { CompanyPresentation } from '@open-design/contracts';

export interface CompanyLdapConfig {
  url: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  userFilter: string;
  usernameAttribute: string;
  entryUUIDAttribute: string;
  displayNameAttribute: string;
  startTls: boolean;
  verifyTls: boolean;
  connectTimeoutMs: number;
  searchTimeoutMs: number;
  autoCreate: boolean;
  disabledAttribute?: string;
  disabledValue?: string;
}

export interface CompanyConfig {
  enabled: boolean;
  publicOrigin: string;
  auth: { mode: 'local' | 'ldap'; ldap?: CompanyLdapConfig };
  presentation: CompanyPresentation;
  teams?: { enabled: boolean };
  integrations?: Array<{ id: string; authorizeUrl: string; secret: string }>;
  integrationSkewSeconds?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function secretValues(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/gu, (_match, name: string) => {
    if (!/^NEXUS_[A-Z0-9_]+$/u.test(name)) throw new Error('Company config permits only NEXUS_* environment substitutions');
    if (!env[name]) throw new Error(`Missing company environment variable ${name}`);
    return env[name];
  });
  if (Array.isArray(value)) return value.map((item) => secretValues(item, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretValues(item, env)]));
  return value;
}

function required(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Company config requires ${key}`);
  return value;
}

function timeout(value: unknown): number {
  if (value === undefined) return 5000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 60) throw new Error('Invalid company LDAP timeout');
  return value * 1000;
}

/** Read only from the daemon's already resolved data root. */
export function loadCompanyConfig(dataRoot: string, env: Record<string, string | undefined> = process.env): CompanyConfig {
  const skew = env.OD_COMPANY_INTEGRATION_SKEW_SECONDS ?? '60';
  if (!/^\d+$/u.test(skew) || Number(skew) < 60 || Number(skew) > 600) {
    throw new Error('OD_COMPANY_INTEGRATION_SKEW_SECONDS must be an integer from 60 to 600');
  }
  const integrationSkewSeconds = Number(skew);
  const file = path.join(dataRoot, 'company.yaml');
  const disabled: CompanyConfig = {
    enabled: false, publicOrigin: '', auth: { mode: 'local' }, integrationSkewSeconds,
    presentation: { showAgentIdentity: true, hiddenSettingsSections: [] },
  };
  if (!existsSync(file)) return disabled;
  const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid company.yaml');
  const input = object(secretValues(document.toJS({ maxAliasCount: 50 }), env));
  const authentication = object(input.authentication);
  if (authentication.enabled === undefined || authentication.enabled === false) return disabled;
  if (authentication.enabled !== true) throw new Error('Company authentication.enabled must be boolean');
  const server = object(input.server);
  const origin = new URL(required(server.public_origin, 'server.public_origin'));
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Company server.public_origin must be an HTTP origin');
  }
  const local = object(authentication.local_admin);
  if (local.enabled === false || (local.username !== undefined && local.username !== 'admin')) throw new Error('Company local admin must be enabled with reserved username admin');
  const mode = authentication.default_provider ?? 'local';
  if (mode !== 'ldap' && mode !== 'local') throw new Error('Unsupported company authentication provider');
  const presentation = object(input.presentation);
  const hidden = presentation.hidden_settings_sections ?? ['labs', 'integrations'];
  if (!Array.isArray(hidden) || hidden.some((item) => typeof item !== 'string')) throw new Error('Invalid company hidden_settings_sections');
  const result: CompanyConfig = {
    enabled: true, publicOrigin: origin.origin, auth: { mode }, integrationSkewSeconds,
    presentation: { showAgentIdentity: presentation.show_agent_identity === true, hiddenSettingsSections: hidden as string[] },
  };
  const teams = object(input.teams);
  result.teams = { enabled: teams.enabled === true };
  if (teams.enabled !== undefined && typeof teams.enabled !== 'boolean') throw new Error('Invalid teams.enabled');
  const integrations = object(input.integrations);
  if (integrations.enabled === true) {
    if (!result.teams.enabled || mode !== 'ldap' || !Array.isArray(integrations.clients)) throw new Error('Integrations require teams and LDAP');
    const ids = new Set<string>();
    result.integrations = integrations.clients.map((value: unknown) => {
      const client = object(value), id = required(client.id, 'integration client id');
      const authorizeUrl = new URL(required(client.authorize_url, 'integration authorize_url'));
      const secret = required(client.secret, 'integration secret');
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || ids.has(id) || secret.length < 32 || secret.length > 4096
        || !['http:', 'https:'].includes(authorizeUrl.protocol) || authorizeUrl.username || authorizeUrl.password || authorizeUrl.search || authorizeUrl.hash) throw new Error('Invalid integration client');
      ids.add(id);
      return {id, authorizeUrl: authorizeUrl.href, secret};
    });
  }
  if (mode === 'ldap') {
    const ldap = object(object(authentication.providers).ldap);
    if (ldap.bind_mode !== undefined && ldap.bind_mode !== 'service') throw new Error('Company LDAP requires service bind mode');
    const url = required(ldap.url, 'authentication.providers.ldap.url');
    if (!['ldap:', 'ldaps:'].includes(new URL(url).protocol)) throw new Error('Invalid company LDAP URL');
    const userFilter = required(ldap.user_filter, 'authentication.providers.ldap.user_filter');
    if (!userFilter.includes('{username}')) throw new Error('Company LDAP filter must contain {username}');
    const attribute = (value: unknown, fallback: string) => {
      const name = value === undefined ? fallback : required(value, 'LDAP attribute');
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/u.test(name)) throw new Error('Invalid company LDAP attribute');
      return name;
    };
    result.auth.ldap = {
      url, baseDn: required(ldap.user_base_dn ?? ldap.base_dn, 'authentication.providers.ldap.base_dn'),
      bindDn: required(ldap.bind_dn, 'authentication.providers.ldap.bind_dn'),
      bindPassword: required(ldap.bind_password, 'authentication.providers.ldap.bind_password'),
      userFilter, usernameAttribute: attribute(ldap.username_attribute, 'uid'),
      entryUUIDAttribute: attribute(ldap.entry_uuid_attribute, 'entryUUID'),
      displayNameAttribute: attribute(ldap.display_name_attribute, 'cn'),
      startTls: ldap.start_tls === true, verifyTls: ldap.verify_tls !== false,
      connectTimeoutMs: timeout(ldap.connect_timeout_seconds), searchTimeoutMs: timeout(ldap.search_timeout_seconds),
      autoCreate: ldap.auto_create_local_user !== false,
      ...(ldap.disabled_attribute ? { disabledAttribute: attribute(ldap.disabled_attribute, '') } : {}),
      ...(typeof ldap.disabled_value === 'string' ? { disabledValue: ldap.disabled_value } : {}),
    };
  }
  return result;
}
