# dPagès — contexto permanente del proyecto

Este archivo se carga siempre. Contiene lo que cualquier sesión necesita saber
sin que se lo tengan que reexplicar. El detalle exhaustivo vive en `docs/`;
acá va la orientación y las reglas que no se pueden pisar por accidente.

## Qué es esto

Sistema propio de gestión de pedidos para dPagès (producción y distribución de
carne, Cataluña). Reemplaza hojas de Excel interconectadas y frágiles.

**El sistema NO es un espejo de WooCommerce.** Los pedidos entran por cuatro
canales — web (WooCommerce), correo, WhatsApp, teléfono — y la web es sólo
16–20% del volumen. WooCommerce es un canal de entrada más, no la fuente de
verdad. El resto de los pedidos se captura a mano.

- Cliente: dPagès (a través de Integraly AI Solutions).
- Equipo del cliente: ~10 personas — oficina, obrador, empaquetado.
- Catálogo real: ~111 artículos.
- Volumen: 80–100 pedidos/semana, 8,3 líneas por pedido en promedio.
- Idioma de salida: catalán (bilingüe ca/es sin confirmar todavía).
- Objetivo de puesta en producción: finales de septiembre de 2026.

Contexto de negocio completo: [`docs/contexto-negocio.md`](./docs/contexto-negocio.md).

## Equipo de desarrollo y cómo se trabaja

- **Gerardo** — backend, integración WooCommerce, base de datos.
- **Michel** — frontend en Next.js.

Trabajan en paralelo. Por eso el monorepo con `packages/shared`: es el
contrato de tipos entre los dos, y **se consume como paquete compilado**
(`dist/`), no como código fuente vía paths de TypeScript — ver ADR-010.
`npm install` ya lo compila solo (script `postinstall` en la raíz), así que
clonar y arrancar no requiere ningún paso manual. Pero si **editás**
`packages/shared` en una sesión de trabajo, corré `npm run build:shared` (no
hay watch automático) antes de que backend o frontend vean el cambio.

Construcción por capas: configuración base y tooling → Docker y base de datos
→ migraciones → cliente de WooCommerce → ingesta → transformación → servidor
HTTP → tests. Al terminar cada capa se para y se reporta antes de seguir.
Commits atómicos, Conventional Commits.

## Arquitectura

- Backend: Node.js sobre Cloud Run (Google Cloud), TypeScript estricto, ESM.
- Base de datos: PostgreSQL. Local: Docker. Producción: Cloud SQL. La
  migración es un cambio de variable de entorno (`DATABASE_URL`), nada más.
- Autenticación: Firebase Auth (JWT con roles) — **sólo autenticación, ningún
  dato de negocio**.
- Frontend: Next.js + Tailwind.
- Región: europea (europe-west1 o europe-southwest1) por RGPD.

### Restricciones de Cloud Run (no negociables desde el día uno)

Sin estado en memoria entre peticiones. Sin cron en proceso — la
sincronización la dispara **Cloud Scheduler llamando a un endpoint HTTP**
(ver ADR-009). Sin escritura a disco local. Escuchar en `process.env.PORT`.
Pools de conexión a Postgres pequeños (Cloud SQL en instancias chicas tiene
pocas conexiones; Cloud Run escala instancias, no achica el pool). Arranque
rápido, apagado ordenado ante `SIGTERM`.

## Stack del backend

TypeScript estricto + ESM · Fastify · `pg` sin ORM (las consultas de upsert
son demasiado específicas; SQL explícito y revisable) · Zod (validación de
entrada y de variables de entorno) · Pino (logging estructurado, Cloud
Logging) · Vitest · migraciones SQL planas con runner propio.

## WooCommerce: lo esencial

API moderna `/wp-json/wc/v3/` — **nunca** la legacy `/wc-api/v3/` (nombres de
campo distintos: `title` vs `name`, `created_at` vs `date_created`). El
sistema **sólo lee** de WooCommerce; la credencial es de sólo lectura;
**nunca se escribe de vuelta**.

**El catálogo está duplicado por idioma** (Polylang): cada artículo existe dos
veces (catalán/castellano) compartiendo el mismo SKU, y **ambas versiones
reciben pedidos**. El mapeo NO es `woo_product_id → artículo`; hace falta una
tabla de alias (`AliasProducte`). Detalle completo, con los números
verificados: [`docs/hallazgos-woocommerce.md`](./docs/hallazgos-woocommerce.md).

