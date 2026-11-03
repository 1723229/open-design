FROM node:24.14.1-bookworm-slim AS dependencies
ENV CI=true
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY packages ./packages
COPY tools ./tools
COPY apps/daemon/package.json ./apps/daemon/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY e2e/package.json ./e2e/package.json
COPY plugins ./plugins
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate && pnpm install --frozen-lockfile

FROM dependencies AS agent-tools
COPY deploy/company ./deploy/company
RUN pnpm --filter @open-design/dsh-runtime build
RUN --mount=type=cache,target=/root/.npm node deploy/company/install-agents.ts

FROM dependencies AS build
COPY apps ./apps
RUN pnpm --filter @open-design/daemon build && pnpm --filter @open-design/web build && pnpm --filter @open-design/daemon deploy --legacy --prod /opt/daemon

FROM node:24.14.1-bookworm-slim AS resources
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates python3 poppler-utils tini bubblewrap && rm -rf /var/lib/apt/lists/* && groupadd -g 1001 open-design && useradd -u 1001 -g 1001 -M open-design
WORKDIR /app
COPY --from=agent-tools /opt/agents /opt/agents
COPY --from=agent-tools /opt/company-profile /opt/company-profile
COPY --from=agent-tools /build/deploy/company/agent-entry.ts /opt/company/agent-entry.ts
COPY skills ./skills
COPY design-templates ./design-templates
COPY design-systems ./design-systems
COPY craft ./craft
COPY prompt-templates ./prompt-templates
COPY plugins/_official ./plugins/_official
COPY plugins/registry ./plugins/registry
COPY assets/frames ./assets/frames
COPY assets/community-pets ./assets/community-pets
COPY data/plugin-previews ./data/plugin-previews
ENV PATH=/opt/agents/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
ENV NODE_ENV=production
ENV OD_RESOURCE_ROOT=/app
USER 1001:1001

FROM resources AS agent
COPY --from=build /opt/daemon ./apps/daemon
ENTRYPOINT ["node", "/opt/company/agent-entry.ts"]

FROM resources AS api
COPY --from=build --chown=1001:1001 /opt/daemon ./apps/daemon
COPY --from=build /build/apps/web/out ./apps/web/out
ENV OD_BIND_HOST=0.0.0.0
ENV OD_PORT=7456
EXPOSE 7456
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/daemon/dist/company/api-main.js", "--no-open"]

FROM api AS executor
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
CMD ["node", "apps/daemon/dist/company/executor-main.js"]
