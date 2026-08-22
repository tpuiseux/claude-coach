# Multi-user web app (SvelteKit, adapter-node). Distinct from the legacy
# static viewer, which is still served by the `training-view` nginx
# container until cutover - see the SaaS migration plan.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
# npm ci demands the lockfile match exactly for this platform, and this
# lockfile was generated on macOS - some optional/platform-specific
# transitive deps resolve differently on Linux. Only the builder stage
# needs node_modules at all (the runtime stage below installs its own,
# production-only), so the reproducibility npm ci would normally buy isn't
# worth fighting cross-platform lockfile drift for here.
RUN npm install
COPY . .
# paths.base is baked in at build time (see svelte.config.js) - must match
# the nginx location this image is deployed under exactly.
ARG BASE_PATH=/training-plan
ENV BASE_PATH=$BASE_PATH
RUN npm run build:web

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# Vite bundles most runtime deps directly into build/, but not all of them
# (consola stays external) - installing the app's own production deps here
# is the reliable way to cover whatever adapter-node's output still expects
# to resolve from node_modules, without hand-auditing which ones those are.
RUN npm install --omit=dev --ignore-scripts
COPY --from=builder /app/build ./build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "build"]
