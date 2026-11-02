import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { closeHttpServer, startDaemonRuntime } from '../../src/daemon-startup.js';
import { startCompanyApi } from '../../src/company/api-main.js';

vi.mock('../../src/daemon-startup.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/daemon-startup.js')>(),
  startDaemonRuntime: vi.fn(),
}));
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await closeHttpServer(server);
  }
  vi.clearAllMocks();
});
async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server);
  server.listen(0, host);
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

it('hosts the scoped proxy alongside the API and keeps it available until daemon cleanup completes', async () => {
  const daemon = createServer((req, res) => res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization })));
  const port = await listen(daemon);
  let proxyOrigin = '';
  const stop = vi.fn(async () => {
    expect((await fetch(`${proxyOrigin}/control/leases/job`, { method: 'DELETE', headers: { authorization: 'Bearer control-secret' } })).status).toBe(204);
    await closeHttpServer(daemon);
  });
  vi.mocked(startDaemonRuntime).mockResolvedValue({ server: daemon, url: `http://127.0.0.1:${port}`, stop });
  const runtime = await startCompanyApi({ host: '0.0.0.0', port, proxyPort: 0, controlSecret: 'control-secret' });
  servers.push(runtime.modelProxy);
  proxyOrigin = `http://127.0.0.1:${(runtime.modelProxy.address() as { port: number }).port}`;
  expect(startDaemonRuntime).toHaveBeenCalledWith({ host: '0.0.0.0', port, openBrowser: false, logListening: true });
  const registration = await fetch(`${proxyOrigin}/control/leases`, {
    method: 'POST', headers: { authorization: 'Bearer control-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'job', projectId: 'own', token: 'task', agentId: 'codex', model: 'm', baseUrl: 'https://example.test/v1', apiKey: 'provider-secret', protocol: 'openai', expiresAt: Date.now() + 60_000 }),
  });
  expect(registration.status).toBe(201);
  const response = await fetch(`${proxyOrigin}/od/api/projects/own/files`, { headers: { authorization: 'Bearer task' } });
  expect(await response.json()).toEqual({ path: '/api/projects/own/files', authorization: 'Bearer task' });
  expect((await fetch(`${proxyOrigin}/od/api/projects/other/files`, { headers: { authorization: 'Bearer task' } })).status).toBe(403);
  await Promise.all([runtime.stop(), runtime.stop()]);
  expect(stop).toHaveBeenCalledOnce();
  expect(runtime.modelProxy.listening).toBe(false);
});

it('does not start the daemon if the embedded proxy cannot bind its port', async () => {
  const port = await listen(createServer(), '0.0.0.0');
  await expect(startCompanyApi({ host: '0.0.0.0', port: 7456, proxyPort: port, controlSecret: 'control-secret' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(startDaemonRuntime).not.toHaveBeenCalled();
});

it('releases the proxy listener if daemon startup fails', async () => {
  const reservation = createServer();
  const proxyPort = await listen(reservation);
  await closeHttpServer(reservation);
  vi.mocked(startDaemonRuntime).mockRejectedValue(new Error('daemon failed'));
  await expect(startCompanyApi({ host: '0.0.0.0', port: 7456, proxyPort, controlSecret: 'control-secret' })).rejects.toThrow('daemon failed');
  const replacement = createServer();
  servers.push(replacement);
  replacement.listen(proxyPort, '127.0.0.1');
  await once(replacement, 'listening');
  expect(replacement.listening).toBe(true);
});

it('requires the proxy management secret before starting either listener', async () => {
  await expect(startCompanyApi({ host: '0.0.0.0', port: 7456, proxyPort: 0, controlSecret: '' })).rejects.toThrow('control secret');
  expect(startDaemonRuntime).not.toHaveBeenCalled();
});
