import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CompanyModelSettingsResponse, CompanyModelProvider, CompanyProviderModelsResponse, CompanyModelProtocol } from '@open-design/contracts';
import type { AgentInfo, AppConfig, ConnectionTestResponse } from '../types';
import { KNOWN_PROVIDERS } from '../state/config';
import { companyRequest } from './CompanyProvider';
import { companyCapabilitySupportsAgent } from '@open-design/contracts';

/** Match only the server's origin -> /v1 normalization; custom paths stay distinct. */
export function companyProviderUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.pathname === '/') url.pathname = '/v1';
    return url.toString().replace(/\/+$/, '');
  } catch { return value.trim().replace(/\/+$/, ''); }
}

/** Company routing and credentials never enter the ordinary app-config writer. */
export function companyGeneralConfig(draft: AppConfig, initial: AppConfig): AppConfig {
  const agentModels = { ...initial.agentModels };
  for (const [id, choice] of Object.entries(draft.agentModels ?? {})) {
    const previous = initial.agentModels?.[id];
    if ((choice.reasoning ?? '') === (previous?.reasoning ?? '') && (choice.serviceTier ?? '') === (previous?.serviceTier ?? '')) continue;
    agentModels[id] = { ...previous, reasoning: choice.reasoning, serviceTier: choice.serviceTier };
  }
  return { ...draft, mode: initial.mode, agentId: initial.agentId, model: initial.model,
    apiKey: '', baseUrl: initial.baseUrl, apiProtocol: initial.apiProtocol,
    apiVersion: initial.apiVersion, apiProviderBaseUrl: initial.apiProviderBaseUrl,
    byokImageModel: initial.byokImageModel, byokVideoModel: initial.byokVideoModel,
    byokSpeechModel: initial.byokSpeechModel, byokSpeechVoice: initial.byokSpeechVoice,
    maxTokens: initial.maxTokens, apiProtocolConfigs: {}, byokProviderConfigDrafts: {}, byokPendingProviderKey: undefined,
    agentCliEnv: initial.agentCliEnv,
    agentModels,
  };
}

