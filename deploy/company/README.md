# NexusDesign company deployment

This optional deployment keeps SQLite and existing agent protocols. Runtime data
and configuration follow the root [daemon data directory contract](../../AGENTS.md#daemon-data-directory-contract).
The ordinary single-user deployment remains separate.

## Configuration

Create a private `.env.company` for Compose with `NEXUS_DATA_ROOT` (the explicit
absolute runtime data root), `NEXUS_VERSION`, random `NEXUS_EXECUTOR_SECRET` and
`NEXUS_PROXY_SECRET`, `NEXUS_DOCKER_GID`, and `NEXUS_LDAP_BIND_PASSWORD`.
Keep the file mode `0600`; never commit it. Set `NEXUS_MAX_JOBS` for the global
limit (default 12, positive safe integer) and `NEXUS_MAX_JOBS_PER_USER` for each user's limit
(default 3, positive safe integer up to the global limit). Compose passes these as `OD_COMPANY_MAX_JOBS` and
`OD_COMPANY_MAX_JOBS_PER_USER` respectively; direct daemon starts use those same
defaults. Invalid quotas reject startup. Each project always holds at most one
logical task, including its follow-on physical runs. Tasks above a user's quota
remain queued while other eligible users can use the remaining global slots.
If the global limit is configured below 3, configure the per-user limit as well.

`OD_COMPANY_INTEGRATION_SKEW_SECONDS` controls the server-to-server signed request
window (default 60 seconds, integers from 60 to 600 only); invalid values reject
API startup. Set it in the private Compose env file when servers have known clock
skew. Only the API consumes it. Nonces remain reserved for twice that window plus
60 seconds (1260 seconds with a 600-second window). Browser login state and
one-time authorization-code lifetimes are unchanged.

Adapt `company.example.yaml` to the deployment and install it as the backend
`company.yaml` configuration. Match `server.public_origin` to the actual browser
origin, including the port. YAML environment substitution accepts only `NEXUS_*`
variables. `local` and `ldap` are backend choices; the login form does not select
a provider. A provider configuration change invalidates existing sessions.

LDAP uses a service lookup and a user password bind, provisions local identities
after successful login, and never writes the directory. An `entryUUID` is
required. The reserved platform administrator `admin` authenticates locally.
The initial random password is delivered through the private bootstrap file;
first login requires a password change. Restarting does not reset that account.

HTTP cookies work without TLS, but HTTP and plain LDAP do not encrypt traffic.
Use this configuration within the intended intranet. Changing the public origin
to HTTPS enables Secure cookies without changing business code.

## Build and start

Build each target from the repository root; replace `VERSION` consistently:

```sh
docker build --force-rm -f deploy/company/Dockerfile --target api -t nexus-design:VERSION .
docker build --force-rm -f deploy/company/Dockerfile --target agent -t nexus-design-agent:VERSION .
docker build --force-rm -f deploy/company/Dockerfile --target executor -t nexus-design-executor:VERSION .
docker compose --env-file .env.company -f deploy/company/compose.yml up -d --remove-orphans api executor
```

The two persistent containers are `nexus-design` (web/API, SQLite and scoped
model access in one Node process) and `nexus-design-executor` (job container
management). Only port 7456 is published; the embedded model proxy listens on
the internal port 7458. Active jobs create temporary
`nexus-design-job-*` containers with `--rm`; completed jobs leave no containers.
The execution manager also enforces each supplied deadline independently of the
API connection. Logical generation leases last at most two hours; native model
checks use their shorter probe deadline. Abnormal client exits trigger an
explicit container removal. Failed removals are retried and suspend new launches
until recovery. A logical task's quota is released only after its credentials
are revoked and its remaining containers have been removed.
On restart, owned containers and staged prompt files are cleared; project files
and CLI session state are retained. Previously running jobs become interrupted,
while admitted queued jobs remain eligible to resume.
The `company` source directory is the optional self-hosted authentication and
isolation integration, not a second project system.

Images can be built on a connected machine and transferred with `docker save`
and `docker load`. Startup does not install CLIs. The image manifest pins Claude
Code, Codex, OpenCode and DeepSeek Harness with its companion profile. Installation
and protocol availability do not imply that provider credentials are configured.
Administrators use the original API settings form to configure providers once.
The original Test validates native streaming/tool calls and applies a compatible
selected Agent. Selecting an Agent or model uses compatible configured models;
failed or incompatible requests retain the previous effective configuration.
The original CLI card indicates which configuration is effective. That state is
stored by the backend; queued and running jobs retain their submitted provider
revision. Existing explicit configuration is imported once as unverified and
retained for rollback. Provider keys stay outside job payloads and public APIs.
`NEXUS_API_PIDS_LIMIT` defaults to 1024 because concurrent CLI discovery can
create several hundred threads on large hosts. The limit includes threads;
setting it below the measured discovery peak can prevent task startup with
`spawn EAGAIN`. Executor and isolated job limits are configured separately.

The API has no Docker socket. The authenticated execution manager accepts only
the fixed agent image and current project/home mounts. Jobs use an internal
network and short-lived model/tool credentials. The model proxy stores actual
provider keys outside jobs. The proxy starts before daemon queue recovery and
stops after daemon task cleanup. Queued turns survive restart; previously running
turns are interrupted rather than automatically replayed. Account disable and
permission revocation cancel affected work; browser logout only closes sessions.

Ordinary users have private projects and owner/editor/viewer sharing. Global
installation, host-folder access and configuration remain administrative. Standard
sandbox previews are used on the remote HTTP origin. Untrusted generated HTML
cannot execute with the platform login origin. Host Git and connector refresh
sources are unavailable to company artifact jobs.

## Verification and recovery

Run focused company, run-lifecycle and UI tests, `pnpm guard`, and `pnpm typecheck`.
Then verify login, project isolation, viewer/export behavior, default-agent real
generation and continuation, preview/export, cancellation and restart on the
deployment. A real employee login is required in addition to service-bind tests.

Back up runtime data and private configuration before an upgrade. Roll back to a
compatible company image or restore the matched backup; never expose a company
database through an older server that ignores its access controls. The original
server and unrelated containers/volumes are not part of this deployment.

For automation, `od company` provides login, sessions, password, user and membership
commands with `--json`. Supply passwords with `--password-file <path|->`. An
explicit `OD_COMPANY_SESSION_FILE` authenticates existing `od` subcommands; task
tokens are limited to their current project and approved tools.

`od company models list|provider-save|test|activate|catalog` uses the same
administrator APIs as model settings. Supply mutation JSON through
`--prompt-file <path|->`; use `--json` for machine-readable results.
