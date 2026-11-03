# Self-hosted teams and external project integration

## Ownership and compatibility

The optional `teams.enabled` feature adds native teams to company deployments.
Each design has either its existing personal ACL or a `companyTeamId`, never both.
Team designs inherit owner/admin/editor/viewer permissions. Copies stay in their
source team. Existing personal designs, model settings and agent execution remain
unchanged. Team administration does not confer platform administration.

Team files, conversations, generation history, previews and authenticated exports
share the same central authorization boundary. Permission loss uses existing
revocation/dispatcher cancellation and container cleanup. Quotas still aggregate
globally and by user, independently of team membership.

Native team members are registered platform users. Linked team membership is a
read-only projection of its external source. LDAP identities use entryUUID;
username collisions fail rather than linking identities by name.

## HTTP and CLI

- `/api/company/teams`: GET list, POST create.
- `/api/company/teams/:id`: GET team and members, PATCH name/status (native only).
- `/api/company/teams/:id/members`: PUT userId and admin/editor/viewer role.
- `/api/company/teams/:id/members/:userId`: DELETE native non-owner membership.
- Existing project create accepts `companyTeamId`; project responses return it.
- `od company team list|get|create|update|member-set|member-remove` mirrors these
  endpoints. Create/update accept JSON through `--prompt-file <path|->`.
- `od project create --team <id>` and `od project list --team <id>` select a team.

## Integration protocol v1

Configure an allowlisted client ID, fixed source authorization URL and a shared
secret of at least 32 characters. Integration requires company LDAP and teams.
The integration is disabled by default. The company compose deployment passes
`NEXUS_INTEGRATION_SECRET` for environment substitution; no secret is committed.
Daemon-managed persistence follows the root AGENTS.md data-directory contract.

Service endpoints under `/api/company/integrations/:clientId`:

- GET `teams` returns mappings with teamId, namespace, externalId, revision.
- POST `teams` accepts a complete snapshot plus namespace/externalId and
  expectedRevision (0 for creation). The contract is `CompanyTeamSyncRequest`.
  Conflicts return 409. Clients re-read the target revision **before** re-reading
  source state, then retry. Never publish a partial roster or interpret a source
  outage as an empty roster.
- POST `codes` accepts state, teamId, entryUUID and issues a single-use code.

Signed requests use `x-nexus-timestamp` (milliseconds), `x-nexus-nonce` (16–128
base64url characters), and `x-nexus-signature` (lowercase hex HMAC-SHA256).
The signed UTF-8 string is:

```
METHOD\nrequest-target\ntimestamp\nnonce\nsha256(body)
```

GET body is empty. POST body is `JSON.stringify(parsed JSON)` in insertion order,
as serialized by the source JavaScript adapter. Timestamp tolerance is 60 seconds;
nonces are persisted for five minutes and cannot be replayed. Clients reject
redirects and never forward browser cookies or the shared secret itself.

Browser entry starts at GET `start?namespace=...&externalId=...`. The target creates
a 120-second state bound to an HttpOnly browser cookie, then redirects to the
fixed source authorization URL with instance_id, team_id and state. The source
validates its own LDAP session and effective project membership, refreshes the
snapshot, requests a 60-second code, and redirects to `callback?state=...&code=...`.
The target atomically consumes it, verifies LDAP by immutable entryUUID, rechecks
team access and issues its own session before redirecting to `/teams/:id`.
Callback responses are no-store/no-referrer. Passwords and lasting credentials
do not travel through browser URLs. This internal handoff is not an OAuth/OIDC
provider. Both applications retain independent sessions and logout behavior.

## Synchronization, rollout and rollback

Cbrain owns linked teams and effective roles: owner → owner, admin → admin,
member → editor, reviewer → viewer. Source-local accounts cannot impersonate the
reserved target admin. First entry provisions a mapping; the source then syncs
known mappings every 60 seconds and refreshes on entry. Snapshots are transactional.
Confirmed permissions expire after five minutes without successful synchronization;
reads and writes fail closed and the existing dispatcher cancels revoked jobs.
Native teams and personal projects are unaffected by source outages.

Source archival makes designs read-only; deletion disables member access without
deleting files or history. Platform administrators retain recovery visibility.

Deploy additive schema/authorization first, then the source internal export,
Panel adapter and project button. Enable integration only after both are ready.
Back up SQLite and configuration using the resolved daemon data root. Rollback
disables integration entry and restores binaries; retain additive tables. Team
designs have no personal ACL rows, so older binaries deny ordinary-user access
rather than silently granting the creator private ownership.
