# syntax=docker/dockerfile:1
#
# Build de @dpages/frontend en un monorepo de npm workspaces. Contexto de
# build: la RAÍZ del repo (hace falta acceso a package-lock.json y a
# packages/shared) — docker build -f packages/frontend/Dockerfile .
#
# Node 24 en TODAS las etapas (I2, misma versión que .nvmrc y "engines" en
# package.json de raíz/backend/shared/frontend): nunca instalar node_modules
# en una imagen y compilar/correr en otra con libc distinta (glibc vs musl).
# @next/swc, @tailwindcss/oxide y lightningcss son binarios nativos por
# plataforma — copiarlos entre bases distintas los deja rotos sin ningún
# error claro (confirmado reproduciendo el bug real: Turbopack cae a
# bindings WASM parciales y Tailwind genera un CSS casi vacío, sin ningún
# error de build). La causa real del bug original fue la INCONSISTENCIA de
# base entre etapas, no la versión de Node en sí — al subir de versión, las
# tres etapas se mueven juntas.

# ─── deps: instala TODO (dev incluido) para poder compilar más abajo ───────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
RUN npm ci --ignore-scripts

# ─── build: compila shared y DESPUÉS frontend (ADR-010) ────────────────────
FROM deps AS build
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_API_URL
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/frontend ./packages/frontend
RUN npm run build -w @dpages/shared
RUN npm run build -w frontend

# ─── runtime: sólo lo que genera output: "standalone" ──────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

RUN addgroup -S dpages && adduser -S dpages -G dpages

COPY --from=build --chown=dpages:dpages /app/packages/frontend/.next/standalone ./
COPY --from=build --chown=dpages:dpages /app/packages/frontend/.next/static ./packages/frontend/.next/static
COPY --from=build --chown=dpages:dpages /app/packages/frontend/public ./packages/frontend/public

USER dpages

EXPOSE 3000

CMD ["node", "packages/frontend/server.js"]
