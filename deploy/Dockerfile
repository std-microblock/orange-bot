# Base image of the `dsh` container: the tools the chat/task agents reach for
# plus dsh itself, so a container rebuild loses nothing but writable-layer
# scratch. Data lives on the /root/.dsh bind mount (see deploy-dsh-plugin.md:
# ORANGE_DATA=/root/.dsh/orange-data keeps orange.db on the mount too).
FROM docker.1ms.run/library/node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq python3 python3-pip ripgrep procps less unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Pinned: bump together with packages/dsh-plugin-orange/package.json devDeps.
RUN npm i -g @deepseek-ai/dsh@0.2.1-rc.2 pnpm