export function useCompanyModelSettings(enabled: boolean, cfg: AppConfig, setCfg: Dispatch<SetStateAction<AppConfig>>, hostAgents: AgentInfo[]) {
  const [settings, setSettings] = useState<CompanyModelSettingsResponse | null>(null);
  const [providerId, setProviderId] = useState('');
  const relayDrafts = useRef(new Map<string, AppConfig>());
  const presetDrafts = useRef(new Map<string, string>());
  const newDraftSequence = useRef(0);
  const explicitRelay = useRef('');
  const [error, setError] = useState('');
  const state = useRef(settings);
  const draft = useRef({ cfg, providerId });
  if (draft.current.cfg !== cfg || draft.current.providerId !== providerId) draft.current = { cfg, providerId };
  const writes = useRef(Promise.resolve());
  const saving = useRef<{ owner: typeof draft.current; promise: Promise<CompanyModelProvider | null> }>();
  const selectedModel = (config: AppConfig) => config.mode === 'api' ? config.model.trim() : (config.agentModels?.[config.agentId ?? '']?.model ?? config.model).trim();
  function formProtocol(config: AppConfig, provider?: CompanyModelProvider): CompanyModelProtocol | undefined {
    const protocols = state.current?.agents.find(a => a.id === config.agentId)?.protocols.filter(protocol => config.mode !== 'api'
      || (config.apiProtocol === 'anthropic' ? protocol === 'anthropic-messages' : config.apiProtocol === 'openai' && protocol !== 'anthropic-messages')) ?? [];
    const model = selectedModel(config);
    const providers = provider ? [provider] : state.current?.providers.filter(p => config.mode !== 'api' || companyProviderUrl(p.baseUrl) === companyProviderUrl(config.baseUrl)) ?? [];
    const active = state.current?.active;
    if (active?.model === model && providers.some(p => p.id === active.providerId && compatible(p, model, active.protocol, config.agentId ?? '')) && protocols.includes(active.protocol)) return active.protocol;
    return protocols.find(protocol => providers.some(p => compatible(p, model, protocol, config.agentId ?? '')))
      ?? protocols.find(protocol => providers.some(p => p.capabilities.some(c => c.model === model && c.protocol === protocol && c.status === 'supported' && (!c.testedBy || c.testedBy === 'protocol'))))
      ?? protocols.find(protocol => providers.some(p => p.models.includes(model) && !p.capabilities.some(c => c.model === model && c.protocol === protocol && c.status !== 'supported')))
      ?? protocols[0];
  }
  function compatible(provider: CompanyModelProvider, model: string, protocol: string | undefined, agentId: string) {
    return provider.models.includes(model) && (provider.capabilities.some(c => c.model === model && c.protocol === protocol && companyCapabilitySupportsAgent(c, agentId))
      || (state.current?.active?.providerId === provider.id && state.current.active.model === model && state.current.active.protocol === protocol && state.current.active.agentId === agentId));
  }
  function resolve(config: AppConfig, preferred = providerId) {
    const providers = state.current?.providers ?? [];
    const selected = providers.find(p => p.id === preferred);
    // API editing has an explicit identity, including a distinct unsaved draft.
    if (config.mode === 'api') return selected;
    const model = selectedModel(config);
    if (selected?.id === explicitRelay.current && selected.models.includes(model)) return selected;
    const matches = (p: CompanyModelProvider) => compatible(p, model, formProtocol(config, p), config.agentId ?? '');
    return (selected && matches(selected) ? selected : undefined)
      ?? providers.find(p => p.id === state.current?.active?.providerId && matches(p))
      ?? providers.find(matches)
      ?? (selected?.models.includes(model) ? selected : undefined);
  }
  function providerApiProtocol(provider: CompanyModelProvider, protocol?: CompanyModelProtocol): NonNullable<AppConfig['apiProtocol']> {
    const active = state.current?.active;
    const evidence = protocol ?? (active?.providerId === provider.id ? active.protocol : undefined)
      ?? provider.capabilities.find(capability => capability.status === 'supported')?.protocol;
    return provider.apiProtocol ?? (evidence === 'anthropic-messages' ? 'anthropic' : 'openai');
  }
  function project(config: AppConfig, provider: CompanyModelProvider, model: string, protocol?: CompanyModelProtocol): AppConfig {
    const apiProtocol = providerApiProtocol(provider, protocol);
    const byokProviderConfigDrafts = Object.fromEntries(Object.entries(config.byokProviderConfigDrafts ?? {}).filter(([key, value]) =>
      !key.startsWith(`${apiProtocol}:`) || companyProviderUrl(value.apiConfig.baseUrl) !== companyProviderUrl(provider.baseUrl)));
    for (const saved of state.current?.providers ?? []) {
      const protocols = new Set<NonNullable<AppConfig['apiProtocol']>>(saved.capabilities.filter(c => c.status === 'supported').map(c => c.protocol === 'anthropic-messages' ? 'anthropic' : 'openai'));
      if (saved.id === provider.id) protocols.add(apiProtocol);
      for (const kind of protocols) {
        const preset = KNOWN_PROVIDERS.find(p => p.protocol === kind && companyProviderUrl(p.baseUrl) === companyProviderUrl(saved.baseUrl));
        const key = `${kind}:${preset?.baseUrl ?? `custom:${saved.baseUrl}`}`;
        if (byokProviderConfigDrafts[key]) continue;
        byokProviderConfigDrafts[key] = { apiConfig: { apiKey: '', baseUrl: saved.baseUrl, model: saved.id === provider.id ? model : saved.models[0] ?? '', apiProviderBaseUrl: preset?.baseUrl ?? null }, maxTokens: saved.maxTokens };
      }
    }
    return { ...config, apiProtocol, baseUrl: provider.baseUrl, model, maxTokens: provider.maxTokens,
      apiProviderBaseUrl: KNOWN_PROVIDERS.find(p => p.protocol === apiProtocol && companyProviderUrl(p.baseUrl) === companyProviderUrl(provider.baseUrl))?.baseUrl ?? null,
      apiKey: '', apiProtocolConfigs: {}, byokProviderConfigDrafts,
    };
  }
  function adopt(next: AppConfig, id: string, owner?: typeof draft.current) {
    const nextOwner = owner ?? { cfg: next, providerId: id };
    nextOwner.cfg = next; nextOwner.providerId = id; draft.current = nextOwner;
    setProviderId(id); setCfg(next); return nextOwner;
  }
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void companyRequest<CompanyModelSettingsResponse>('/api/company/models', { cache: 'no-store' }).then(value => {
      if (!live) return;
      state.current = value; setSettings(value);
      const provider = value.providers.find(p => p.id === value.active?.providerId) ?? value.providers[0];
      const agentId = value.active?.agentId ?? value.agents[0]?.id ?? null;
      const model = value.active?.model ?? provider?.models[0] ?? '';
      if (provider) {
        const protocol = value.active?.protocol ?? provider.capabilities.find(c => c.status === 'supported')?.protocol;
        adopt(project({ ...draft.current.cfg, agentId, agentModels: { ...draft.current.cfg.agentModels, ...(agentId ? { [agentId]: { ...draft.current.cfg.agentModels?.[agentId], model } } : {}) } }, provider, model, protocol), provider.id);
      }
    }).catch(reason => { if (live) setError(String(reason.message ?? reason)); });
    return () => { live = false; };
  }, [enabled]);
  function mutate(path: string, body: object, owner: typeof draft.current, method = 'POST') {
    const operation = writes.current.then(async () => {
      if (draft.current !== owner) return null;
      const value = await companyRequest<CompanyModelSettingsResponse>(`/api/company/models/${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, expectedRevision: state.current!.revision }),
      });
      state.current = value; setSettings(value); return value;
    });
    writes.current = operation.then(() => {}, () => {});
    return operation;
  }
  function save(owner = draft.current): Promise<CompanyModelProvider | null> {
    if (saving.current?.owner === owner) return saving.current.promise;
    const promise = (async () => {
      const config = owner.cfg, model = config.model.trim(), provider = resolve({ ...config, mode: 'api' }, owner.providerId);
      if (!state.current || draft.current !== owner) return null;
      if (!config.baseUrl.trim() || !model || (!config.apiKey.trim() && !provider?.hasApiKey)) throw new Error('Complete the provider URL, key and model.');
      if (provider && !config.apiKey.trim() && companyProviderUrl(config.baseUrl) === companyProviderUrl(provider.baseUrl) && config.maxTokens === provider.maxTokens && (!provider.apiProtocol || config.apiProtocol === provider.apiProtocol) && provider.models.includes(model)) return provider;
      const previousIds = state.current.providers.map(p => p.id);
      const value = await mutate('providers', { ...(provider ? { id: provider.id } : {}), name: provider?.name ?? new URL(config.baseUrl).host, apiProtocol: config.apiProtocol,
        baseUrl: config.baseUrl.trim(), models: [...new Set([...(provider?.models ?? []), model])], maxTokens: config.maxTokens ?? null,
        ...(config.apiKey.trim() ? { apiKey: config.apiKey.trim() } : {}),
      }, owner, 'PUT');
      const saved = value?.providers.find(p => provider ? p.id === provider.id : !previousIds.includes(p.id));
      if (saved && draft.current === owner) adopt(project(config, saved, model), saved.id, owner);
      return saved ?? null;
    })();
    saving.current = { owner, promise };
    void promise.finally(() => { if (saving.current?.promise === promise) saving.current = undefined; }).catch(() => {});
    return promise;
  }
  function hasChanges(snapshot: AppConfig) {
    if (!state.current) return false;
    const provider = resolve({ ...snapshot, mode: 'api' });
    if (!snapshot.baseUrl.trim() || !snapshot.model.trim() || (!snapshot.apiKey.trim() && !provider?.hasApiKey)) return false;
    return Boolean(snapshot.apiKey.trim()) || !provider || companyProviderUrl(snapshot.baseUrl) !== companyProviderUrl(provider.baseUrl) || (provider.apiProtocol !== undefined && snapshot.apiProtocol !== provider.apiProtocol) || snapshot.maxTokens !== provider.maxTokens || !provider.models.includes(snapshot.model.trim());
  }
  async function persist(snapshot: AppConfig) {
    if (!enabled || snapshot !== draft.current.cfg || !hasChanges(snapshot)) return;
    try { await save(); setError(''); } catch (reason) {
      if (snapshot === draft.current.cfg) setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }
  async function apply(owner: typeof draft.current, forceTest: boolean): Promise<ConnectionTestResponse | null> {
    const started = performance.now(), config = owner.cfg, model = selectedModel(config);
    try {
      const provider = config.mode === 'api' ? await save(owner) : resolve(config, owner.providerId);
      if (draft.current !== owner) return null;
      const agent = state.current?.agents.find(a => a.id === config.agentId);
      const protocol = formProtocol(config, provider ?? undefined);
      if (!provider || !model || !agent?.installed || !protocol || !agent.protocols.includes(protocol)) throw new Error('No compatible configured model for this agent.');
      let capability = provider.capabilities.find(c => c.model === model && c.protocol === protocol && c.testedBy === agent.id);
      if (forceTest || !capability || !companyCapabilitySupportsAgent(capability, agent.id) || Date.now() - capability.checkedAt > 30 * 60 * 1000 || capability.checkedAt > Date.now()) {
        const value = await mutate('test', { providerId: provider.id, model, agentId: agent.id, protocol }, owner);
        if (draft.current !== owner || !value) return null;
        capability = value.providers.find(p => p.id === provider.id)?.capabilities.find(c => c.model === model && c.protocol === protocol && c.testedBy === agent.id);
      }
      if (!capability || !companyCapabilitySupportsAgent(capability, agent.id)) throw new Error(capability?.message ?? 'Selected native protocol is unsupported for this agent.');
      const applied = await mutate('activate', { providerId: provider.id, model, agentId: agent.id, protocol }, owner);
      if (!applied || draft.current !== owner) return null;
      if (owner.cfg.agentModels?.[agent.id]?.model !== model) adopt({ ...owner.cfg,
        agentModels: { ...owner.cfg.agentModels, [agent.id]: { ...owner.cfg.agentModels?.[agent.id], model } },
      }, provider.id, owner);
      return { ok: true, kind: 'success', model, latencyMs: Math.round(performance.now() - started) };
    } catch (reason) {
      if (draft.current !== owner) return null;
      return { ok: false, kind: 'unknown', model, latencyMs: Math.round(performance.now() - started), detail: reason instanceof Error ? reason.message : String(reason) };
    }
  }
  async function catalog(onSaved: (provider: CompanyModelProvider) => void) {
    const owner = draft.current;
    try {
      const saved = await save(owner);
      if (!saved || draft.current !== owner) return null;
      onSaved(saved);
      const value = await companyRequest<CompanyProviderModelsResponse>('/api/company/models/catalog', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: saved.id,
          protocol: owner.cfg.apiProtocol === 'ollama' ? 'openai' : owner.cfg.apiProtocol, ...(owner.cfg.apiVersion ? { apiVersion: owner.cfg.apiVersion } : {}),
        }),
      });
      return draft.current === owner ? value : null;
    } catch (reason) { if (draft.current !== owner) return null; throw reason; }
  }
  function choose(agentId: string, requestedModel?: string) {
    const config = draft.current.cfg;
    const candidate = (provider: CompanyModelProvider, model: string) => {
      const protocol = formProtocol({ ...config, mode: 'daemon', agentId, agentModels: { ...config.agentModels, [agentId]: { model } } }, provider);
      return { provider, model, protocol };
    };
    const choices = state.current?.providers.flatMap(p => p.models.map(model => candidate(p, model))) ?? [];
    const candidates = choices.filter(c => compatible(c.provider, c.model, c.protocol, agentId));
    const preferred = requestedModel ?? config.agentModels?.[agentId]?.model;
    const unverified = choices.filter(c => c.protocol && !c.provider.capabilities.some(capability => capability.model === c.model && capability.protocol === c.protocol && capability.testedBy === agentId && capability.status !== 'supported'));
    const ordered = [...candidates].sort((a, b) => (a.provider.id === providerId ? 0 : a.provider.id === state.current?.active?.providerId ? 1 : 2) - (b.provider.id === providerId ? 0 : b.provider.id === state.current?.active?.providerId ? 1 : 2));
    const native = ordered.find(c => c.provider.capabilities.some(capability => capability.model === c.model && capability.protocol === c.protocol && capability.testedBy === agentId));
    const explicit = choices.find(c => c.provider.id === explicitRelay.current && (!requestedModel || c.model === requestedModel) && c.model === (requestedModel ?? config.model));
    const selection = explicit ?? ordered.find(c => c.model === preferred) ?? (requestedModel ? undefined : native ?? ordered.find(c => c.provider.id === providerId) ?? ordered.find(c => c.provider.id === state.current?.active?.providerId) ?? ordered.find(c => c.model === config.model) ?? ordered[0])
      ?? unverified.find(c => c.model === preferred) ?? (requestedModel ? undefined : unverified.find(c => c.model === config.model && c.provider.capabilities.some(e => e.model === c.model && e.protocol === c.protocol && e.status === 'supported' && (!e.testedBy || e.testedBy === 'protocol'))) ?? unverified.find(c => c.provider.capabilities.some(e => e.model === c.model && e.protocol === c.protocol && e.status === 'supported' && (!e.testedBy || e.testedBy === 'protocol'))) ?? unverified.find(c => c.provider.capabilities.length === 0));
    let next: AppConfig = { ...config, agentId, agentModels: { ...config.agentModels, [agentId]: { ...config.agentModels?.[agentId], model: selection?.model ?? requestedModel ?? '' } } };
    if (selection) { remember(); next = project(next, selection.provider, selection.model, selection.protocol); }
    else if (!selection) next = { ...next, apiProtocol: formProtocol(next) === 'anthropic-messages' ? 'anthropic' : 'openai', apiProviderBaseUrl: null, model: requestedModel ?? '' };
    const owner = adopt(next, selection?.provider.id ?? `new:${++newDraftSequence.current}`);
    return apply(owner, false);
  }
  function remember() {
    relayDrafts.current.set(draft.current.providerId, draft.current.cfg);
  }
  function selectRelay(id: string) {
    const provider = state.current?.providers.find(p => p.id === id);
    if (!provider) return;
    explicitRelay.current = id;
    remember(); setError('');
    const cached = relayDrafts.current.get(id);
    adopt(cached ? { ...draft.current.cfg, ...cached, mode: draft.current.cfg.mode } : project(draft.current.cfg, provider, provider.models[0] ?? ''), id);
  }
  function newRelay() {
    explicitRelay.current = '';
    remember(); setError('');
    const id = `new:${++newDraftSequence.current}`;
    adopt({ ...draft.current.cfg, apiKey: '', baseUrl: '', model: '', maxTokens: undefined, apiProviderBaseUrl: null, apiProtocolConfigs: {}, byokProviderConfigDrafts: {} }, id);
  }
  function selectPreset(protocol: AppConfig['apiProtocol'], baseUrl: string, custom: boolean) {
    const config = draft.current.cfg;
    const currentPreset = `${config.apiProtocol}:${config.apiProviderBaseUrl ?? 'custom'}`;
    presetDrafts.current.set(currentPreset, draft.current.providerId);
    const key = `${protocol}:${custom ? 'custom' : baseUrl}`;
    const id = presetDrafts.current.get(key);
    if (id && relayDrafts.current.has(id)) {
      remember(); adopt({ ...config, ...relayDrafts.current.get(id)!, mode: config.mode }, id); return;
    }
    const saved = state.current?.providers.find(p => providerApiProtocol(p) === protocol
      && (custom ? !KNOWN_PROVIDERS.some(preset => preset.protocol === protocol && companyProviderUrl(preset.baseUrl) === companyProviderUrl(p.baseUrl)) : companyProviderUrl(p.baseUrl) === companyProviderUrl(baseUrl)));
    if (saved) { selectRelay(saved.id); return; }
    newRelay();
    adopt({ ...draft.current.cfg, apiProtocol: protocol, baseUrl: custom ? '' : baseUrl, apiProviderBaseUrl: custom ? null : baseUrl,
      model: custom ? '' : KNOWN_PROVIDERS.find(p => p.protocol === protocol && p.baseUrl === baseUrl)?.preferredModels?.[0] ?? '' }, draft.current.providerId);
  }
  const provider = resolve(cfg);
  const agents: AgentInfo[] = useMemo(() => enabled ? (settings?.agents ?? []).map(value => ({
    ...hostAgents.find(a => a.id === value.id), id: value.id, name: value.name, bin: value.id,
    available: value.installed, version: value.version, authStatus: undefined, authMessage: undefined, diagnostics: undefined, path: undefined,
    models: [...new Set(settings?.providers.flatMap(p => p.models.filter(model => value.protocols.some(protocol => compatible(p, model, protocol, value.id) || p.capabilities.some(c => c.model === model && c.protocol === protocol && c.status === 'supported' && (!c.testedBy || c.testedBy === 'protocol')) || (value.id === cfg.agentId && model === cfg.agentModels?.[value.id]?.model && !p.capabilities.some(c => c.model === model && c.protocol === protocol && !companyCapabilitySupportsAgent(c, value.id)))))) ?? [])].map(id => ({ id, label: id })),
  })) : hostAgents, [enabled, settings, hostAgents, cfg.agentId, cfg.agentModels]);
  return { settings, selectPreset, providerId: provider?.id ?? providerId, agents, error, persist, hasChanges, test: () => apply(draft.current, true), catalog, choose,
    hasConfiguredKey: Boolean(provider?.hasApiKey) };
}
