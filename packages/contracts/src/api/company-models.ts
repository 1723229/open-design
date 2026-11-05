import type { ProviderModelsRequest } from './providerModels';

/** Administrator-owned provider configuration, shared by web and od CLI. */
export type CompanyAgentId = 'codex' | 'claude' | 'opencode' | 'deepseek-harness';
export type CompanyModelProtocol = 'responses' | 'chat-completions' | 'anthropic-messages';
export interface CompanyModelCapability {
  model: string;
  protocol: CompanyModelProtocol;
  status: 'supported' | 'unsupported' | 'error';
  checkedAt: number;
  /** Protocol results discover candidates; native proof applies only to that Agent. */
  testedBy?: 'protocol' | CompanyAgentId;
  verification?: 'file-write';
  message?: string;
}
export function companyCapabilitySupportsAgent(capability: CompanyModelCapability, agentId: string): boolean {
  return capability.status === 'supported' && capability.testedBy === agentId && capability.verification === 'file-write';
}
export interface CompanyModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** Original API form format; independent of wire capability evidence. */
  apiProtocol?: ProviderModelsRequest['protocol'];
  models: string[];
  /** Optional output cap, an integer from 1024 through 200000. */
  maxTokens?: number;
  hasApiKey: boolean;
  revision: number;
  capabilities: CompanyModelCapability[];
}
/** Immutable, non-secret routing reference; safe to persist with a queued job. */
export interface CompanyModelRoute {
  agentId: CompanyAgentId;
  providerId: string;
  providerRevision: number;
  model: string;
  protocol: CompanyModelProtocol;
}
export interface CompanyActiveModel extends CompanyModelRoute {
  providerName: string;
  /** Address of the effective provider revision, independent of saved drafts. */
  baseUrl?: string;
  activatedAt: number;
  verifiedAt: number | null;
}
export interface CompanyModelAgent {
  id: CompanyAgentId;
  name: string;
  /** Native transports, ordered by preference when there is no compatible active route. */
  protocols: CompanyModelProtocol[];
  installed: boolean;
  version?: string;
}
export interface CompanyModelSettingsResponse {
  revision: number;
  providers: CompanyModelProvider[];
  active: CompanyActiveModel | null;
  agents: CompanyModelAgent[];
}
export interface CompanyProviderSaveRequest {
  expectedRevision: number;
  id?: string;
  name: string;
  baseUrl: string;
  /** Original API form format; independent of wire capability evidence. */
  apiProtocol?: ProviderModelsRequest['protocol'];
  /** Omit to retain the existing key. Empty keys are rejected. */
  apiKey?: string;
  models: string[];
  /** Omit to retain the configured cap; null restores the model default. */
  maxTokens?: number | null;
}
export interface CompanyProviderTestRequest {
  /** Omit for generic discovery only; activation always requires native evidence. */
  agentId?: CompanyAgentId;
  /** Omit to test the selected Agent's declared protocols. */
  protocol?: CompanyModelProtocol;
  expectedRevision: number;
  providerId: string;
  model: string;
}
export interface CompanyModelActivateRequest {
  expectedRevision: number;
  agentId: CompanyAgentId;
  providerId: string;
  model: string;
  /** Omit to select a verified native protocol automatically. */
  protocol?: CompanyModelProtocol;
}
export interface CompanyProviderModelsRequest {
  /** Existing provider identity. Omit this for an unsaved, read-only catalog request. */
  providerId?: string;
  /** Optional read-only URL override for a saved provider, or draft URL when unsaved. */
  baseUrl?: string;
  apiKey?: string;
  /** Original provider form protocol. Required for unsaved requests. */
  protocol?: ProviderModelsRequest['protocol'];
  apiVersion?: string;
}
export interface CompanyProviderModelsResponse {
  models: string[];
  status?: 'ok' | 'empty';
}

export interface CompanyProviderDeleteRequest { expectedRevision: number }
