# Multi-relay and parallel generation follow-up

Status: implementation authorized 2026-11-02. Specification: the user's current
conversation and `nexus-model-providers.md`. Google/Azure/Bedrock native protocol
expansion is explicitly deferred. SQLite, LDAP, roles, project isolation and the
four installed Agents remain in place.

UI revision, 2026-11-02: the user subsequently chose to restore the original
provider-form interaction without saved-record management controls. The UI
selector/New/Rename/Delete requirements below are historical and superseded by
`nexus-model-providers.md`. Preserve existing provider data and managed routing.

## Global Constraints

- Work in the existing checkout. Never commit, push, create branches/tags, reset,
  or discard existing changes. Server 43 and unrelated services stay untouched.
- Reuse the original CLI/API settings renderer, presets, form controls, model
  picker, runtime definitions and scoped executor/proxy. No replacement page or
  built-in gateway brands. Secrets stay server-only; blank keys retain values.
- Add the controls needed for multiple saved relays. Selecting a saved relay or
  browsing presets edits a draft, without activating or overwriting another
  relay. Test/Agent selection applies a compatible explicit provider ID.
- Queue policy: global 1–12, per-user 1–global, per-project exactly 1. Preserve
  legacy code defaults 2/1/1. Deploy 18 explicitly with global 12 and per-user 12.
- Native admission requires actual file creation by the selected installed Agent
  through the same scoped proxy/executor. Generic protocol checks discover
  candidates, and do not establish native file-write capability.
- Preserve provider revisions for active/unfinished jobs. Deletion is denied
  while a relay is active or referenced by unfinished jobs. Existing working
  active routes remain usable across migration until explicitly changed/tested.
- New user-visible operations share the existing admin HTTP endpoints and od CLI
  JSON surface. Retain administrator/CSRF checks and ordinary-member restrictions.
- Red tests precede behavioral changes. Focused tests only; guard and root
  typecheck before deployment. Never run full web/daemon suites here.
- Keep changes surgical. Do not rewrite unrelated existing cloud/brand tests to
  manufacture a green suite. Record existing baseline failures honestly.

## Task 1: Configurable per-user parallel queue

Read the root/apps instructions. Do not dispatch subagents or mutate Git.
Owned files: `apps/daemon/src/company/job-queue.ts`, its tests,
`apps/daemon/src/server.ts` queue-construction block ONLY,
`deploy/company/compose.yml`, `deploy/company/README.md`. Other implementation
tasks are sequential. Do not edit model contracts, model settings or UI files.

Implement configurable per-user concurrency alongside global concurrency, retaining
the fixed single logical task per project. Validate safe integer global 1–12,
perUser 1–global, perProject 1. Preserve default global 2/perUser 1. In SQL, count
running tasks for the queued user's ID; do not retain the current blanket
same-user NOT EXISTS predicate. Preserve transactional claim, fairness, durable
recovery, deduplication and lease retention across physical runs.

Wire `OD_COMPANY_MAX_JOBS_PER_USER` (default 1) through the existing server setup;
Compose takes it from `NEXUS_MAX_JOBS_PER_USER` with default 1. Existing global
`NEXUS_MAX_JOBS`/`OD_COMPANY_MAX_JOBS` defaults stay 2. Production activation is
performed later by the controller with both values explicitly 12. Document the
parameters and use the root data-directory contract without new path examples.

TDD: one user across 12 independent projects can claim all 12; the 13th waits;
a second task in a running project waits even when user/global capacity remains;
per-user 2/global 3 admits another user while excess jobs for the first wait;
invalid/fractional/out-of-range quotas reject; default behavior and restart,
cancel/revocation/strategy continuation tests remain passing. Run focused queue,
dispatcher and configuration/deployment tests relevant to the edit, not full suites.

Write `task-1-report.md` beside the brief: status, files changed, red/green command
evidence and counts, self-review, concerns. Do not commit or touch remote servers.

## Task 2: Saved relay management and unambiguous binding

Read root/apps/packages guidance. Do not dispatch subagents or mutate Git.
Owned source: company-model contracts, company model store/routes/CLI, company
web model hook, a small company relay control if useful, existing SettingsDialog
integration and company CSS/i18n/tests. Native probe and queue code are not owned.
The original API form/presets/model selector continue to render and edit fields.

Add a saved-relay selector and New/Rename/Delete actions in the API area, with a
name field or equivalent inline rename. Reuse original controls/confirmation UI.
Gateway names belong to saved custom records, never built-in presets. New clears
the editor and uses a distinct new-draft identity. Selecting an existing record
hydrates the original form with a blank key/configured indicator and does not
save or activate. Existing edits bind by immutable provider ID, including URL/key
changes. New records must not overwrite another record with the same URL or
model ID. Preserve other unsaved provider key drafts and owner/async guards.

