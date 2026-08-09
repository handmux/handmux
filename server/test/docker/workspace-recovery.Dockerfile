FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/handmux-test/bin /workspace/api /workspace/docs /workspace/shared \
  && printf '%s\n' '#!/bin/sh' 'exec /usr/bin/tmux -L handmux-workspace-test "$@"' > /opt/handmux-test/bin/tmux \
  && chmod 0755 /opt/handmux-test/bin/tmux

ENV PATH="/opt/handmux-test/bin:${PATH}"
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY bin ./bin
COPY test ./test
COPY vitest.config.js ./

RUN ln -s /test-home/fake-bin/claude /usr/local/bin/claude \
  && ln -s /test-home/fake-bin/codex /usr/local/bin/codex
