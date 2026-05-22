FROM node:24-bookworm-slim

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.35.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && arch="${TARGETARCH:-amd64}" \
  && case "$arch" in amd64|arm64|arm) ;; *) echo "unsupported TARGETARCH: $arch" >&2; exit 1 ;; esac \
  && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
  && chmod +x /usr/local/bin/kubectl \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV K8S_UI_ALLOW_MUTATIONS=true

COPY package.json ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
