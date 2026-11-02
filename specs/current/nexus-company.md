# NexusDesign company deployment

Status: implemented, deployed and verified on 2026-10-31, including real employee
LDAP password login, generation and member/administrator role transitions.

## Boundaries

Keep SQLite and upstream agent protocols. Company policy is injected at HTTP,
project ownership and execution boundaries. New daemon data follows the root
AGENTS.md **Daemon data directory contract**. No directory or LDAP credentials
belong in this document or Git.

* Configurable local/LDAP authentication, one login form, reserved local admin.
* LDAP service search then user bind; escaped uid filter, entryUUID identity,
  first-login provisioning, no directory writes or stored employee passwords.
* Private projects; owner/editor/viewer; audited administrator access.
* HTTP intranet deployment with HttpOnly/SameSite cookies, Origin and CSRF
  checks, revocable sessions. Company mode cannot silently become anonymous.
* Company sign-in reuses the existing split onboarding layout and painting;
  its left pane provides username/password login and language selection.
* Administrator-owned agent/model configuration; members cannot override it.
* Preinstall Claude Code, DeepSeek Harness plus companion profile, OpenCode,
  Codex. Kimi/Qwen adapters remain upstream but are not preinstalled.
* Hide assistant agent header rows and labs/integrations navigation without
  changing continuation layout, progress rendering or internal MCP.
* Container execution isolates project files and runtime homes. Real provider
  credentials stay outside execution containers behind a job-scoped proxy.
* Two persistent containers: the API hosts the model proxy in its Node process;
  the separate executor alone receives the Docker socket. The API also joins
  the internal job network so jobs can reach the scoped proxy. Only the web/API
  port is published. Proxy startup precedes queue recovery; shutdown follows
  daemon task cleanup. Deployment removes the former proxy service container.
* Persistent queue defaults: global 2, user 1, project 1. Global concurrency is
  configurable from 1 through 12, and per-user concurrency from 1 through global;
  project concurrency remains exactly 1. The approved deployment on18 explicitly
  opts into global12/user12. Hold project leases across the entire logical turn.
  Never automatically replay interrupted writes.

## Interfaces

Company session/auth/users/project-members and model HTTP endpoints carry shared
contracts and have web and od CLI surfaces. The private unified company model
store owns managed routing and immutable provider revisions. Existing app-config
retains ordinary nonrouting preferences; its writer cannot activate a route.
Authentication secrets remain separate backend-only configuration. See
`nexus-model-providers.md` for saved-relay management and native admission.

## Delivery

Deploy a clean instance to the user-designated server 18 on HTTP port 7456.
Server 43 and unrelated services stay intact. Commit and push only after the
user's explicit confirmation, and only to the user's fork.
First verify focused tests, guard, typecheck, login/ACL, real default Codex
generation/continuation/preview/export, queue/revocation and offline startup.
The current follow-up verifies twelve independent projects generating under one
LDAP account, including observed queue/container overlap, the thirteenth waiting,
resource use and actual generated files. Rollout evidence is recorded after the
checks complete; historical multi-user load results are not this acceptance run.

## Acceptance evidence

* Focused daemon checks: all 66 company tests passed; the existing run module's
  88 tests passed in isolation. A wider check passed 200 tests with 8 platform
  skips, but repeated Windows runs exposed intermittent existing durable-write
  assertions; their failed logs are retained. Production uses native SQLite on
  Linux; HTTP permission checks exercised that database. Company
  UI/share-history/media polling and memory checks: 61 passed.
  Repository guard and full typecheck passed.
* Real service search, user-password bind and application login succeeded with
  the configured people base, user filter and entryUUID. Transport regressions
  cover plain LDAP, LDAPS and StartTLS; TLS options are supplied only for LDAPS.
* Actual browser role promotion and demotion succeeded on an isolated instance
  using the real directory identity. Each change invalidated old sessions;
  administrator configuration became available only after an administrator
  login and disappeared after demotion. The production identity retained its
  member role throughout the test. The users dialog exposes the existing role
  update endpoint while protecting the current and reserved administrator.
* First-project browser coverage includes empty attachments before directory
  materialization, clearing the consumed prompt, waiting for project creation
  before membership lookup, and conversation message persistence during a run.
  Generated conversation/project names may sync during execution; filesystem and
  host-path changes remain denied while the project is executing.
  Global memory and unsupported media-task observers stay dormant for members.
  A fresh real LDAP browser run completed generation and HTML preview with no
  normal-flow HTTP 4xx/5xx requests after these changes.
* Production default Codex configuration was copied privately from server 43.
  Real generation, sandbox preview interaction, HTML/ZIP export and two-turn
  chat-only memory verification succeeded.
* Isolated same-host HTTP permission checks: 28 passed, covering private projects,
  owner/editor/viewer permissions, managed model enforcement, scoped preview
  resources and immediate session/membership revocation.
* Real owner/viewer/admin browser flows passed: restricted settings, member
  sharing, read-only preview, ZIP export and logout. Normal flows had no failed
  requests or console errors. An automation-only blob-save cancellation remained;
  the browser archive response was a valid ZIP with HTTP 200.
* Graceful Docker restart: 10 checks passed after reproducing and fixing queued
  run cancellation. Running work was interrupted without replay; queued work
  resumed, generated its marker and left no job containers.
* Account-disable execution revocation: 9 checks passed. Running and queued jobs
  and their durable/public run records all became canceled, old sessions failed,
  queued work never started and no orphan containers remained.
* Isolated same-host generation: 12 users and 12 projects succeeded concurrently;
  actual running job-container peak was 12. Tasks took 24.295–34.519 seconds
  (median 27.738 seconds). This is a measured acceptance run, not a guarantee of
  provider capacity. Production retains the configurable default limit of 2.
* Existing SettingsDialog execution and ChatPane streaming files retain 25 and
  4 failing brand/cloud/updater expectations respectively. Isolated unchanged
  HEAD source/tests had 26 and 6 failures; every current failure also occurs
  there. These unrelated failures were retained rather than rewriting their
  assertions during this change.

Raw reports, build logs and browser captures are local ignored verification
artifacts. Passwords, provider keys, sessions and private deployment configuration
are excluded from Git.
