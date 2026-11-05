import type { CompanyAgentId, CompanyModelCapability, CompanyModelProtocol, CompanyProviderModelsResponse } from '@open-design/contracts';
import type { ProviderModelsRequest } from '@open-design/contracts/api/providerModels';
import { listProviderModels } from '../integrations/provider-models.js';
import { readProviderResponse } from '../integrations/provider-response.js';

interface ProviderConnection { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined }
export interface ProbeRequest extends ProviderConnection { agentId?: CompanyAgentId; model: string; protocol: CompanyModelProtocol; now?: (() => number) | undefined }
export type CompanyModelCatalogErrorCode =
  | 'catalog_auth_failed'
  | 'catalog_network_error'
  | 'catalog_unsupported'
  | 'catalog_invalid_url'
  | 'catalog_unavailable';
export class CompanyModelCatalogError extends Error {
  constructor(public readonly status: number, public readonly code: CompanyModelCatalogErrorCode, message: string) {
    super(message);
    this.name = 'CompanyModelCatalogError';
  }
}
const MAX_BYTES = 1024 * 1024;
const schema = { type: 'object', properties: {}, additionalProperties: false };
interface ProtocolEvent {
  type: string;
  output_index?: number;
  index?: number;
  item?: { type: string; name?: string; arguments?: string };
  delta?: { type?: string; partial_json?: string } | string;
  arguments?: string;
  choices?: { index?: number; finish_reason?: string | null; delta?: { tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[];
  content_block?: { type: string; name?: string; input?: unknown };
}

function headers(apiKey: string, protocol?: CompanyModelProtocol): Record<string, string> {
  return protocol === 'anthropic-messages'
    ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

export async function probeModel(request: ProbeRequest): Promise<CompanyModelCapability> {
  const { model, protocol } = request;
  const result = (status: CompanyModelCapability['status'], message?: string): CompanyModelCapability => ({ model, protocol, status, testedBy: 'protocol', checkedAt: (request.now ?? Date.now)(), ...(message ? { message } : {}) });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
  const fn = { name: 'nexus_probe', description: 'Harmless capability check', parameters: schema };
  const common = { model, stream: true };
  const body = protocol === 'responses'
    ? { ...common, input: 'Call nexus_probe once.', tools: [{ type: 'function', ...fn }], tool_choice: { type: 'function', name: fn.name } }
    : protocol === 'chat-completions'
      ? { ...common, messages: [{ role: 'user', content: 'Call nexus_probe once.' }], tools: [{ type: 'function', function: fn }], tool_choice: { type: 'function', function: { name: fn.name } } }
      : { ...common, max_tokens: 128, messages: [{ role: 'user', content: 'Call nexus_probe once.' }], tools: [{ name: fn.name, description: fn.description, input_schema: schema }], tool_choice: { type: 'tool', name: fn.name } };
  const endpoint = { responses: 'responses', 'chat-completions': 'chat/completions', 'anthropic-messages': 'messages' }[protocol];
  try {
    const response = await (request.fetchImpl ?? fetch)(`${request.baseUrl}/${endpoint}`, { method: 'POST', headers: headers(request.apiKey, protocol), body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      return result([404, 405].includes(response.status) ? 'unsupported' : 'error', `Provider returned HTTP ${response.status}.`);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); return result('unsupported', 'Provider did not return an event stream.'); }
    const calls = new Map<string, { name: string; args: string }>(); let buffer = ''; let completed = false; let failed = false;
    function call(id: unknown) { const key = String(id ?? 0); if (!calls.has(key)) calls.set(key, { name: '', args: '' }); return calls.get(key)!; }
    function event(data: string) {
      if (!data || data === '[DONE]') return;
      let e: ProtocolEvent;
      try { e = JSON.parse(data); } catch { failed = true; return; }
      if (['error', 'response.failed', 'response.incomplete', 'response.error'].includes(e.type)) failed = true;
      if (protocol === 'responses') {
        if (e.type === 'response.completed') completed = true;
        if (['response.output_item.added', 'response.output_item.done'].includes(e.type) && e.item?.type === 'function_call') {
          const c = call(e.output_index); c.name = e.item.name ?? c.name; if (e.item.arguments) c.args = e.item.arguments;
        } else if (e.type === 'response.function_call_arguments.delta' && typeof e.delta === 'string') call(e.output_index).args += e.delta;
        else if (e.type === 'response.function_call_arguments.done') call(e.output_index).args = e.arguments ?? '';
      } else if (protocol === 'chat-completions') {
        for (const choice of Array.isArray(e.choices) ? e.choices : []) {
          if (choice.finish_reason === 'tool_calls') completed = true;
          for (const t of Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : []) {
            const c = call(`${choice.index ?? 0}:${t.index ?? 0}`); c.name += t.function?.name ?? ''; c.args += t.function?.arguments ?? '';
          }
        }
      } else {
        if (e.type === 'message_stop') completed = true;
        if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          // Streaming starts carry an empty placeholder, not the tool's completed arguments.
          const c = call(e.index); c.name = e.content_block.name ?? ''; c.args = '';
        } else if (e.type === 'content_block_delta' && typeof e.delta === 'object' && e.delta?.type === 'input_json_delta') {
          call(e.index).args += e.delta.partial_json ?? '';
        } else if (e.type === 'content_block_stop') {
          const c = call(e.index); if (!c.args) c.args = '{}';
        }
      }
    }
    await readProviderResponse(response, controller.signal, MAX_BYTES, text => {
      buffer += text;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        event(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
      }
      return completed || failed;
    });
    const supported = completed && !failed && [...calls.values()].some(c => { if (c.name !== 'nexus_probe') return false; try { const args = JSON.parse(c.args); return args !== null && typeof args === 'object' && !Array.isArray(args); } catch { return false; } });
    return result(supported ? 'supported' : 'unsupported', supported ? undefined : 'No protocol-compatible streamed tool call was observed.');
  } catch {
    return result('error', controller.signal.aborted ? 'Provider capability test timed out.' : 'Provider capability test failed.');
  } finally { clearTimeout(timer); }
}

export async function catalogModels(request: ProviderConnection & { protocol?: ProviderModelsRequest['protocol'] | undefined; apiVersion?: string | undefined }): Promise<CompanyProviderModelsResponse> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
  try {
    const result = await listProviderModels({ protocol: request.protocol ?? 'openai', baseUrl: request.baseUrl, apiKey: request.apiKey,
      ...(request.apiVersion ? { apiVersion: request.apiVersion } : {}), signal: controller.signal, fetchImpl: request.fetchImpl, maxResponseBytes: MAX_BYTES });
    if (result.kind === 'no_models') return { models: [], status: 'empty' };
    if (!result.ok || !result.models) {
      const unsupportedStatus = result.status === 404 || result.status === 405 || result.status === 501;
      const code: CompanyModelCatalogErrorCode = result.kind === 'forbidden' && result.status === undefined
        ? 'catalog_invalid_url'
        : unsupportedStatus || result.kind === 'unsupported_protocol'
        ? 'catalog_unsupported'
        : result.kind === 'auth_failed' || result.kind === 'forbidden'
          ? 'catalog_auth_failed'
          : result.kind === 'invalid_base_url' && /blocked|internal|private/i.test(result.detail ?? '')
            ? 'catalog_invalid_url'
            : result.kind === 'timeout' || result.kind === 'upstream_unavailable' || result.kind === 'invalid_base_url'
              ? 'catalog_network_error'
              : 'catalog_unavailable';
      const status = code === 'catalog_auth_failed' ? 502 : code === 'catalog_invalid_url' ? 403 : 502;
      const message = code === 'catalog_auth_failed'
        ? 'Provider model catalog rejected the API key.'
        : code === 'catalog_network_error'
          ? 'Could not reach the provider model catalog.'
          : code === 'catalog_unsupported'
            ? 'This provider does not expose a supported model catalog; enter the model ID manually.'
            : code === 'catalog_invalid_url'
              ? 'The provider URL is blocked by the server network policy.'
              : 'Provider model catalog is unavailable; enter the model ID manually.';
      throw new CompanyModelCatalogError(status, code, message);
    }
    const models: string[] = [];
    for (const entry of result.models) {
      if (typeof entry?.id !== 'string' || /[\x00-\x1f\x7f]/.test(entry.id)) continue;
      const id = entry.id.trim(); if (id && id.length <= 512 && !models.includes(id)) models.push(id);
    }
    return { models, status: models.length ? 'ok' : 'empty' };
  } catch (error) {
    if (error instanceof CompanyModelCatalogError) throw error;
    throw new CompanyModelCatalogError(502, 'catalog_unavailable', 'Provider model catalog is unavailable; enter model IDs manually.');
  }
  finally { clearTimeout(timer); }
}
