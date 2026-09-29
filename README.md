# dPagès — sistema de pedidos

Sistema propio de gestión de pedidos de dPagès (producción y distribución de
carne), en reemplazo de las hojas de Excel interconectadas que usaba el
cliente. Contexto de negocio completo, equipo y decisiones de arquitectura:
[`CLAUDE.md`](./CLAUDE.md) y [`docs/`](./docs).

## Estructura

Monorepo con npm workspaces:

- `packages/shared` — tipos TypeScript compartidos entre backend y
  frontend; el contrato real entre los dos, consumido como paquete
  compilado (`dist/`), no vía paths de TypeScript.
- `packages/backend` — API (Fastify), integración de sólo lectura con
  WooCommerce, acceso a datos (PostgreSQL, sin ORM).
- `packages/frontend` — app Next.js con los cuatro paneles operativos
  (oficina, obrador, empaquetado, producción) y las pantallas de gestión
  (comandes, catàleg, tarifes, clients, usuaris).

## Requisitos previos

- Node `>=24 <25` (confirmado en `.nvmrc` y en `engines` de `package.json`
  raíz y de `packages/backend`).
- Docker + Docker Compose (para PostgreSQL en local).

## Arranque en local

### 1. Instalar dependencias

Desde la raíz del monorepo:

```bash
npm install
```

Esto instala todo el workspace, compila `@dpages/shared` automáticamente
(script `postinstall`) y activa Husky. No hace falta ningún paso manual
aparte para tener `@dpages/shared` listo — si más adelante lo editás, corré
`npm run build:shared` (no hay watch automático).

### 2. Levantar PostgreSQL

```bash
docker compose up -d postgres
```

Levanta el Postgres 16 de desarrollo en el puerto 5433 del host (base
`dpages`, con volumen persistente). El servicio `postgres-test` (puerto
5434, `tmpfs`, efímero) no hace falta para este paso — lo usan sólo los
tests (sección 5).

### 3. Configurar variables de entorno del backend

```bash
cp .env.example .env
```

**En la raíz del monorepo** (no dentro de `packages/backend/`). Los
placeholders de `.env.example` ya alcanzan para arrancar en local sin
tocar nada:

- **Obligatorias, con valor funcional de fábrica**: `DATABASE_URL` (ya
  apunta al Postgres del paso 2), `WC_BASE_URL`/`WC_CONSUMER_KEY`/
  `WC_CONSUMER_SECRET` (placeholders de un host de prueba — alcanzan para
  arrancar el servidor, no para sincronizar contra WooCommerce real),
  `WEBHOOK_SECRET`, `TASQUES_SECRET`.
- **Con default, no hace falta tocarlas**: `NODE_ENV`, `PORT`, `LOG_LEVEL`,
  `DB_POOL_MAX`, `INGESTA_DIES_ENRERE_DEFECTE`.
- **`AUTH_DISABLED=true`** (ya viene así): salta la verificación de token
  de Firebase en el backend para todas las rutas de negocio. **Importante**:
  esto sólo afecta al backend — el frontend (paso 7) siempre exige un
  login real contra Firebase Auth, no tiene ningún bypass propio. Con
  `AUTH_DISABLED=true` el backend no valida el token que el frontend
  manda, pero igual hace falta iniciar sesión con una cuenta real de
  Firebase para pasar la pantalla de login.
- **Opcionales, sin valor por defecto** (comentadas en `.env.example`,
  no hacen falta para arrancar): `TASQUES_OIDC_AUDIENCE` (sólo producción),
  `CORS_ORIGIN` (sólo producción — fuera de ella se usa un origen fijo de
  desarrollo), `INGESTA_HISTORIC_COMPLET`, `FIREBASE_ADMIN_SDK_KEY_JSON`
  (LEGACY, en migración a Application Default Credentials — sigue haciendo
  falta en producción para `POST /usuaris` mientras el rol IAM de Identity
  Toolkit no esté otorgado a la cuenta de servicio de Cloud Run, ver más
  abajo; en local no hace falta, ya funciona con ADC).

**Sobre `GOOGLE_APPLICATION_CREDENTIALS` (no está en `.env.example`, es una
variable estándar del SDK de Google, no propia del proyecto)**: con
`AUTH_DISABLED=true` (el valor por defecto de arriba) **no hace falta en
absoluto** — el middleware de autenticación (`crearMiddlewareAuth`,
`auth-firebase.ts`) devuelve un usuario fijo de desarrollo antes de
verificar ningún token, así que ni siquiera se inicializa la app de
Firebase que la usaría. Sólo se vuelve necesaria si en algún momento se
prueba con `AUTH_DISABLED=false` contra el proyecto real de Firebase —
ahí sí hace falta apuntarla a un archivo de credenciales de servicio
(convención esperada por `.gitignore`:
`packages/backend/firebase-service-account*.json`, nunca comiteado). Ese
archivo, igual que las credenciales de Firebase del paso 7, se entrega
como parte del acta de cierre del proyecto.

