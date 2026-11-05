import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeCompany } from '../../src/company/routes.js';
import { companyTestDatabase } from './database.js';

afterEach(() => { vi.unstubAllEnvs(); });

it.each(['', '59', '601', '60.5', '60.0', '1e2', 'NaN', 'Infinity', '-60', ' 60 '])('refuses company initialization with invalid signature window %j', async value => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'integration-config-'));
  const database = companyTestDatabase();
  vi.stubEnv('OD_COMPANY_INTEGRATION_SKEW_SECONDS', value);
  try {
    await expect(initializeCompany({ dataRoot, database })).rejects.toThrow('OD_COMPANY_INTEGRATION_SKEW_SECONDS must be an integer from 60 to 600');
    // Startup stops before constructing the user/session store.
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='company_users'").get()).toBeUndefined();
  } finally { database.close(); rmSync(dataRoot, { recursive: true, force: true }); }
});
