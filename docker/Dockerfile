# 橘波特（orange-bot）一体化镜像：一台容器里装好 dsh + 插件 + koishi。
# 用法见 docker/README.md；这里只装运行时，不写任何密钥。
# syntax=docker/dockerfile:1
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_HOME=/data \
    npm_config_update_notifier=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates unzip tar tini \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @deepseek-ai/dsh pnpm koishi @satorijs/adapter-qq @koishijs/plugin-server-satori

COPY . /opt/orange-bot
WORKDIR /opt/orange-bot/packages/dsh-plugin-orange
RUN npm install --no-audit --no-fund

COPY docker/bot-entrypoint.sh docker/koishi-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/bot-entrypoint.sh /usr/local/bin/koishi-entrypoint.sh

WORKDIR /opt/orange-bot
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bot-entrypoint.sh"]
