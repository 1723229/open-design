import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppConfigPrefs } from '../app-config.js';
import type { CompanyProviderDeleteRequest, CompanyModelAgent, CompanyModelRoute, CompanyModelProvider, CompanyModelSettingsResponse, CompanyActiveModel, CompanyProviderSaveRequest, CompanyProviderTestRequest, CompanyProviderModelsRequest, CompanyProviderModelsResponse, CompanyModelActivateRequest } from '@open-design/contracts';
import { catalogModels, probeModel, type ProbeRequest } from './model-probe.js';
import { companyCapabilitySupportsAgent } from '@open-design/contracts';

export const COMPANY_MODEL_AGENTS: Omit<CompanyModelAgent, 'installed'>[] = [
  { id: 'codex', name: 'Codex', protocols: ['responses'] },
  { id: 'claude', name: 'Claude Code', protocols: ['anthropic-messages'] },
  { id: 'opencode', name: 'OpenCode', protocols: ['chat-completions', 'responses', 'anthropic-messages'] },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', protocols: ['chat-completions'] },
];
export class CompanyModelSettingsError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'CompanyModelSettingsError'; }
}
export interface ResolvedCompanyModelRoute extends CompanyModelRoute { baseUrl: string; apiKey: string; providerName: string; maxTokens?: number }
interface StoredProvider extends Omit<CompanyModelProvider, 'hasApiKey'> { apiKey: string }
interface Store { revision: number; providers: StoredProvider[]; history: StoredProvider[]; active: CompanyActiveModel | null }
interface Options { legacy?: AppConfigPrefs; retainedRoutes?: () => CompanyModelRoute[]; fetchImpl?: typeof fetch; now?: () => number; probeTimeoutMs?: number; nativeProbe?: typeof probeModel }
const FRESH_MS = 30 * 60 * 1000;
function fail(status: number, code: string, message: string): never { throw new CompanyModelSettingsError(status, code, message); }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) fail(400, 'invalid_input', `${label} is required.`); return value.trim(); }
function normalizeUrl(value: unknown): string {
  let url: URL; try { url = new URL(text(value, 'Provider URL')); } catch { return fail(400, 'invalid_url', 'Provider URL must be an HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) fail(400, 'invalid_url', 'Provider URL cannot contain credentials, query parameters or fragments.');
  if (!url.pathname.replace(/\//g, '')) url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

export class CompanyModelSettings {
  private readonly file: string;
  private state: Store;
  constructor(dataRoot: string, private readonly options: Options = {}) {
    this.file = path.join(dataRoot, 'company-models.json');
    this.state = { revision: 0, providers: [], history: [], active: null };
    if (existsSync(this.file)) this.reload();
    else { this.migrate(options.legacy); this.persist(); }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private reload() { this.state = JSON.parse(readFileSync(this.file, 'utf8')) as Store; }
  private check(expected: number) { this.reload(); if (!Number.isInteger(expected) || expected !== this.state.revision) fail(409, 'revision_conflict', 'Model settings changed; reload and retry.'); }
  private provider(id: string) { const p = this.state.providers.find(p => p.id === id); if (!p) fail(404, 'provider_not_found', 'Provider does not exist.'); return p; }
  private persist() {
    const retained = [...(this.options.retainedRoutes?.() ?? []), ...(this.state.active ? [this.state.active] : [])];
    this.state.history = this.state.history.filter(p => retained.some(r => r.providerId === p.id && r.providerRevision === p.revision));
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, this.file); chmodSync(this.file, 0o600); }
    finally { rmSync(temp, { force: true }); }
  }
  private migrate(legacy?: AppConfigPrefs) {
    const agent = COMPANY_MODEL_AGENTS.find(a => a.id === legacy?.agentId);
    if (!agent) return;
    const env = legacy?.agentCliEnv?.[agent.id] ?? {}; const selection = legacy?.agentModels?.[agent.id]?.model?.trim();
    const model = ['opencode', 'deepseek-harness'].includes(agent.id) ? selection?.replace(/^[^/]+\//, '') : selection;
    const apiKey = agent.id === 'claude' ? env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN : agent.id === 'deepseek-harness' ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY || (agent.id === 'codex' ? env.CODEX_API_KEY : '');
    const base = agent.id === 'claude' ? env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1' : agent.id === 'deepseek-harness' ? env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1' : env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    if (!model || !apiKey?.trim()) return;
    let baseUrl: string; try { baseUrl = normalizeUrl(base); } catch { return; }
    const provider: StoredProvider = { id: randomUUID(), name: 'Migrated provider', baseUrl, apiKey: apiKey.trim(), models: [model], revision: 1, capabilities: [] };
    this.state.providers.push(provider); this.state.revision = 1;
    this.state.active = { agentId: agent.id, protocol: agent.protocols[0]!, providerId: provider.id, providerRevision: 1, model, providerName: provider.name, activatedAt: this.now(), verifiedAt: null };
  }
  view(agents: CompanyModelAgent[] = []): CompanyModelSettingsResponse {
    this.reload();
    const active = this.state.active;
    const effectiveProvider = active && [...this.state.providers, ...this.state.history].find(p => p.id === active.providerId && p.revision === active.providerRevision);
    return structuredClone({ revision: this.state.revision, providers: this.state.providers.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: Boolean(apiKey) })), active: active ? { ...active, ...(effectiveProvider ? { baseUrl: effectiveProvider.baseUrl } : {}) } : null, agents });
  }
  saveProvider(request: CompanyProviderSaveRequest): CompanyModelSettingsResponse {
    this.check(request.expectedRevision);
    const old = request.id ? this.provider(request.id) : undefined;
    const name = text(request.name, 'Provider name'); const baseUrl = normalizeUrl(request.baseUrl);
    const apiKey = request.apiKey === undefined && old ? old.apiKey : text(request.apiKey, 'API key');
    if (!Array.isArray(request.models)) fail(400, 'invalid_models', 'Model IDs must be an array.');
    const models = [...new Set(request.models.map(m => text(m, 'Model ID')))];
    if (!models.length) fail(400, 'invalid_models', 'At least one model ID is required.');
    const maxTokens = request.maxTokens === undefined ? old?.maxTokens : request.maxTokens ?? undefined;
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 200000)) fail(400, 'invalid_max_tokens', 'Output cap must be an integer from 1024 through 200000.');
    const apiProtocol = request.apiProtocol ?? old?.apiProtocol;
    if (apiProtocol !== undefined && !['openai', 'anthropic', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix', 'bedrock'].includes(apiProtocol)) fail(400, 'invalid_protocol', 'Unknown API form protocol.');
    const configurationUnchanged = old && old.baseUrl === baseUrl && old.apiKey === apiKey && old.maxTokens === maxTokens && JSON.stringify(old.models) === JSON.stringify(models) && old.apiProtocol === apiProtocol;
    const provider: StoredProvider = { id: old?.id ?? randomUUID(), name, baseUrl, apiKey, models, ...(apiProtocol ? { apiProtocol } : {}), ...(maxTokens === undefined ? {} : {maxTokens}), revision: (old?.revision ?? 0) + 1, capabilities: configurationUnchanged ? old.capabilities : [] };
    if (old) { this.state.history.push(old); this.state.providers = this.state.providers.map(p => p.id === old.id ? provider : p); }
    else this.state.providers.push(provider);
    this.state.revision++; this.persist(); return this.view();
  }
  deleteProvider(id: string, request: CompanyProviderDeleteRequest): CompanyModelSettingsResponse {
    this.check(request.expectedRevision); this.provider(id);
    if (this.state.active?.providerId === id) fail(409, 'provider_active', 'Switch the active relay before deleting it.');
    if (this.options.retainedRoutes?.().some(route => route.providerId === id)) fail(409, 'provider_in_use', 'Wait for unfinished jobs using this relay to complete before deleting it.');
    this.state.providers = this.state.providers.filter(provider => provider.id !== id);
    this.state.history = this.state.history.filter(provider => provider.id !== id);
    this.state.revision++; this.persist(); return this.view();
  }
  async testProvider(request: CompanyProviderTestRequest): Promise<CompanyModelSettingsResponse> {
    this.check(request.expectedRevision); const p = structuredClone(this.provider(request.providerId));
    if (!p.models.includes(request.model)) fail(422, 'unknown_model', 'Save the model ID before testing it.');
    const agent = request.agentId ? COMPANY_MODEL_AGENTS.find(a => a.id === request.agentId) : undefined;
    if (request.agentId && (!agent || (request.protocol && !agent.protocols.includes(request.protocol)))) fail(422, 'protocol_unsupported', 'Select a supported Agent and protocol.');
    if (request.protocol && !request.agentId) fail(422, 'agent_required', 'Select an Agent for native verification.');
    const results = await Promise.all([...new Set(COMPANY_MODEL_AGENTS.flatMap(a => a.protocols))].map(protocol =>
      probeModel({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: request.model, protocol, fetchImpl: this.options.fetchImpl, timeoutMs: this.options.probeTimeoutMs, now: this.options.now })));
    for (const protocol of agent ? (request.protocol ? [request.protocol] : agent.protocols) : []) {
      const probe: ProbeRequest = { baseUrl: p.baseUrl, apiKey: p.apiKey, model: request.model, protocol, agentId: agent!.id, now: this.options.now };
      let native: Awaited<ReturnType<typeof probeModel>> = { model: request.model, protocol, status: 'error', checkedAt: this.now(), testedBy: agent!.id, verification: 'file-write', message: 'Native file-write verification failed.' };
      try {
        const evidence = await this.options.nativeProbe?.(probe);
        if (evidence?.model === request.model && evidence.protocol === protocol && evidence.testedBy === agent!.id && evidence.verification === 'file-write') native = evidence;
      } catch { /* Never expose executor diagnostics or credentials. */ }
      results.push(native);
    }
    this.check(request.expectedRevision);
    const current = this.provider(p.id); if (current.revision !== p.revision) fail(409, 'revision_conflict', 'Provider changed during its test.');
    current.capabilities = [...current.capabilities.filter(c => c.model !== request.model || (c.testedBy && c.testedBy !== 'protocol' && !(c.testedBy === agent?.id && (!request.protocol || c.protocol === request.protocol)))), ...results];
    this.state.revision++; this.persist(); return this.view();
  }
  async catalog(request: CompanyProviderModelsRequest): Promise<CompanyProviderModelsResponse> {
    this.reload(); const p = this.provider(request.providerId);
    const active = this.state.active;
    const protocol = request.protocol ?? p.apiProtocol ?? ((active?.providerId === p.id ? active.protocol : p.capabilities.find(c => c.status === 'supported')?.protocol) === 'anthropic-messages' ? 'anthropic' : 'openai');
    try { return await catalogModels({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol, apiVersion: request.apiVersion, fetchImpl: this.options.fetchImpl, timeoutMs: this.options.probeTimeoutMs }); }
    catch { return fail(502, 'catalog_unavailable', 'Provider model catalog is unavailable; enter model IDs manually.'); }
  }
  activate(request: CompanyModelActivateRequest, agents: CompanyModelAgent[]): CompanyModelSettingsResponse {
    this.check(request.expectedRevision); const p = this.provider(request.providerId);
    const definition = COMPANY_MODEL_AGENTS.find(a => a.id === request.agentId);
    if (!definition || !agents.some(a => a.id === request.agentId && a.installed)) fail(422, 'agent_unavailable', 'Install the selected agent before activating it.');
    if (!p.models.includes(request.model)) fail(422, 'unknown_model', 'Select a saved model ID.');
    if (request.protocol !== undefined && !definition.protocols.includes(request.protocol)) fail(422, 'protocol_unsupported', 'The selected agent does not support this native protocol.');
    const active = this.state.active;
    const preferred = active?.providerId === p.id && active.model === request.model ? active.protocol : undefined;
    const protocols = request.protocol ? [request.protocol] : [...new Set([...(preferred && definition.protocols.includes(preferred) ? [preferred] : []), ...definition.protocols])];
    const capability = protocols.map(protocol => p.capabilities.find(c => c.model === request.model && c.protocol === protocol && companyCapabilitySupportsAgent(c, definition.id) && this.now() - c.checkedAt <= FRESH_MS && c.checkedAt <= this.now())).find(Boolean);
    if (!capability || this.now() - capability.checkedAt > FRESH_MS || capability.checkedAt > this.now()) fail(422, 'capability_required', 'A fresh native Agent file-write test is required.');
    this.state.active = { agentId: definition.id, protocol: capability.protocol, providerId: p.id, providerRevision: p.revision, model: request.model, providerName: p.name, activatedAt: this.now(), verifiedAt: capability.checkedAt };
    this.state.revision++; this.persist(); return this.view(agents);
  }
  pinActive(): CompanyModelRoute {
    this.reload(); const a = this.state.active;
    if (!a) fail(422, 'model_unconfigured', 'No company model is active.');
    return { agentId: a.agentId, protocol: a.protocol, providerId: a.providerId, providerRevision: a.providerRevision, model: a.model };
  }
  resolve(route: CompanyModelRoute): ResolvedCompanyModelRoute {
    this.reload(); const p = [...this.state.providers, ...this.state.history].find(p => p.id === route.providerId && p.revision === route.providerRevision);
    if (!p || !p.models.includes(route.model) || !COMPANY_MODEL_AGENTS.some(a => a.id === route.agentId && a.protocols.includes(route.protocol))) fail(422, 'route_unavailable', 'Pinned company model route is unavailable.');
    return { ...route, baseUrl: p.baseUrl, apiKey: p.apiKey, providerName: p.name, ...(p.maxTokens === undefined ? {} : {maxTokens:p.maxTokens}) };
  }
}
