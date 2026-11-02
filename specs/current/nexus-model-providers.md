# Shared providers and managed agent activation

Status: implementation authorized, 2026-10-31. The user's approved conversation
plan is the specification. Applies to optional company mode on server 18. Server
43 stays unchanged. Leave changes uncommitted until explicit user approval.

## Behavior

Administrators configure each provider URL/key/models once. Agent adapters select
Responses (Codex), Anthropic Messages (Claude Code), or Chat Completions
(DeepSeek Harness). OpenCode reuses the original BYOK profile builder for all
three wire protocols. Agent capabilities are protocol sets; retain a compatible
active protocol when switching agents, otherwise select a verified supported
protocol. Detect actual model protocol, streaming and tool-call
support; do not translate incompatible protocols. A model list is only a list of
candidates. Unsupported or unavailable protocols give an explicit status.
When no model preference exists for an Agent, prefer its own native validation
over a different model's generic protocol proof. Protocol support alone does not
establish native editing behavior for every model behind a third-party gateway.

Some Anthropic gateways accept only genuine Claude Code requests. Validate the
selected installed Agent through the same scoped proxy and isolated executor.
The disposable workspace starts without its output file; the Agent must create
the requested nonce file and exit successfully. Missing, wrong, symlinked,
oversized or timed-out output cannot establish file-write capability. Generic
protocol tests discover candidates; new activation requires fresh native
`verification: file-write` evidence scoped to the selected Agent and wire
protocol. Preserve other Agents' evidence, and let a native failure override a
generic success for that Agent. Existing active and queued routes survive a
restart until explicitly revalidated or changed. Forward the native client's
harmless identification headers; never fabricate client identity or forward its
task credentials upstream. Real provider keys remain in the proxy.

The original API settings UI is the only provider configuration surface: original
presets and Custom, with centrally saved keys/models. The user's 2026-11-02
revision restores the upstream interaction and removes the additional saved-record
selector and New/Rename/Delete controls. Existing records, keys and the effective
route remain intact; backend and CLI record management remain available. Gateway
names remain private record metadata, never built-in presets. Unknown gateway
URLs remain Custom. Original preset browsing is read-only. Edits bind to immutable
provider IDs. A
name-only edit retains connection evidence; routing/key/model/output-cap edits
preserve old revisions for pinned work. The original Test saves and probes, then applies the
selected Agent only when compatible. Selecting an Agent/model adapts to compatible
configured models and applies through the same guarded backend. Refresh stale
native evidence when required; failed or incompatible requests retain the prior
route. Explicit compatible relay selection takes precedence, followed by the
compatible active relay; a shared model ID cannot choose an older relay. Only a
tested compatible installed Agent/provider/model can become active.
The minimal effective badge lives in the original active CLI card and comes from
server state, survives restart, and is separate from draft intent. Members cannot
configure providers or see Agent identity in chat.

Opening settings, switching panes, and browsing provider presets are read-only.
Reuse the original provider draft restoration for redacted server records; a
configured blank key keeps its stored value. Only real preference or provider
edits enter autosave, and provider edits do not write unrelated app preferences.

An immutable non-secret route reference pins each submitted job, including queued
work. Provider revisions needed by unfinished jobs remain resolvable. Real keys
stay in the protected company configuration and scoped model proxy, outside job
containers, public run payloads, logs and browser storage. Native sessions stay
scoped by agent; use existing text-context recovery across agent changes.

## Boundaries

Use shared contracts in packages/contracts. New policy/store/probes/routes live
under apps/daemon/src/company. Reuse the original SettingsDialog CLI/API renderer,
BYOK presets, Custom provider, model picker and test interactions; a small company
controller supplies server data/actions. Remove the replacement settings page and
its orphan styles/copy. Unknown gateway URLs remain Custom, never built-in presets.
Reuse the
existing company HTTP gate, proxy, queue and two resident containers. UI and od
CLI use the same administrator endpoints. Follow root AGENTS.md's Daemon data
directory contract for all managed data paths. SQLite ownership/auth tables stay
unchanged. Keep upstream application hooks small and non-company behavior intact.

Approved follow-up (2026-11-01): reuse the original per-protocol model catalog
URLs, authentication and parsing with bounded response reads. The catalog request
carries the original form's protocol; real keys still come only from the server.
Retain native OpenCode session handling and use the pinned route's exact wire
protocol for its run-scoped SDK profile. No Agent version upgrade, replacement UI
or protocol translation. Google/Azure discovery behavior remains the original
behavior; additional native execution protocols are outside this follow-up.

Migrate the current explicit legacy agent/provider/model on first startup and
retain its active route as migrated/unverified until tested. Preserve legacy
configuration for rollback; use the unified store as the sole managed routing
authority thereafter. Public provider responses contain hasApiKey, never a key.
Original optional output-token limits belong to private provider revisions and
are enforced by the native proxy field. Original reasoning/service-tier settings
remain nonrouting preferences; the old app-config writer cannot activate a route.

## HTTP and CLI

GET /api/company/models returns redacted providers, effective route and installed
agent summaries. PUT /api/company/models/providers saves a draft with an optimistic
expectedRevision. DELETE /api/company/models/providers/:id uses the same optimistic
revision and denies active or unfinished-job references. POST
/api/company/models/test carries the selected Agent/protocol and verifies native
file creation in addition to candidate protocol discovery. POST
/api/company/models/activate activates only a tested
compatible combination. POST /api/company/models/catalog lists candidate models
(manual model IDs remain supported). Every mutation is administrator/CSRF gated.
od company models mirrors these operations, including provider-delete, and
supports --json / --prompt-file.

## Acceptance

Focused tests cover migration, secrets/redaction, revisions, failed tests retaining
active configuration, per-model protocol capability, streaming/tool calls,
revision conflicts, queue snapshots, member denial, CLI parity and persistent UI
badges. Deploy to 18 after focused checks, guard, typecheck and builds. Validate
LDAP/admin roles and real generation/continuation with every actually supported
agent; show honest incompatibility for unsupported combinations. Preserve business
projects, clean only owned test artifacts, and leave no historical project or
job containers. Roll back image/configuration if health or generation fails.

Effective-state visibility (2026-11-02): retain the original settings layout and
controls. Clearly mark the effective Agent card with In use, and show its Agent,
model and provider URL in both CLI/API tabs. Derive the URL from the pinned active
provider revision, including retained history, never from an edited provider
draft. A failed activation leaves the effective marker unchanged. Connection
test feedback describes a test result separately from the effective state.
