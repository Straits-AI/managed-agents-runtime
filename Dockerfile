# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_IMAGE=node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2

FROM ${NODE_IMAGE} AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="managed-agents-runtime" \
      org.opencontainers.image.description="Durable managed-agent execution kernel" \
      org.opencontainers.image.source="https://github.com/Straits-AI/managed-agents-runtime" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build /build/dist ./dist
COPY migrations ./migrations
COPY contracts ./contracts
COPY provider-conformance ./provider-conformance
COPY deploy/provider-profiles ./deploy/provider-profiles
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/managed-agents-runtime

USER node
EXPOSE 8080
ENTRYPOINT ["managed-agents-runtime"]
CMD ["api"]
