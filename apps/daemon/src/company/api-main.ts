import fs from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeHttpServer, parseDaemonCliStartupArgs, startDaemonRuntime, type StartedDaemonRuntime } from '../daemon-startup.js';
import { createCompanyModelProxy } from './model-proxy.js';

/** Trusted CLI discovery has its own home; jobs only mount project-specific homes. */
export function prepareCompanyDiscoveryHome(dataRoot: string, profileSource: string): NodeJS.ProcessEnv {
  if (!path.isAbsolute(dataRoot)) throw new Error('Company runtime requires an absolute OD_DATA_DIR');
  fs.mkdirSync(dataRoot,{recursive:true});
  const home = path.join(fs.realpathSync(dataRoot),'company-discovery-home');
  const env = {HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),DSH_HOME:path.join(home,'.dsh'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local','share')};
  for (const directory of Object.values(env)) fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const profile = path.join(env.DSH_HOME,'profiles','open-design');
  if (!fs.existsSync(path.join(profile,'package.json'))) {
    fs.mkdirSync(path.dirname(profile),{recursive:true});
    fs.cpSync(profileSource,profile,{recursive:true,verbatimSymlinks:true});
  }
  return env;
}

/** The proxy shares the API process; Docker management remains in the executor. */
export async function startCompanyApi(options: {
  host: string;
  port: number;
  proxyPort: number;
  controlSecret: string;
  openBrowser?: boolean;
}): Promise<StartedDaemonRuntime & { modelProxy: Server }> {
  const host = ['0.0.0.0', '::'].includes(options.host) ? '127.0.0.1' : options.host;
  const modelProxy = createCompanyModelProxy({
    controlSecret: options.controlSecret,
    daemonOrigin: `http://${host.includes(':') ? `[${host}]` : host}:${options.port}`,
  });
  const closeProxy = async () => { modelProxy.closeAllConnections(); await closeHttpServer(modelProxy); };
  try {
    modelProxy.listen(options.proxyPort, '0.0.0.0');
    await once(modelProxy, 'listening');
    const runtime = await startDaemonRuntime({ host: options.host, port: options.port, openBrowser: options.openBrowser ?? false, logListening: true });
    let stopping: Promise<void> | undefined;
    return {
      ...runtime,
      modelProxy,
      stop: () => stopping ??= (async () => {
        try { await runtime.stop(); }
        finally { await closeProxy(); }
      })(),
    };
  } catch (error) {
    await closeProxy();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.OD_COMPANY_MODE !== '1' || !process.env.OD_DATA_DIR) throw new Error('Company API requires an explicit runtime configuration');
  Object.assign(process.env,prepareCompanyDiscoveryHome(process.env.OD_DATA_DIR,'/opt/company-profile'));
  const parsed = parseDaemonCliStartupArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.kind === 'error') { console.error(parsed.message); process.exitCode = 2; }
    console.log('Usage: nexus-design [--host <address>] [--port <port>] [--no-open]');
  } else {
    const runtime = await startCompanyApi({
      host: parsed.config.host, port: parsed.config.port, openBrowser: parsed.config.open,
      proxyPort: Number(process.env.OD_COMPANY_PROXY_PORT ?? 7458),
      controlSecret: process.env.OD_COMPANY_PROXY_CONTROL_SECRET ?? '',
    });
    let shuttingDown = false;
    const stop = () => {
      if (shuttingDown) process.exit(0);
      shuttingDown = true;
      void runtime.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
