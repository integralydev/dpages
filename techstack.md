# Tech stack — dPagès

Resumen del stack completo del sistema de gestión de pedidos de dPagès. El
porqué de cada decisión vive en `docs/decisiones-arquitectura.md` (ADRs) y
la orientación general en `CLAUDE.md`.

## Lenguaje y runtime

- **TypeScript** 5.7 (estricto, ESM, `NodeNext` + `verbatimModuleSyntax`).
- **Node.js 24** (`.nvmrc`, `engines: >=24 <25`).
- Gestor de paquetes: **npm workspaces** (monorepo).

## Estructura del repo

```
packages/
  shared/     @dpages/shared — tipos compartidos backend↔frontend, se consume compilado (dist/, ADR-010)
  backend/    @dpages/backend — API Fastify, migraciones SQL, ingesta/transformación WooCommerce
  frontend/   Next.js (App Router) — paneles oficina/obrador/empaquetado/producció
docs/         contexto de negocio, ADRs, contrato de API (openapi.yaml), infraestructura GCP
infra/gcp/    notas de infraestructura de Google Cloud
.github/      workflows de CI (ci.yml) y deploy manual (deploy.yml)
.claude/      subagentes del proyecto
```

## Backend (`packages/backend`)

- **Fastify** 5 + `@fastify/cors` 11.
- **PostgreSQL** con `pg` 8 — **sin ORM**, SQL explícito; migraciones SQL
  planas con runner propio (`src/db/migrate.ts`).
- **Zod** 3 — validación de entrada y de variables de entorno.
- **Pino** 9 — logging estructurado (Cloud Logging).
- **firebase-admin** 14 — verificación de tokens y gestión de usuarios.
- **jose** 5 — verificación de tokens OIDC de Cloud Scheduler.
- **undici** 8 — cliente HTTP (API de WooCommerce).
- **exceljs** 4 — exportación a Excel.
- Dev: **tsx** 4 (dev/scripts), **Vitest** 4 (tests).

## Frontend (`packages/frontend`)

- **Next.js** 16.3.1 (App Router) + **React** 19.2.8.
- **Tailwind CSS** 4 (`@tailwindcss/postcss`). Tokens de la identidad de
  dpages.cat en `src/app/globals.css` (`ink`, `brand`, `graphite`, `carbon`…).
- Tipografías vía `next/font/google` (autoalojadas): **Montserrat** (interfaz)
  y **Libre Baskerville** cursiva (títulos). Logo en `public/brand/`.
- **Firebase** JS SDK 12 (sólo Authentication).
- **lucide-react** (iconos).
- **jsPDF** 4 + **jspdf-autotable** 5 — listado de pedidos en PDF generado en el
  navegador (`src/lib/ordersPdf.ts`, carga diferida al pulsar el botón).
- `@tanstack/react-query` 5 (declarado en el `package.json` raíz).

## Base de datos

- **PostgreSQL 16**. Local: Docker Compose (`postgres` en puerto 5433,
  `postgres-test` en 5434 con tmpfs). Producción: **Cloud SQL**.
- Tablas/columnas en catalán (`producte`, `comanda`, `comanda_linia`…).

## Servicios externos

- **WooCommerce REST API v3** (`/wp-json/wc/v3/`) — sólo lectura; webhook
  con firma HMAC-SHA256 + polling incremental + reconciliación diaria.
- **Firebase Authentication** (proyecto `dpages-be46b`) — sólo identidad y
  roles, ningún dato de negocio. Alta de usuarios con enlace de
  establecimiento de contraseña.
- **Google Cloud Scheduler** — dispara la sincronización llamando a
  `POST /tasques/*` (ADR-009), autenticado con OIDC en producción.

## Hosting y despliegue

- **Google Cloud Run** (región `europe-west1`, RGPD) — backend y frontend,
  cada uno con su `Dockerfile`.
- Imágenes en **Artifact Registry** (`europe-west1-docker.pkg.dev`).
- **GitHub Actions**: `ci.yml` (lint, typecheck, test, build en cada push) y
  `deploy.yml` (deploy **manual** vía `workflow_dispatch`).

## Tooling

ESLint 9 + typescript-eslint · Prettier 3 · Husky 9 + lint-staged ·
commitlint (Conventional Commits) · EditorConfig.

## Variables de entorno (sólo nombres)

Backend (`.env` en la raíz, ver `.env.example`):

- `NODE_ENV`, `PORT`, `LOG_LEVEL`
- `DATABASE_URL`, `DB_POOL_MAX`
- `WC_BASE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `WEBHOOK_SECRET`
- `TASQUES_SECRET`, `TASQUES_OIDC_AUDIENCE`
- `CORS_ORIGIN`
- `INGESTA_DIES_ENRERE_DEFECTE`, `INGESTA_HISTORIC_COMPLET`
- `AUTH_DISABLED`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_ADMIN_SDK_KEY_JSON`

Frontend (`packages/frontend/.env.local`, ver `.env.example`):

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`

CI/CD (secretos de GitHub): `GCP_DEPLOY_KEY`, `FIREBASE_API_KEY`, `FIREBASE_APP_ID`
(las `NEXT_PUBLIC_*` se inyectan como `--build-arg` al construir la imagen
del frontend).