Store an optional original-form API protocol hint (`apiProtocol`) on providers,
retaining legacy records/keys/revisions without destructive migration. Protocol
is configuration format, not a gateway brand. Continue separate wire-protocol
capabilities. Legacy records may infer the form from active/capability evidence.
Name-only edits must not unnecessarily invalidate connection evidence; routing,
key, model or output-cap edits retain immutable revision behavior.

Prefer an explicitly selected compatible provider, then the current active
compatible provider when selecting an Agent/model; do not resolve solely by
model ID or fall back to an older matching record. Tests must pin a pair of
distinct relay IDs sharing the exact same model ID, including the already
captured reproduction in `apps/web/.tmp/gaps.test.tsx`. Failed activation keeps
the prior In use marker/active URL. API Test applies its selected record.

Add admin DELETE `/api/company/models/providers/:id`, optimistic revision/CSRF
protected. Reject active or unfinished-job-referenced records with a useful 409;
after a switch/completion deletion succeeds and cannot damage surviving routes.
Mirror in `od company models provider-delete --prompt-file <path|-> --json`.

TDD covers two same-model relays, two same-URL/different-key relays, New vs edit,
selection/no-op navigation making no writes, wrong-owner async completions,
blank-key retention, name change, history, safe deletion, permissions, CLI parity,
and using the existing API form/model picker. Replace the superseded URL/model
selection heuristics and remove imports/state made redundant by this change.
Do not build a second settings page or change ordinary app mode behavior.

Write `task-2-report.md` beside the brief with red/green evidence, tests and concerns.

## Task 3: Native file-write admission

Read root/apps/packages instructions. Do not dispatch subagents or mutate Git.
Owned source: company capability contracts/helpers, native-model-probe,
model-settings test/activation orchestration, minimal hook request/compatibility
changes and their tests. Reuse the provider management and ID binding from Task 2.

Extend native validation to Codex, Claude Code, OpenCode (both OpenAI wire modes
and Anthropic where the gateway accepts it), DeepSeek Harness. Reuse installed
runtime definitions/stream framing/ACP helpers wherever applicable. Use the same
scoped lease, executor image, model and pinned protocol as ordinary jobs; never
inject real keys into an Agent HOME/container or leak stdout into diagnostics.

A disposable workspace begins without the output file. Ask the actual Agent to
create a UTF-8 file with a fresh nonce, and validate its real contents after a
successful process. Reject missing, incorrect, redirected/symlink, unsuccessful,
truncated, oversized, canceled or timed-out outcomes. Bound capture/time and
always stop/revoke/remove only owned probe resources. Original CLI definitions
must not be rewritten just for tests. DSH uses its existing versioned profile JSONL
transport and `agent-protocol/dsh-profile` framing/session helpers (not the separate
ACP family).

Keep generic protocol evidence as candidate discovery. Persist Agent-specific
evidence with `testedBy: <agentId>` and `verification: 'file-write'`; native
failure for an Agent/protocol takes precedence over generic success for that
Agent. Different Agents' evidence must not authorize each other. Preserve other
Agents' evidence when testing one model/Agent. Test accepts the selected Agent
and protocol; activation requires fresh corresponding file-write evidence.
Legacy evidence does not count as file-write proof, but do not invalidate or
destroy an already active/queued route on startup. Refresh when it is selected
or explicitly tested. CLI and UI use the same server operation.

TDD includes false success with no file, text-only nonce, wrong contents/path,
real file-write success, protocol and Agent separation, cleanup/error paths,
old evidence refresh, evidence preservation and failed activation retention.
Run relevant focused tests. Write `task-3-report.md` beside the brief.

## Task 4: Integration, documentation and real 18 acceptance

Controller-owned after task reviews. Synchronize existing docs with the unified
model store, explicit provider IDs, API/CLI operations and concurrency policy.
Keep deferred protocols and pre-existing test-environment limits explicit.

Run focused integration/access/UI tests, guard, root typecheck and production
builds; obtain an independent final review. Back up protected runtime/config,
preserve existing providers/users/projects, and deploy only 18. Explicitly set
global 12 and per-user 12 in the private environment, with rollback if validation
fails. Verify the compiled sources/containers match the worktree, not Git HEAD.

Browser acceptance: add/select/rename/delete only owned temporary relays; same
model ID on different relays stays bound to the chosen ID; configured keys stay
blank; presets retain original behavior; active marker and URL are accurate on
both tabs and mobile; ordinary LDAP member remains restricted. Verify native
write tests and real generation/continuation for available configured Agents.

Run twelve real independent projects concurrently under one LDAP account using
the currently configured working model, capture actual simultaneously running
job containers/queue states, output markers and errors. Verify the global/per-user
ceiling and same-project serialization. Distinguish real model/CLI execution from
mock tests. Restore the original active model/relay, remove only owned QA records
and test artifacts, leave two resident Nexus containers and no historical/finished
job containers, preserve unrelated services and private backups. No Git writes.
