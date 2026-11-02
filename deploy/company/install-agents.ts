/** Build-time only. The resulting images never invoke a package manager at startup. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const destination = '/opt/agents';
const versions = JSON.parse(fs.readFileSync('/build/deploy/company/agent-versions.json', 'utf8')) as Record<string, string>;
const dshVersion = versions.deepseekHarness!;
interface Manifest { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
async function metadata(name: string, version: string): Promise<Manifest> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  if (!response.ok) throw new Error(`Cannot resolve pinned agent package ${name}@${version}: ${response.status}`);
  return await response.json() as Manifest;
}

// dsh sibling releases peer-require the same RC. Pin the complete closure so
// npm cannot silently combine the requested CLI with a different RC's services.
const dshPackages = new Set(['@deepseek-ai/dsh']);
const overrides: Record<string, string> = {};
let pending = [...dshPackages];
while (pending.length) {
  const next = new Set<string>();
  await Promise.all(pending.map(async (name) => {
    const manifest = await metadata(name, dshVersion);
    overrides[name] = dshVersion;
    for (const [dependency, range] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (dependency.startsWith('@deepseek-ai/dsh-') && !dshPackages.has(dependency)) {
        dshPackages.add(dependency);
        next.add(dependency);
      } else if (dependency.startsWith('@deepseek-ai/') && !dependency.startsWith('@deepseek-ai/dsh')) {
        // Cordis and its plugins use stable semver, independently of dsh's RC.
        const floor = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)?.[0];
        if (floor && !overrides[dependency]) overrides[dependency] = floor;
      }
    }
  }));
  pending = [...next];
}
const dependencies: Record<string, string> = {
  '@anthropic-ai/claude-code': versions.claude!,
  '@openai/codex': versions.codex!,
  'opencode-ai': versions.opencode!,
  ...Object.fromEntries([...dshPackages].sort().map((name) => [name, dshVersion])),
};
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name: 'nexus-company-agent-tools', private: true, dependencies, overrides }, null, 2));
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit' });
const companion = path.join(destination, 'node_modules', '@open-design', 'dsh-runtime');
fs.mkdirSync(path.dirname(companion), { recursive: true });
fs.cpSync('/build/packages/dsh-runtime', companion, { recursive: true });
fs.rmSync(path.join(companion, 'node_modules'), { recursive: true, force: true });

const profile = '/opt/company-profile';
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-open-design', private: true,
  dependencies: { '@open-design/dsh-runtime': 'file:/opt/agents/node_modules/@open-design/dsh-runtime' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@open-design/dsh-runtime'] } },
}, null, 2));
fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
// The profile-local fallback exposes the repository companion; dsh maintains
// its separate installation closure in profiles/node_modules at every boot.
fs.symlinkSync('/opt/agents/node_modules', path.join(profile, 'node_modules'), 'dir');
fs.copyFileSync('/build/deploy/company/agent-versions.json', '/opt/agents/agent-versions.json');
for (const binary of ['claude', 'codex', 'opencode', 'dsh']) {
  execFileSync(`/opt/agents/node_modules/.bin/${binary}`, ['--version'], { stdio: 'inherit' });
}
fs.mkdirSync('/tmp/dsh-profile-check/profiles', { recursive: true });
fs.cpSync(profile, '/tmp/dsh-profile-check/profiles/open-design', { recursive: true, verbatimSymlinks: true });
execFileSync('/opt/agents/node_modules/.bin/dsh', ['--profile', 'open-design', '--probe'], {
  env: { ...process.env, DSH_HOME: '/tmp/dsh-profile-check' }, stdio: 'inherit', timeout: 30_000,
});