Las seis reglas obligatorias de consulta a la API (o se pierden registros)
están documentadas ahí mismo y en el agente `woocommerce-integration`.

## Reglas de negocio confirmadas por el cliente

- Peso siempre en kg, 3 decimales → `NUMERIC(10,3)`.
- No se graba una línea de pedido con unidades o peso en cero.
- Si el artículo tiene peso de ficha, el peso de línea NO es editable
  (= unidades × peso de ficha). Si no tiene peso, es "a medida": editable,
  arranca en cero, no puede quedar en cero.
- Empaquetado: "unidades enviadas" y "kilos enviados" son campos editables en
  línea, **obligatorios**, arrancan en cero, requieren checkbox de
  confirmación explícita aunque coincidan con lo pedido (doble confirmación:
  por mermas se puede enviar menos de lo pedido, y eso dispara abono/cargo).
  Issue #19 (Francesc, confirmado 23/09/2026) — a diferencia de la regla de
  arriba (unidades/peso de línea, que sigue sin poder ser cero), estos dos
  campos SÍ pueden guardarse en 0 (rotura total, artículo agotado): la
  restricción de "mayor que cero" que tenían se sacó a propósito, reabriendo
  y reemplazando una decisión anterior.
- Cinco estados de pedido: `oberta`, `en_proces`, `tancada`, `amb_incidencia`,
  `cancellada`. Petición de Ari (29/09/2026): un pedido `cancellada` no cuenta
  en **ninguno** de los cuatro paneles (ni en filas ni en totales), pero sigue
  visible en la pantalla de pedidos (filtro de estado incluido). Única
  excepción: en el Panel Oficina aparece si se filtra explícitamente por
  `estat=cancellada` (nunca con "Tots").
- Cuatro paneles: oficina, obrador, empaquetado, producció/planificació. **Sólo
  empaquetado edita**; los otros tres son de sólo lectura con filtros y
  subtotales.

## Decisiones de integración ya tomadas

Sync híbrido (webhook = notificación, no fuente del dato; polling incremental
cada 5 min pedidos / 2x/día catálogo; reconciliación diaria de 7 días), tabla
de aterrizaje cruda en `jsonb`, upsert con guardián de versión
(`date_modified_gmt`), propiedad de columnas por dueño (WooCommerce vs.
sistema), líneas de pedido sin DELETE+INSERT nunca, regla de congelación al
entrar en producción, disparo de sync vía endpoint de tareas + Cloud
Scheduler. **Cada una de estas es un ADR** — el porqué y las consecuencias
están en [`docs/decisiones-arquitectura.md`](./docs/decisiones-arquitectura.md).
Si un cambio de código contradice un ADR, se actualiza el ADR primero.

## Convenciones

- Código, comentarios y documentación: **español**.
- Nombres de tablas y columnas: **catalán**, siguiendo el prototipo validado
  por el cliente (`producte`, `comanda`, `comanda_linia`, `client`, `tarifa`,
  `transportista`).
- Imports relativos con extensión `.js` (NodeNext + `verbatimModuleSyntax`);
  `import type` para importaciones de sólo-tipo.
- RGPD: nunca loggear datos personales (nombres, emails, teléfonos,
  direcciones, NIF). Fixtures y ejemplos siempre anonimizados
  (`[redactat]` donde haga falta).

## Pendiente de definición con el cliente

No implementar, sólo documentar como abierto: tratamiento de descuentos,
asignación de transportista, criterio final de identificación de cliente,
campos de agrupación del catálogo, si el sistema es bilingüe o sólo catalán.
Detalle: [`docs/contexto-negocio.md`](./docs/contexto-negocio.md).

## Subagentes disponibles (`.claude/agents/`)

- **woocommerce-integration** — extracción/sincronización con WooCommerce.
- **db-schema** — migraciones y consultas de upsert en PostgreSQL.
- **security-reviewer** — RGPD, credenciales, inyección SQL, firma del
  webhook. Correr antes de cada commit relevante.
- **code-reviewer** — legibilidad, convenciones, coherencia con los ADRs.
- **cloud-run-optimizer** — restricciones de Cloud Run (ver arriba).