**I1 (migración a ADC para `POST /usuaris`)** — si ese mismo archivo ya está
apuntado por `GOOGLE_APPLICATION_CREDENTIALS` y es el service account
`firebase-adminsdk-fbsvc@...` (el que Firebase genera automáticamente, con el
rol "Administrador de Firebase Authentication"), `POST /usuaris` también
funciona en local vía ADC sin necesitar `FIREBASE_ADMIN_SDK_KEY_JSON`
(verificado con una llamada real de sólo lectura a Identity Toolkit). En
producción, Cloud Run resuelve ADC a la cuenta de servicio de la instancia
(`dpages-backend@...`), que todavía no tiene ese rol otorgado — hasta que se
confirme, `FIREBASE_ADMIN_SDK_KEY_JSON` sigue siendo necesaria ahí (ver
`.env.example` y `docs/integracion-frontend-shared-firebase.md`).

### 4. Aplicar migraciones

```bash
npm run migrate
```

Aplica las migraciones pendientes contra `DATABASE_URL` (carga el `.env`
de la raíz). Contra una base vacía, aplica todas en orden. Para ver el
estado sin aplicar nada: `npm run migrate:status`.

### 5. Cargar datos mínimos de arranque (opcional, recomendado)

```bash
npx tsx --env-file-if-exists=.env packages/backend/src/scripts/seed-arranque.ts
```

(corrido desde la raíz). Carga categorías de producto y los orígenes de
pedido base (`woocommerce`, `manual`) — son datos reemplazables, no la
fuente de verdad final, sólo para no arrancar con catálogo vacío. Es un
UPSERT: correrlo más de una vez no duplica nada.

### 6. Levantar el backend

```bash
npm run dev
```

Compila `@dpages/shared` y levanta el backend en modo watch, puerto 8080.
Verificar con `GET http://localhost:8080/salut`.

### 7. Configurar y levantar el frontend

```bash
cp packages/frontend/.env.example packages/frontend/.env.local
```

Completá los valores reales de Firebase (`NEXT_PUBLIC_FIREBASE_*`) — estas
credenciales se entregan como parte del acta de cierre del proyecto,
junto con el resto de accesos y claves necesarias para operar el sistema.
`NEXT_PUBLIC_API_URL` ya viene apuntando a `http://localhost:8080`, el
puerto del backend del paso 6.

En otra terminal:

```bash
cd packages/frontend
npm run dev
```

Levanta Next.js en el puerto 3000. El script `predev` corre
`kill-port 3000` antes de cada arranque — si quedó un proceso `next dev`
huérfano de una sesión anterior (frecuente en Windows al cerrar la
terminal sin `Ctrl+C`, en vez de cortar la señal correctamente), lo mata
solo antes de levantar uno nuevo; si no hay ninguno, no hace nada.

La app pide login real contra Firebase Auth (email/contraseña) — no hay
forma de entrar sin una cuenta real, ni siquiera en desarrollo local.

## Tests

```bash
npm run test
```

Corre la suite completa del backend (compila `@dpages/shared` primero).
Cada archivo de test crea su propio esquema descartable de Postgres y
corre las migraciones sólo sobre ese esquema — usa sus propias variables
de entorno (`vitest.config.ts`, puerto 5434, el servicio `postgres-test`
de `docker-compose.yml`), nunca las de tu `.env`. Si el contenedor
`postgres-test` no está levantado:

```bash
docker compose up -d postgres-test
```

El frontend no tiene suite de tests automatizados.

## Documentación adicional

- [`CLAUDE.md`](./CLAUDE.md) — contexto de negocio, arquitectura, stack y
  convenciones; lo primero a leer.
- [`docs/contexto-negocio.md`](./docs/contexto-negocio.md) — el cliente,
  canales de entrada, equipo, reglas de negocio confirmadas y pendientes
  de definición.
- [`docs/contrato-api.md`](./docs/contrato-api.md) — contrato completo de
  endpoints del backend, con el porqué de cada regla.
- [`docs/decisiones-arquitectura.md`](./docs/decisiones-arquitectura.md) —
  ADRs: las decisiones de arquitectura y su razón.
- [`docs/hallazgos-woocommerce.md`](./docs/hallazgos-woocommerce.md) —
  hallazgos técnicos verificados contra la tienda WooCommerce real.
- [`docs/openapi.yaml`](./docs/openapi.yaml) — spec OpenAPI del contrato.
- [`docs/integracion-frontend-shared-firebase.md`](./docs/integracion-frontend-shared-firebase.md) —
  notas técnicas sobre la integración del frontend con `@dpages/shared` y
  Firebase Auth real (por qué ciertas credenciales de Firebase hacen
  falta o no, estado de la pantalla de usuarios).

## Deploy a producción

Existen `Dockerfile` reales en `packages/backend/` y `packages/frontend/`,
pero el proceso de deploy a Cloud Run y el resto de la infraestructura de
Google Cloud lo gestiona el equipo de backend por separado — esa
documentación se entrega aparte, no está cubierta en este README.
