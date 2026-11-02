import { expect, it } from 'vitest';
import { deriveTabIdentityScope, UNSET_ACCOUNT_BUCKET } from '../src/collab/tab-scope';

it('partitions company tabs by authenticated user without waiting for cloud status', () => {
  const alice = deriveTabIdentityScope({ companyUserId: 'alice', amrLoginStatus: null, workspaceContext: null, workspaceContextLoading: true, previousWorkspaceBucket: 'old-cloud-workspace', previousAccountBucket: UNSET_ACCOUNT_BUCKET });
  expect(alice.scopeKey).toBe('company:alice::none');
  const bob = deriveTabIdentityScope({ companyUserId: 'bob', amrLoginStatus: null, workspaceContext: null, workspaceContextLoading: true, previousWorkspaceBucket: alice.nextWorkspaceBucket, previousAccountBucket: alice.nextAccountBucket });
  expect(bob.scopeKey).toBe('company:bob::none');
  expect(bob.scopeKey).not.toBe(alice.scopeKey);
});
