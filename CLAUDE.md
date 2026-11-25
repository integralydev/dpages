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
  y reemplazando una decisión anterior. Tarea 57 (17/11/2026): la pantalla
  deja confirmar una línea pendiente en 0 y pide confirmación antes de
  guardar 0 unidades (24/11/2026, petición del cliente: con 0 kilos ya no
  se pregunta, porque hoy no cargan el peso). Tarea 51 (17/11/2026): única
  excepción a la confirmación línea a línea — «Marcar tot com a lliurat»
  confirma de una vez todas las pendientes de los filtros activos con lo
  pedido, tras un diálogo que pide desar antes, una a una, las que se
  enviaron con menos. Desde el 25/11/2026 el botón está también en el
  Panell de Compres (la vedella se envía desde allí), con el mismo
  endpoint.
- Cada línea de pedido tiene «producir» (sí/no, por defecto sí; tarea 57,
  acordado en reunión, 17/11/2026). En «no» (sale de stock, no se fabrica
  pero se envía) la línea no cuenta en Obrador ni en Producción; sí en
  Empaquetat, Compres y Oficina, que tienen un filtro para eso. El sync de
  WooCommerce no lo toca.
- Importes (tarea 40, confirmado por el cliente el 17/11/2026): según la
  tarifa, peso × precio o unidades × precio (`tarifa.calcul_per_pes`,
  editable en Tarifes; por unidades 01, MO, 08 y SARG). Peso = kg pedidos
  hasta que Empaquetat confirma la línea, después kg enviados. Sólo a partir
  de la tarea 40: cada pedido guarda su cálculo (`comanda.calcul_per_pes`) y
  los anteriores siguen por unidades. La fórmula vive en un solo sitio:
  `sqlImportLinia` (`comu.ts`).
- Seis estados de pedido: `esborrany`, `oberta`, `en_proces`, `tancada`,
  `amb_incidencia`, `cancellada`. `esborrany` (tarea 33, 03/10/2026): no cuenta
  en los paneles de Obrador, Empaquetat ni Compres; sí en Oficina y Producció. Es el
  estado con el que entran los pedidos de WooCommerce (tarea 38); una
  incidencia del sync no los saca de `esborrany`. Punt 38 (17/11/2026,
  reemplaza la regla de la tarea 39 y su corte de martes 16:00): los pedidos nuevos,
  duplicados y de WooCommerce nacen con producción = lunes siguiente a la fecha del
  pedido (ese mismo lunes si es lunes; Europe/Madrid) y expedición = el martes
  siguiente; sólo valores iniciales, editables (`calcularDatesPerDefecte` en
  `packages/shared`). Petición de Ari (29/09/2026): un pedido `cancellada` no cuenta
  en **ninguno** de los cinco paneles (ni en filas ni en totales), pero sigue
  visible en la pantalla de pedidos (filtro de estado incluido). Única
  excepción: en el Panel Oficina aparece si se filtra explícitamente por
  `estat=cancellada` (nunca con "Tots").
- Tipo de cliente (punt 35, 18/11/2026): `client.tipus` = `fix` o `esporadic`
  (por defecto `esporadic`); se edita desde el listado de clientes y filtra
  Comandes (`?tipusClient=`). Valores en `TIPUS_CLIENT` (`packages/shared`)
  y en el CHECK de la columna.
- Proveedores (punt 55, 18/11/2026): tabla `proveidor` (sólo nombre),
  `producte.proveidor_defecte_id` (preferido, opcional) y
  `comanda_linia.proveidor_id` (opcional; al crear la línea, el preferido
  del artículo, también desde el sync de WooCommerce). Filtro en Obrador
  (`?proveidorId=`, también `sense`). Sólo se borra si nadie lo usa.
- Cliente de un pedido web (ADR-027, confirmado por el cliente el
  25/11/2026): **manda el email**. Si el email ya es de un cliente, el
  pedido es suyo aunque traiga otro NIF; el cliente se queda con el NIF del
  pedido nuevo (salvo que ya sea de otro cliente) y queda un aviso
  `nif_diferent` que oficina ve en la ficha del pedido y cierra con
  «Revisat». Si el email no es de nadie, por NIF normalizado. Sólo al
  vincular el pedido por primera vez: los ciclos del sync no lo repiten.
- Cinco paneles: oficina, obrador, empaquetado, compres, producció/planificació.
  **Sólo empaquetado y compres editan**; los otros tres son de sólo lectura con
  filtros y subtotales. El Panell de Compres (tarea 41 del Excel del cliente,
  11/11/2026) es la misma información que Empaquetat — mismos filtros, mismas
  líneas, misma edición de unidades y kilos enviados, misma regla de doble
  confirmación — pero acumulada por cliente, con el detalle de sus líneas al
  desplegarlo. Módulo de permisos propio (`panell-compres`); la migración
  `0025` se lo dio a todos los roles que ya tenían `panell-empaquetat`.
  Desde el 25/11/2026 imprime, como Obrador, la lista desglosada (cada
  cliente y sus líneas) y la agrupada (sólo los totales por cliente).

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
- Cantidades e importes en pantalla y en los PDF: punto de millares y coma
  decimal (`1.058,465`), siempre con `formatDecimal`/`formatNombre` de
  `packages/frontend/src/lib/decimals.ts` (petición del cliente, 11/11/2026).
  Nunca en el valor de un campo editable: al escribir, el punto se acepta como
  separador decimal.

## Pendiente de definición con el cliente

No implementar, sólo documentar como abierto: tratamiento de descuentos,
asignación de transportista, campos de agrupación del catálogo, si el
sistema es bilingüe o sólo catalán.
Detalle: [`docs/contexto-negocio.md`](./docs/contexto-negocio.md).

## Subagentes disponibles (`.claude/agents/`)

- **woocommerce-integration** — extracción/sincronización con WooCommerce.
- **db-schema** — migraciones y consultas de upsert en PostgreSQL.
- **security-reviewer** — RGPD, credenciales, inyección SQL, firma del
  webhook. Correr antes de cada commit relevante.
- **code-reviewer** — legibilidad, convenciones, coherencia con los ADRs.
- **cloud-run-optimizer** — restricciones de Cloud Run (ver arriba).
