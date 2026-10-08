# Decisiones de arquitectura (ADRs)

Formato: Contexto, Decisión, Consecuencias. Una decisión por sección. Si un
cambio de código contradice un ADR vigente, el commit tiene que actualizar el
ADR (marcarlo `Superseded` y explicar por qué), nunca ignorarlo en silencio.

---

## ADR-001 — Usar la API REST v3 moderna de WooCommerce, no la legacy

**Estado**: Aceptado.

**Contexto**: WooCommerce expone dos APIs distintas: la legacy
(`/wc-api/v3/`) y la moderna basada en WP REST (`/wp-json/wc/v3/`). Hay
documentación y ejemplos circulando que referencian la legacy, con nombres de
campo distintos (`title` vs `name`, `created_at` vs `date_created`).

**Decisión**: Usar exclusivamente `/wp-json/wc/v3/`.

**Consecuencias**: Cualquier código, documentación o ejemplo que use los
nombres de campo de la legacy es un bug, no una variante válida.

---

## ADR-002 — Sincronización híbrida: webhook + polling incremental + reconciliación

**Estado**: Aceptado.

**Contexto**: WooCommerce es uno de cuatro canales de entrada, no la fuente
de verdad. Necesitamos que los pedidos web aparezcan rápido en el sistema,
pero sin depender únicamente de webhooks (pueden perderse, llegar
duplicados o fuera de orden) ni únicamente de polling (latencia).

**Decisión**: Sync híbrido.

- El **webhook es una notificación**, no la fuente del dato: al recibirlo se
  extrae el id del pedido y se hace `GET /orders/{id}` para traer el estado
  canónico. Elimina el problema de payloads incompletos o fuera de orden.
- **Polling incremental**: cada 5 minutos para pedidos, 2 veces al día para
  catálogo, usando `modified_after`/cursor (ver ADR obligatorias de consulta
  en `docs/hallazgos-woocommerce.md`).
- **Reconciliación diaria** con ventana amplia de 7 días, para corregir
  cualquier cosa que se haya perdido por webhooks caídos o fallos de red.
- Disparo de todo esto: ver ADR-009 (no hay cron en proceso).

**Consecuencias**: Ningún componente confía en una sola fuente de
sincronización. El sistema tolera caída temporal de webhooks o de un ciclo
de polling sin perder datos, a costa de más complejidad que un enfoque
único.

---

## ADR-003 — Tabla de aterrizaje cruda (jsonb) antes de normalizar

**Estado**: Aceptado.

**Contexto**: Normalizar directamente al recibir cada respuesta de
WooCommerce acopla la ingesta a la transformación: un bug en la
transformación obliga a volver a pegarle a la API del cliente para
reprocesar, y la API tiene latencia (~3s por consulta).

**Decisión**: Guardar el JSON completo de cada recurso (`orders`,
`products`, `products/{id}/variations`) en una tabla `jsonb` de aterrizaje
antes de transformar/normalizar.

**Consecuencias**: Se puede reprocesar la transformación completa sin volver
a consultar WooCommerce. Desacopla ingesta de normalización — se pueden
arreglar bugs de transformación y correrlos sobre datos ya aterrizados.
Costo: espacio en disco adicional y una capa más de indirección.

---

## ADR-004 — Upsert de cabecera de pedido con guardián de versión

**Estado**: Aceptado.

**Contexto**: Con sync híbrido (ADR-002), un webhook puede llegar después de
que un ciclo de polling ya haya traído una versión más nueva del mismo
pedido (o viceversa). Sin control de versión, el que llega último gana,
aunque sea el dato más viejo.

**Decisión**: Al actualizar una cabecera de pedido, aplicar el UPDATE
**sólo si** el `date_modified_gmt` entrante es mayor que el almacenado. La
comparación va en el propio `WHERE` del UPDATE (atómica), no en un SELECT
previo separado.

**Consecuencias**: Un webhook retrasado nunca puede pisar datos más nuevos.
Requiere que toda ruta de escritura de cabecera de pedido pase por esta
misma consulta guardada — no puede haber un UPDATE alternativo que la
esquive.

---

## ADR-005 — Propiedad de columnas: WooCommerce vs. sistema

**Estado**: Aceptado.

**Contexto**: El sistema no es un espejo de WooCommerce: agrega datos
propios (fechas de producción/expedición/entrega, transportista, tarifa,
confirmaciones de empaquetado) sobre datos que sí vienen de WooCommerce. Sin
una regla clara, el sync corre el riesgo de sobrescribir trabajo operativo
ya hecho.

**Decisión**: Cada columna tiene un único dueño.

- **De WooCommerce** (el sync puede sobrescribir): estado web, población
  destino, total, unidades pedidas, precio unitario.
- **Del sistema** (el sync nunca las toca): fechas de producción /
  expedición / entrega, transportista, tarifa, bultos, estado operativo,
  observaciones, unidades y kilos entregados, confirmación.

**Consecuencias**: Ningún UPDATE de sincronización puede tocar columnas de
la segunda categoría, ni siquiera accidentalmente por usar `UPDATE ... SET *`
o un ORM genérico (motivo adicional para no usar ORM). Ver también ADR-007
(congelación).

---

## ADR-006 — Líneas de pedido: nunca DELETE+INSERT

**Estado**: Aceptado.

**Contexto**: Los `line_item.id` de WooCommerce no son estables: al editar
un pedido desde el admin de WooCommerce, los ítems se recrean con ids
nuevos. Un DELETE+INSERT en cada sync borraría también los kilos y unidades
que empaquetado ya registró para esas líneas.

**Decisión**: Emparejar líneas primero por `woo_line_item_id`; si no
coincide, por `(producte_id, ordinal)`. Las líneas que ya no vienen de
WooCommerce se marcan `esborrat = true` (columna en `comanda_linia`), nunca
se eliminan físicamente.

**Consecuencias**: Se preserva el trabajo de empaquetado incluso cuando
WooCommerce cambia los ids de línea por detrás. El esquema necesita una
columna de borrado lógico y toda consulta de líneas "activas" tiene que
filtrar por ella.

---

## ADR-007 — Regla de congelación al entrar en producción

**Estado**: Aceptado.

**Contexto**: Un cliente editando su pedido en la web no puede alterar en
silencio una orden de trabajo que el obrador ya está ejecutando.

**Decisión**: Una vez que un pedido entra en producción, se graba
`congelat_a` (columna `TIMESTAMPTZ` en `comanda`, no nula desde ese
momento) y el sync deja de sobrescribirlo. Si llega una actualización de
WooCommerce para un pedido congelado, se registra como **incidencia** para
que oficina la resuelva manualmente, en vez de aplicarse.

**Consecuencias**: Requiere que todo el código de sync chequee
`congelat_a IS NULL` antes de aplicar un upsert de cabecera o de líneas, y
que exista un mecanismo de incidencias visible para oficina.

**Nota (30/08/2026) — fase pre-productiva**: el ambiente actual de Cloud
Run/Cloud SQL se considera **pre-productivo**, no el corte formal a
producción: todavía faltan desarrollos por desplegar y falta la fase de QA
con Francesc. El corte formal a "producción real" queda para una fecha
posterior, todavía sin definir. Mientras dure esta fase pre-productiva, la
regla histórica de nunca correr scripts destructivos (incluido
`reset-carga-inicial.ts`) contra una base con datos reales cargados queda
**en pausa, no derogada**: es válido usarlos contra este ambiente si hace
falta para pruebas. Cualquier reset en esta fase debe coordinarse avisando
antes a Michel/Francesc, por si están en medio de una sesión de prueba. La
restricción vuelve a aplicar completa en cuanto se declare el corte formal
a producción.

---

## ADR-008 — Catálogo con tabla de alias por idioma

**Estado**: Aceptado.

**Contexto**: Ver hallazgo verificado en `docs/hallazgos-woocommerce.md`: el
catálogo está duplicado por idioma (Polylang), con el mismo SKU en dos
`product_id` distintos, y ambas versiones reciben pedidos activamente. Un
mapeo `woo_product_id → artículo` no puede funcionar porque no hay un único
`product_id` "correcto" por artículo.

**Decisión**: Tabla `alias_producte` que vincula cada `woo_product_id` (con
su idioma) al artículo canónico (`producte`). La resolución de una línea de
pedido busca primero por alias existente; si no lo encuentra, cae a
resolución por SKU.

**Consecuencias**: El artículo canónico (peso, nombre para el sistema,
categoría) vive independiente de WooCommerce. Ingesta y transformación
tienen que resolver siempre vía esta tabla, nunca asumiendo relación directa.

---

## ADR-009 — Disparo de sincronización vía endpoint de tareas + Cloud Scheduler

**Estado**: Aceptado.

**Contexto**: Cloud Run no soporta procesos de larga duración ni cron en
proceso — cada instancia puede vivir minutos y escalar a cero. La
sincronización cada 5 minutos (ADR-002) necesita un disparador externo.

**Decisión**: Cloud Scheduler llama a endpoints HTTP dedicados:

- `POST /tasques/sync-comandes`
- `POST /tasques/sync-cataleg`
- `POST /tasques/reconciliar`

Protegidos: en producción validan el token OIDC que envía Cloud Scheduler;
en local, un secreto compartido por variable de entorno. Responden rápido y
son idempotentes — un reintento de Scheduler (por timeout o error 5xx) no
puede duplicar trabajo.

**Consecuencias**: Nada de `setInterval`/`node-cron` en el proceso del
backend (ver también el agente `cloud-run-optimizer`). El aprovisionamiento
de Cloud Scheduler es parte de `infra/gcp/`. La implementación de estas
rutas llega en la capa "servidor HTTP"; documentadas también en
`docs/contrato-api.md`.

**Nota (08/10/2026) — piso de activación para pedidos de WooCommerce**:
`POST /tasques/sync-comandes`, `POST /tasques/reconciliar` y el webhook
(`POST /webhooks/woocommerce`) comparten ahora la misma regla: ningún
pedido de WooCommerce CREADO antes de `INGESTA_COMANDES_DES_DE` entra al
sistema, aunque se modifique después (`transform/comandes.ts`). La
variable es opcional incluso en producción a nivel de arranque (no bloquea
el proceso si falta).

En tiempo de ejecución hay DOS guardas, no una sola: `tasques.ts`
(`comprobarPisoActivacioOResponder`) corta `sync-comandes`/`reconciliar`
en producción **antes de llamar a la tienda**, si la variable falta —
responde `500 ERROR_INTERN` sin aterrizar nada en `aterratge_woocommerce`
(ajuste del 08/10/2026 — antes sólo fallaba la transformación, fila por
fila, después de haber llamado igual a la tienda y aterrizado los
pedidos; si el lote venía vacío, ese fallo ni se veía). `transformarComanda`
conserva su propia guarda por si alguna vez se la llamara sin pasar por
esa ruta (el webhook, por ejemplo, no ingiere nada — ver más arriba — así
que ahí sigue siendo la única barrera). El error queda visible en la
respuesta de la tarea (`500`, cuerpo `{ error: { codi: 'ERROR_INTERN' } }`)
o en `esdeveniment_webhook.error` para el webhook. Ver `.env.example`
(incluye el formato exacto aceptado, verificado arrancando el backend
real) y `docs/hallazgos-woocommerce.md` (parámetro `after` agregado a
`GET /orders`).

---

## ADR-010 — `@dpages/shared` se consume como paquete compilado

**Estado**: Aceptado.

**Contexto**: Es la fricción clásica de los monorepos: `shared` se puede
consumir como código fuente (vía `paths` de TypeScript) o como paquete
compilado (`dist/` + `exports` en `package.json`). Next.js consume paquetes
compilados sin configuración adicional; con `paths` de TypeScript, el
frontend se topa con errores de transpilación difíciles de diagnosticar
(Next no siempre transpila código fuente de fuera de su propio árbol sin
configuración extra).

**Decisión**: `packages/shared` se compila a `dist/` con `main`, `types` y
`exports` declarados en su `package.json`. Backend y frontend lo consumen
como paquete de node_modules (symlink de npm workspaces), nunca importando
`../shared/src/...` directamente.

**Consecuencias**: El build de `shared` tiene que correr antes que el de
`backend` (y antes de levantar el dev server de `frontend`), tanto en local
como en CI — resuelto explícitamente en los scripts de la raíz
(`build`, `dev`, `typecheck`, `test` corren `build:shared` primero, y
`postinstall` lo compila automáticamente después de todo `npm install`/
`npm ci`, para que clonar el repo y arrancar no dependa de que alguien sepa
este detalle). Cambiar un tipo en `shared` no se refleja en los otros
paquetes hasta recompilar — no hay watch automático entre paquetes.

---

## ADR-011 — Runner de migraciones propio: transacción por archivo y verificación por hash

**Estado**: Aceptado.

**Contexto**: Las migraciones son SQL plano numerado (`NNNN_nombre.up.sql` /
`.down.sql`, ver el agente `db-schema`). Hacía falta decidir cómo se
aplican: todo el lote en una sola transacción o una por archivo, y cómo
detectar el error más difícil de este esquema — que alguien edite una
migración que otra persona ya aplicó, en vez de agregar una nueva.

**Decisión**:

- Una tabla `esquema_migraciones` (nombre genérico, no catalán: es
  infraestructura de la herramienta, no una entidad del dominio del
  cliente) registra `id`, `nombre_archivo`, `checksum` (SHA-256 del
  contenido) y `aplicada_en`.
- **Cada migración se aplica en su propia transacción** (`BEGIN`/`COMMIT`
  por archivo, no una transacción para todo el lote). Si la 0003 falla, la
  0001 y la 0002 quedan aplicadas y registradas — no hay que reintentar
  desde cero.
- **Antes de aplicar nada**, el runner compara el checksum de cada
  migración ya aplicada contra el contenido actual del archivo en disco. Si
  no coincide, corta con un error explícito y no aplica ninguna migración
  pendiente hasta que se resuelva.
- Correr el runner sin migraciones pendientes es un no-op: es lo que lo hace
  seguro de correr las veces que haga falta (en CI, a mano, o como paso de
  despliegue — nunca automáticamente al arrancar el servicio, ver ADR-012).
- El runner vive en `packages/backend/src/db/migrate.ts`, expone `up` y
  `status` por ahora (no `down` automatizado — los `.down.sql` existen para
  reversión manual en desarrollo, nunca para producción, ver el agente
  `db-schema`).

**Consecuencias**: Ver un fallo a mitad de un lote no obliga a averiguar qué
quedó a medias — el estado en `esquema_migraciones` es la fuente de verdad.
El chequeo de hash convierte "alguien editó una migración vieja" en un error
ruidoso al arrancar en vez de un esquema desincronizado que se descubre
semanas después. Costo: si de verdad hace falta corregir una migración ya
aplicada (typo, etc.), no se edita — se agrega una migración nueva que
corrige, igual que con cualquier cambio de esquema posterior.

---

## ADR-012 — Las migraciones se aplican como paso separado, nunca al arrancar el servicio

**Estado**: Aceptado.

**Contexto**: Cloud Run puede levantar varias instancias del backend a la
vez (arranque en frío, escalado, un deploy nuevo mientras la revisión vieja
todavía atiende tráfico). Si el runner de migraciones corriera dentro de
`src/index.ts` al arrancar, N instancias podrían competir por aplicar el
mismo esquema al mismo tiempo. El guardián de checksum e `INSERT` con clave
primaria de `esquema_migraciones` (ADR-011) evitarían una corrupción real,
pero el resultado seguiría siendo frágil: una instancia aplicando DDL
mientras otra ya sirve tráfico con el esquema viejo, y una migración que
falla tirando abajo el arranque de TODAS las instancias nuevas en vez de
sólo bloquear el paso de despliegue que la necesita.

**Decisión**: El runner de migraciones nunca se invoca desde el código de
arranque del servidor HTTP. Se ejecuta como un paso separado y explícito
(`node dist/db/migrate.js up`), antes de desplegar la revisión nueva. En
Cloud Run esto se traduce en un Job aparte (o una ejecución manual) que
corre y termina, no en el propio servicio. Por eso la imagen de Docker
incluye `migrations/` y el runner ya compilado — el comando alternativo
está disponible en la misma imagen que se despliega, sin necesitar una
imagen distinta para migrar.

**Consecuencias**: Desplegar pasa a ser dos pasos (migrar, después
desplegar la revisión) en vez de uno, y todavía no está automatizado — el
Job de Cloud Scheduler/Run para esto es trabajo de `infra/gcp/`, pendiente.
A cambio, un fallo de migración nunca puede tirar abajo el servicio: se
detecta y se resuelve ANTES de que una instancia nueva intente arrancar con
un esquema a medio aplicar.

---

## ADR-013 — Carga de `.env` vía `--env-file-if-exists`, nunca en código de aplicación

**Estado**: Aceptado.

**Contexto**: `env.ts` siempre leyó `process.env` directamente (a propósito:
es lo correcto para Cloud Run, donde las variables las inyecta la
plataforma y Secret Manager). El problema es que **nada** cargaba el
`.env` local hacia `process.env` antes de que `env.ts` lo leyera — no había
`dotenv` instalado ni ningún flag de Node en los scripts. Resultado real:
copiar `.env.example` a `.env` y completarlo no alcanzaba, porque nadie lo
leía. Además, los scripts de npm corren con cwd en el paquete
(`packages/backend`), no en la raíz del monorepo donde vive `.env` — una
carga que asuma cwd se rompe apenas alguien invoca el script desde otro
lado.

**Decisión**: Cargar `.env` con el flag nativo de Node
`--env-file-if-exists=../../.env`, agregado en los scripts de
`packages/backend/package.json` que lo necesitan (`dev`, `start`,
`migrate`, `migrate:status`) — **no** en `env.ts` ni en ningún otro código
de aplicación. La ruta es relativa a la raíz del monorepo, fija, sin
depender de desde dónde se invoque `npm run`.

Se eligió `--env-file-if-exists` (silencioso si el archivo no existe) en
vez de `--env-file` (que aborta con un error de Node si falta el archivo):
así, si falta `.env`, quien lo ve es el mensaje de `env.ts` ("falta esta
variable de entorno... revisá `.env.example`") — el mismo mensaje claro
tanto si falta el archivo entero como si falta una sola variable dentro de
uno que sí existe. Un solo camino de error, no dos.

No se agregó `dotenv` ni ninguna dependencia nueva: Node 20.6+/22 lo trae
nativo.

**Consecuencias**:

- **Producción nunca carga nada**: el `CMD` del `Dockerfile` es
  `node dist/index.js`, directo, sin pasar por los scripts de npm — nunca
  lleva el flag, así que en Cloud Run jamás se intenta leer un archivo
  `.env` (que además ni siquiera viaja en la imagen). No hizo falta
  ninguna rama `if (NODE_ENV === 'production')` en el código para lograr
  esto: la garantía es estructural, no una condición que alguien podría
  romper.
- **Los tests no dependen de ningún `.env`**: `vitest.config.ts` ya seteaba
  sus propias variables dummy vía `test.env` (nunca leyó archivos) — esto
  no cambió, y sigue significando que CI y una máquina local se comportan
  igual sin importar qué `.env` tenga cada quien.
- Quien clone el repo tiene que copiar `.env.example` a `.env` en la raíz
  antes de correr `dev`/`migrate` — documentado en el README.

---

## ADR-014 — `aterratge_woocommerce` guarda el último payload, no un historial de versiones

**Estado**: Aceptado.

**Contexto**: `aterratge_woocommerce` tiene `PRIMARY KEY (recurs, woo_id)` y
la ingesta hace `ON CONFLICT (recurs, woo_id) DO UPDATE` (capa 5) — cada
ingesta pisa el payload anterior del mismo recurso. Esto se decidió al
implementar la capa 5, razonando que el propósito declarado en ADR-003 es
"reprocesar la transformación sin volver a pegarle a la API" — para eso
alcanza con el último estado crudo, no hace falta un historial. **Pero esa
consecuencia (se pierde la posibilidad de ver cómo evolucionó un pedido en
WooCommerce a lo largo del tiempo) no se puso a consideración explícita ni
quedó escrita en ningún ADR** — fue una decisión tomada al codificar, no
una decisión conjunta documentada. Correcto marcarla ahora como lo que es.

**Decisión**: Se mantiene el comportamiento actual (upsert, sin historial)
por estos motivos, ahora sí explícitos:

- El propósito de la tabla de aterrizaje es desacoplar ingesta de
  transformación (ADR-003), no auditoría. Para reprocesar el estado
  _actual_, el histórico no aporta nada.
- El historial de negocio que sí importa — cómo cambió un pedido real, con
  fecha — vive en `comanda`/`comanda_linia` (con `creat_en`,
  `data_modificacio_woo`) una vez transformado, que es donde oficina y
  producción lo necesitan consultar.
- Guardar cada versión cruda que llega (pedidos se pueden modificar varias
  veces) crece sin cota y sin un caso de uso concreto hoy que lo pida.

**Consecuencias**: Si en el futuro aparece una necesidad real de auditoría
del payload crudo tal como lo mandó WooCommerce en cada momento (no sólo el
estado transformado), esto se revisita — la migración sería agregar un `id`
autoincremental y sacar el upsert (pasar a log append-only), o una tabla de
auditoría aparte. No es un cambio grande, pero tampoco se construye ahora
sin un motivo concreto que lo pida.

---

## ADR-015 — Node 24 como versión única del proyecto (LTS activa, no la más nueva por comodidad)

**Estado**: Aceptado.

**Contexto**: El proyecto arrancó fijando Node 22 en todos lados (`.nvmrc`,
`engines`, `Dockerfile`, CI). A los dos días de vida, con cero dependencias
que pudieran romperse por el cambio, se revisó esa elección contra el
calendario real de releases de Node.js:

| Versión | Fase actual (agosto 2026)              | Pasa a Mantenimiento | Fin de vida (EOL) |
| ------- | -------------------------------------- | -------------------- | ----------------- |
| Node 22 | LTS de Mantenimiento (desde oct. 2025) | ya pasó              | **abril de 2027** |
| Node 24 | LTS Activa (desde oct. 2025)           | octubre de 2026      | **abril de 2028** |

Node 22 ya está en la fase donde sólo recibe parches de seguridad críticos,
no mejoras — y muere un año antes que Node 24. Seguir con Node 22 significa
heredar una migración de versión mayor en algún punto de 2026-2027, ya con
el sistema en producción (puesta en marcha objetivo: septiembre de 2026) y
con dependencias reales acumuladas. Este es el momento más barato posible
para este cambio: dos días de código, sin nada que validar contra una
versión vieja.

**Decisión**: Node 24 es la versión única del proyecto, en todos los
lugares donde antes decía 22: `.nvmrc`, `engines` de los cuatro
`package.json` (raíz y los tres paquetes), las tres etapas del `Dockerfile`,
`node-version` en `ci.yml`, y `@types/node` fijado explícitamente en la
línea `24.x` (antes llegaba de arrastre transitivo vía `@types/pg`/`vitest`
en la `26.x` — desalineado con la versión real del runtime, sin que nadie
lo hubiera decidido).

No es "la versión más nueva porque sí": es la LTS **activa** — la que
recibe mejoras y parches por igual, no sólo parches de seguridad — con el
mayor tiempo de vida útil por delante para un proyecto que recién empieza.

**Consecuencias**: Ninguna dependencia del proyecto quedó atada a Node 22
(cero código heredado), así que el cambio fue mecánico. Revisar esta
decisión de nuevo cuando Node 24 pase a Mantenimiento (**octubre de
2026**) — para entonces evaluar si conviene saltar a la siguiente LTS activa
(Node 26, prevista) antes de que dPagès esté en producción, o esperar a
después del go-live. No adoptar Node 25/27/... (versiones impares, "Current"
sin garantía de LTS) en ningún entorno: son de vida corta y no están
pensadas para producción.

## ADR-016 — Servidor HTTP: webhook fire-and-forget, tareas síncronas, lock por pedido

**Estado**: Aceptado.

**Contexto**: La capa 7 conecta la ingesta/transformación (ya existentes)
con dos entradas externas que pueden disparar el mismo trabajo por el mismo
pedido casi al mismo tiempo: el webhook de WooCommerce (evento en tiempo
real) y el polling por lote (`ingerirComandes`/`transformarComandes`, capas
5-6, disparado por el endpoint de tareas de Cloud Scheduler, ver ADR-009).
Sin coordinación, ambos caminos pueden llamar a `transformarComanda` para el
mismo `woo_order_id` en transacciones concurrentes.

**Decisión**:

- **Lock de concurrencia por pedido**: `transformarComanda` toma
  `pg_advisory_xact_lock($woo_order_id)` como primer paso. Serializa por
  pedido, no bloquea pedidos distintos entre sí, y se libera solo al
  terminar la transacción del llamador (`COMMIT`/`ROLLBACK`) — nunca hace
  falta liberarlo a mano. Esto ya estaba previsto en el diseño original de
  la ingesta (capas 5-6) pero no se había implementado hasta cablear el
  webhook, que es el primer caller que de verdad puede pisarse con el poll.

- **El webhook responde rápido y sigue en segundo plano**: `POST
/webhooks/woocommerce` valida la firma, registra el evento y responde 200
  de inmediato; el `GET /orders/{id}` + transformación corren después, sin
  bloquear la respuesta. Motivo: WooCommerce deshabilita un webhook después
  de fallos/timeouts repetidos, y un cold start de Cloud Run puede tardar
  más de lo que WooCommerce espera. Si el trabajo de fondo falla, el evento
  queda marcado con el error — no hay reintento automático del lado del
  servidor, pero el próximo polling (`/tasques/sync-comandes` o
  `/tasques/reconciliar`) va a traer igual el pedido por versión.

- **Las tareas de Cloud Scheduler son síncronas**: `/tasques/sync-comandes`,
  `/tasques/sync-cataleg` y `/tasques/reconciliar` esperan a que termine la
  ingesta y la transformación antes de responder, y devuelven los contadores
  reales en el cuerpo. A diferencia del webhook, Cloud Scheduler no
  deshabilita nada por una respuesta lenta, y tener el resultado real en la
  respuesta (en vez de "recibido, ver logs") es lo que permite verificar
  desde el propio Scheduler o desde monitoreo si una corrida trajo 0 items o
  falló.

**Consecuencias**: El webhook y el polling pueden convivir sin condición de
carrera sobre un mismo pedido, verificado con un test de Postgres real que
llama a las dos rutas (`webhook.test.ts`, `tasques.test.ts`). El costo es
que una tarea de Cloud Scheduler con un lote grande puede tardar — si
`transformarComandes` llega a ser lento en producción con volumen real, hay
que revisar si Cloud Run soporta el timeout de esa ruta antes de considerar
hacerla asíncrona también.

### Nota RGPD encontrada durante la revisión de seguridad de esta capa

El logging automático de peticiones de Fastify (activado por default al no
pasar `disableRequestLogging: true`) vuelca `req.remoteAddress` — la IP del
llamador — en cada línea de "incoming request"/"request completed". No es
un descuido de código de aplicación, es el comportamiento por defecto del
framework en cuanto se cableó el primer servidor HTTP del proyecto. Se
agregó `req.remoteAddress` y `req.headers["x-forwarded-for"]` a la lista de
`redact` de `lib/logger.ts` (con test de regresión en `logger.test.ts`) en
vez de desactivar el logging de peticiones: perder el método/ruta/status/
tiempo de respuesta de cada petición sería peor para operar el servicio que
mantenerlo sin la IP.

---

## ADR-017 — La primera ingesta de un recurso se acota a 30 días, no trae el histórico completo

**Estado**: Aceptado.

**Contexto**: Probando la capa 5/7 en vivo contra el WooCommerce real, la
primera ingesta de `orders` (sin `cursor_sincronitzacio` previo para ese
recurso) trajo el histórico completo de la tienda: 4.250 pedidos, varios
minutos de ejecución. No estaba trabada — era volumen real — pero sin
ningún log intermedio durante la paginación dio la impresión de estar
colgada, y nadie tenía forma de distinguir un caso del otro. Con el
histórico completo real (más viejo y más grande que lo visto en esta
prueba) esa espera va a ser todavía mayor en producción.

**Decisión**:

- **La primera carga de un recurso se acota a `INGESTA_DIES_ENRERE_DEFECTE`
  días hacia atrás (default: 30)**, no al histórico completo. Se implementa
  calculando `modified_after` como "ahora menos N días" cuando
  `calcularFinestraConsulta` (`sync/cursor.ts`) recibe `cursorPrevi = null`.
  Esto **sólo afecta a la primera carga** — en cuanto existe cursor para ese
  recurso, el incremental normal (`modified_after` por cursor + solapamiento
  de 5 minutos, sin cambios) sigue exactamente igual.
- **30 días es un valor operativo, no una decisión de negocio sobre cuánto
  histórico hace falta**: alcanza para poblar el sistema con pedidos
  recientes y verificar que la ingesta funciona, sin la espera ni el
  volumen de traer años de datos por defecto. Si alguna vez se decide
  migrar el histórico completo de dPagès al sistema nuevo, esa es una
  decisión de negocio aparte — **ver P-21 del backlog**, pendiente de
  resolver formalmente con Integraly. Esta ADR no la resuelve, sólo evita
  que ocurra por accidente.
- **`INGESTA_HISTORIC_COMPLET=true`** fuerza el histórico completo sin
  acotar (pasa `diesEnrereCargaInicial = null`). Es el mecanismo para el día
  que se decida migrar el histórico de verdad — deliberado y explícito
  (sólo el literal `"true"` lo activa), nunca el comportamiento por
  defecto, para que haga falta un cambio a propósito antes de volver a
  traer miles de registros.
- **Log de progreso en cada página de la paginación** (`woocommerce/cliente.ts`,
  `listarTodo`), no sólo al finalizar: con `page`, `totalPaginas` (cuando
  WooCommerce la manda) y `itemsAcumulados`. Antes sólo había un log al
  terminar todo el recurso — con miles de registros eso significa minutos
  sin ninguna señal de que el proceso sigue vivo, que es exactamente lo que
  pasó en la prueba que originó esta ADR.

**Consecuencias**: Una instalación nueva del sistema (o un recurso que
pierde su cursor por algún motivo) nunca vuelve a traer sorpresivamente
años de histórico — el volumen de la primera carga es predecible y
acotado. El costo es que, si en algún momento SÍ hace falta el histórico
completo (P-21), hay que acordarse de setear
`INGESTA_HISTORIC_COMPLET=true` a propósito para esa corrida puntual — es
el trade-off deliberado de esta ADR: hacer el caso común (no soprender con
volumen) fácil, y el caso raro (migrar histórico) explícito en vez de
implícito.

---

## ADR-018 — La transformación de catálogo nunca crea un `producte` sin SKU

**Estado**: Aceptado.

**Contexto**: Probando la transformación de catálogo contra los 4.250
pedidos reales, apareció un bug: `SELECT count(*) FROM producte` daba 144 en
vez de los ~111 esperados. Los 33 de más tenían `codi IS NULL` (el
diagnóstico inicial creyó que era `codi = ''`, pero `length(codi)` confirmó
NULL — la diferencia importa: el índice único de `codi` es parcial (`WHERE
codi IS NOT NULL`, ver ADR-008/0002), así que NULL nunca colisiona consigo
mismo, no hay ningún problema de UNIQUE de por medio).

Causa raíz, en `transform/cataleg.ts`, función `obtenirOCrearArticle`: la
búsqueda de un `producte` ya existente por `codi` sólo se intentaba **si
`sku !== null`**. Para un producto de WooCommerce sin SKU, esa búsqueda se
saltaba enteramente y el código caía directo al `INSERT INTO producte`, sin
condición — cada producto sin SKU terminaba con su propio `producte`
fantasma. Esto contradice el criterio ya acordado en la capa 6 (y ya
implementado correctamente en `resolucio-article.ts` para líneas de
pedido): un producto/línea sin SKU **nunca crea un registro nuevo**, se
registra como incidencia y queda sin resolver. La transformación de
catálogo nunca había implementado esa misma regla para sí misma — de hecho
un test de esa época (`cataleg.test.ts`) afirmaba explícitamente "un
artículo sin código crea el producte con codi null, sin romper", validando
el comportamiento incorrecto en vez de detectarlo.

El impacto real fue mayor de lo que sugería el conteo de `producte`: 2.534
líneas de 2.053 pedidos (de 4.250, casi la mitad) habían "resuelto" su
artículo contra uno de estos fantasmas, vía `alias_producte` — porque el
alias sí existía (se creaba igual, apuntando al fantasma), y la resolución
de línea (paso 1, alias exacto) encontraba ese alias sin saber que el
`producte` del otro lado era ilegítimo.

**Decisión**:

- `obtenirOCrearArticle` devuelve `null` cuando el producto no tiene SKU,
  **antes** de tocar categoría o de intentar ningún INSERT. El llamador
  (`transformarCataleg`) no crea `producte` ni `alias_producte` en ese
  caso — registra una incidencia y sigue con el próximo producto.
- Nueva tabla `incidencia_cataleg` (migración 0007), mismo patrón que
  `incidencia_comanda` pero sin `comanda_id`: la referencia es al
  `woo_product_id`, porque justamente no hay ningún `producte` propio que
  referenciar. Índice único parcial `(woo_product_id) WHERE NOT resolta`
  para que correr `transformarCataleg` en cada ciclo de sync no acumule una
  incidencia nueva por corrida mientras el producto siga sin SKU — mismo
  criterio de "como máximo una incidencia abierta" que ya regía en la
  columna `codi` de `producte`.
- **Migración de limpieza** (0007, mismo archivo que crea la tabla): por
  cada `producte` con `codi IS NULL` — que después de este fix nunca puede
  ser un estado legítimo, así que la condición sola identifica exactamente
  el conjunto afectado por el bug, acá y en cualquier otro entorno donde
  haya llegado a correr — se registra la incidencia de catálogo
  correspondiente, se marcan como `amb_incidencia` los pedidos con líneas
  que habían "resuelto" contra ese fantasma (con su propia
  `incidencia_comanda`, tipo `article_no_resolt`, el mismo tipo que usa
  `transformarComanda`), esas líneas vuelven a `producte_id`/
  `alias_producte_id` NULL (sin tocar la traza cruda de WooCommerce en la
  línea), y recién ahí se borran los `alias_producte` huérfanos y los
  `producte` fantasma.

**Consecuencias**: `transformarCataleg` ahora es fiel al mismo criterio que
ya regía en el resto del sistema — nunca crea un registro para representar
"no sé qué es esto", siempre dice explícitamente "no se pudo resolver".
Los ~2.053 pedidos que quedaron `amb_incidencia` por la migración necesitan
revisión de oficina para volver a resolver sus artículos (algunos de esos
productos no tienen SKU de verdad en WooCommerce — 14 artículos publicados
sin código, según `docs/hallazgos-woocommerce.md` — así que parte de este
trabajo es de negocio, no técnico: decidir si se les asigna código o se
vive con la incidencia). Test de regresión en `cataleg.test.ts` cubre
específicamente el escenario de dos productos DISTINTOS sin SKU, para que
esta clase de bug (colisión o ausencia de colisión en una columna nullable)
no vuelva a pasar desapercibida.

---

## ADR-019 — Capa 8: endpoints de negocio del contrato de API

**Estado**: Aceptado.

**Contexto**: `docs/contrato-api.md` (v1.0, acordado con Michel) especifica
la forma exacta de cada endpoint de negocio — categorías, catálogo,
tarifas, clientes, transportistas, pedidos y los tres paneles. Construir
esta capa exigió varias decisiones que el contrato no fija explícitamente
(porque describe la forma JSON, no el esquema de base subyacente) y que se
documentan acá para que no queden implícitas.

**Decisiones**:

- **Identificadores públicos secuenciales, separados del UUID interno.**
  El contrato usa enteros pequeños en cada ejemplo (`"id": 12`, `"id": 142`,
  `"id": 981`...) — son literalmente lo que Michel copia a sus mocks mañana.
  Las claves primarias siguen siendo UUID (nada del sync ni de las FK
  cambia), pero cada tabla expuesta por API suma una columna `id_seq BIGINT
GENERATED ALWAYS AS IDENTITY` de sólo lectura para el mundo externo
  (migración 0008). Las rutas resuelven `id_seq → UUID` en cada
  petición (`resolverProducteUuid` y equivalentes en `comu.ts`) — nunca
  exponen el UUID, nunca aceptan un UUID como `:id` de la URL.
- **Los decimales llegan como string prácticamente gratis.** `pg` ya
  devuelve columnas `NUMERIC` como string de JavaScript (nunca como
  `number`, justamente para no perder precisión) y Postgres respeta la
  escala declarada del tipo (`NUMERIC(10,2)` imprime `"9.50"`, no `"9.5"`).
  Para los valores calculados (sumas de `totalKg`/`totalEur` en listados y
  paneles) alcanza con castear el resultado a `numeric(14,2)`/`numeric(14,3)`
  explícitamente — no hace falta ningún formateador manual en JS. Las
  fechas si necesitan un paso propio: `pg` las devuelve como `Date`, y
  `formatearDataApi` (en `comu.ts`) las lleva a ISO-8601 con `Z` sin
  milisegundos, tal como pide el contrato.
- **`producte.nom` pasa a llamarse `descripcio`**, y se agregan
  `descripcio_venda`, `preu_venda` y `tipus` (nuevas, sin origen en
  WooCommerce salvo `tipus`, que sí viene de `payload.type` y se
  backfillea para los 111 artículos existentes desde el crudo ya
  aterrizado). `categoria_producte` suma `elaborat_porc` (arranca en
  `false`, es clasificación de negocio que hay que revisar a mano — no se
  puede inferir) y `agrupacio_rendiment` (siempre `null`, contrato sección 7).
- **Tabla nueva `tarifa_preu`** (tarifa × producte): no existía ninguna
  estructura para la matriz de precios — `tarifa` sólo tenía un `import`
  genérico sin usar. `PATCH /tarifes/:tarifaId/preus/:producteId` hace un
  upsert de una sola celda, tal como pide el contrato ("edición en línea
  sin ventana emergente").
- **`client`/`transportista` suman las columnas que el contrato necesita**
  (`codi`, `nom`, `telefon`, `poblacio`, `tarifa_id`,
  `transportista_defecte_id`, `actiu`) sin tocar el sync: la ingesta de
  clientes desde WooCommerce no existe todavía (criterio de identificación
  de cliente sin confirmar, ver CLAUDE.md) — estas columnas quedan
  disponibles para cuando se construya, y mientras tanto se completan a
  mano vía `PATCH /clients/:id`.
- **`comanda.num`** ("2026-0142") se genera con un contador global
  (`num_seq BIGINT GENERATED ALWAYS AS IDENTITY`) que **no se reinicia por
  año** — es más simple y no tiene condiciones de carrera comparado con un
  contador que arranque de nuevo cada enero. El cálculo (`to_char` sobre
  `creat_en`) no puede ser una columna `GENERATED ... STORED`: Postgres
  considera `to_char()`/`EXTRACT()` sobre `TIMESTAMPTZ` como `STABLE`, no
  `IMMUTABLE` (dependen del huso horario de la sesión), así que se resuelve
  con un trigger `BEFORE INSERT` — el patrón estándar de Postgres para
  este caso. Si el cliente pide numeración que reinicie cada año, es un
  cambio de trigger, no de esquema.
- **`comanda.observacions` se separa en `obs_produccio` (renombrada) y
  `obs_lliurament` (nueva)**, y `comanda_linia` suma su propio
  `obs_produccio` — el contrato distingue observaciones de producción de
  observaciones de entrega, y antes había una sola columna genérica.
  `comanda.data_entrega` se renombra a `data_lliurament` (mismo campo,
  nombre del contrato).
- **`PATCH .../lliurament` rechaza con `409 CONFLICTE` si la comanda está
  congelada** — pedido explícito, aplicado literalmente aunque a primera
  vista genere tensión con que el empaquetado ocurre lógicamente después
  de que el pedido "entra en producción": la regla de negocio real que
  resuelve esa tensión no está definida todavía, así que acá se implementa
  el criterio que se pidió, no una interpretación propia.
- ~~**`confirmatPer` es un valor fijo, no un usuario real.**~~ **Actualizado
  por ADR-021**: desde la capa 9, `confirmatPer` lleva el `uid` real que
  adjunta el middleware de autenticación (`{ id: 0, nom: usuari.uid }` — el
  `id: 0` se mantiene porque todavía no hay tabla de usuarios; `nom` ya no
  es un placeholder). En modo desarrollo sin token (`AUTH_DISABLED=true`)
  el uid es el fijo `"dev-sense-auth"`, no un operario real.
- ~~**Ningún endpoint de negocio valida autenticación todavía.**~~
  **Actualizado por ADR-021**: la capa 9 agrega el middleware real de
  Firebase Auth sobre todas las rutas de `/api/v1`. La brecha descrita acá
  ya está cerrada, salvo el bypass explícito y controlado de desarrollo
  (`AUTH_DISABLED`, ver ADR-021).

**Consecuencias**: Michel puede construir el frontend contra esta API real
desde ahora — la forma exacta coincide con el contrato, incluidos los
casos que más suelen romper interfaces cuando aparecen tarde (`pesKg`
null, `congelada: true`, error `400 VALIDACIO` con `detalls`). El costo
principal es la resolución `id_seq ↔ UUID` en cada ruta que toca una FK
(filtros, cuerpos de POST/PATCH) — más verboso que usar el UUID
directamente, pero es el precio de que la API hable en los mismos enteros
que ya usa el contrato. Verificado end-to-end contra la base de desarrollo
real: el filtro `?estat=amb_incidencia` sobre `GET /comandes` devuelve
exactamente los 2.216 pedidos marcados por la migración 0007/ADR-018.

---

## ADR-020 — Resolución de cliente: NIF primero, email después (supuesto por defecto, no cerrado)

**Estado**: Aceptado como supuesto por defecto — **no confirmado por
Integraly**. Ver P-11 del backlog. Reversible: es una función aislada
(`transform/resolucio-client.ts`) y dos índices de base, no algo entretejido
en el resto del sistema — cambiar el criterio el día que Integraly lo
confirme o lo corrija no debería tocar nada más.

**Contexto**: Probando la capa 8 en vivo con Postman apareció otro hallazgo
real: `GET /clients` devolvía `total: 0`. Verificado contra la base real:
`client` tenía 0 filas y ninguno de los 4.250 pedidos transformados tenía
`comanda.client_id`. Causa raíz, confirmada con dos búsquedas de git
(`git log --all -p -S"resolverClient"` y `-S"client_id"` sobre
`transform/comandes.ts`, cero resultados en toda la historia): la función de
resolución de cliente **nunca se había escrito**, no es una regresión ni un
`try/catch` que traga el error. Consistente con CLAUDE.md, que desde el
arranque del proyecto lista "criterio final de identificación de cliente"
como pendiente de definición con el cliente — la brecha estaba documentada
desde el principio, sólo que sin una función que la materializara.

**Decisión**: Se implementa un criterio por defecto — **NIF primero, si no
hay, email** — para no dejar la capa 8 sin datos de cliente mientras se
espera una confirmación formal. No es la decisión final; es exactamente el
mismo tratamiento que el resto de los puntos "pendientes de definición con
el cliente" del proyecto: se documenta como supuesto, se implementa de forma
aislada y reversible, y se corrige cuando llegue la confirmación real.

Detalle técnico (`transform/resolucio-client.ts`):

- El NIF llega por `meta_data`, bajo **dos** claves que representan lo
  mismo: `nif` (2.331 de 4.250 pedidos con valor) y `_billing_myfield5`
  (812 con valor — la clave está en casi todos los pedidos, pero vacía la
  mayoría de las veces). `hallazgos-woocommerce.md` sólo documentaba estas
  dos; no hay una tercera clave con volumen relevante. De los 419 pedidos
  donde ambas claves traen valor, 85 difieren entre sí — se prioriza `nif`
  por tener un nombre explícito (heurística, no confirmada, mismo criterio
  que `inferirIdiomaHeuristic`).
- El email **no** viene en `meta_data`: vive en `billing.email`, un campo
  estándar de WooCommerce que el tipo `WooOrder` nunca había declarado
  (se agrega `WooBilling` a `@dpages/shared`). Cobertura verificada: **100%
  de los 4.250 pedidos reales** — mucho más confiable que el NIF (64%).
- Resolución con upsert atómico (`INSERT ... ON CONFLICT`), no
  "`SELECT` y después `INSERT`": el lock de concurrencia de
  `transformarComanda` (`pg_advisory_xact_lock`) es por `woo_order_id`, no
  por cliente, así que dos pedidos del MISMO cliente nuevo procesados casi
  al mismo tiempo (webhook + polling) no quedan serializados entre sí sin
  esto. Requiere subir `idx_client_nif`/`idx_client_email` a únicos de
  verdad (migración 0009 — antes eran índices simples desde la capa 3).
- El `UPDATE` del upsert nunca pisa un dato ya cargado
  (`COALESCE(client.columna, EXCLUDED.columna)`, sólo completa huecos) —
  ni el que puso el propio sync en un pedido anterior, ni el que oficina
  cargó a mano vía `PATCH /clients/:id`.
- `transform/comandes.ts` vincula el cliente **antes** de la rama del
  guardián de versión (ADR-004), a propósito: vincular cliente no es un
  dato "de versión" que deba esperar una actualización más nueva de
  WooCommerce — es un backfill idempotente. Esto es lo que permite que
  volver a correr `transformarComandes` sobre los pedidos ya aterrizados
  (sin re-ingestar desde WooCommerce) rellene `client_id` en los 4.250
  pedidos existentes, sin necesitar un script aparte.

**Casos límite verificados con Postgres real, no sólo razonados**:

- Mismo NIF en dos pedidos → mismo cliente, no duplica, conserva el email
  del primero que lo creó (no lo pisa el segundo).
- NIF nuevo cuyo _email_ coincide con el de otro cliente ya existente → el
  `ON CONFLICT` declarado es sobre `nif`, así que el conflicto real cae en
  el índice único de `email` (no es el target declarado) y Postgres lo
  **rechaza con un error real**, no lo resuelve solo ni crea un duplicado.
  Ese pedido puntual queda como error aislado (contado en
  `ResultatTransformacioComandes.errors`, logueado), el resto del lote
  sigue — mismo patrón de aislamiento por pedido que ya existía.
- `client.woo_customer_id` tiene un índice único desde la capa 3
  (`idx_client_woo_customer_id`) que el criterio NIF→email no declara como
  target de conflicto — si el NIF/email resuelto para un pedido no calza
  con lo ya registrado para ese mismo `woo_customer_id`, la inserción
  falla por esa restricción en vez de por NIF/email. Mismo tipo de fallo
  aislado y no silencioso que el caso anterior. **Se predijo "raro en la
  práctica" y la predicción fue incorrecta — ver el hallazgo de calidad de
  dato más abajo, con los números reales.** Queda sin resolver a propósito
  en esta ADR, pendiente de decidir junto con el resto de P-11.
- Pedido sin NIF ni email resoluble: no crea cliente, `comanda.client_id`
  queda `NULL`, y se registra incidencia `sense_dades_client` (una por
  pedido, no se acumula en corridas repetidas) para que no quede invisible
  para oficina. En los 4.250 pedidos reales esto no ocurrió ni una vez — el
  email tiene 100% de cobertura real, confirmado, no sólo esperado.

### Hallazgo de calidad de dato: el NIF/email de un mismo cliente varía entre sus propios pedidos

**Esto es un hallazgo sobre los datos de WooCommerce, no un detalle de
implementación del upsert** — vale la pena escalarlo a Integraly con
números concretos (P-11), más allá de si el criterio de resolución termina
siendo NIF→email o cualquier otro.

Al aplicar la migración 0009 y reprocesar los 4.250 pedidos ya aterrizados
(sin volver a consultar la API de WooCommerce), **444 pedidos (10,4% del
total) fallaron por una contradicción de identidad**, no por falta de
dato:

- **228 pedidos**: el NIF/email resuelto no coincide con el ya registrado
  para el mismo `woo_customer_id` (la misma cuenta logueada de
  WooCommerce).
- **216 pedidos**: el NIF resuelto es nuevo, pero el email coincide con el
  de un cliente ya existente que tiene un NIF distinto.

Es decir: **el mismo cliente (misma cuenta, o mismo email) trae un NIF
distinto en pedidos distintos**, en más de 1 de cada 10 pedidos. Esto es
consistente con — y probablemente la misma causa raíz que — el hallazgo ya
documentado de que `nif` y `_billing_myfield5` (las dos claves de
`meta_data` que representan el NIF) difieren entre sí en 85 de los 419
pedidos donde ambas traen valor: el dato de NIF que carga el cliente en el
checkout de WooCommerce es inconsistente pedido a pedido, no sólo entre
las dos claves de un mismo pedido.

Estos 444 pedidos se marcaron con incidencia `conflicte_identitat_client`
(migración de datos puntual, sin volver a tocar `client_id` ni reprocesar
nada — el `detall` de cada incidencia dice cuál de los dos índices chocó,
para que oficina sepa por dónde investigar sin adivinar). Quedan
`amb_incidencia`, visibles, no perdidos — pero **no resueltos**: alguien
tiene que decidir, para cada uno, cuál de los dos NIF (o si ambos) es el
correcto, y eso es exactamente el tipo de decisión que depende del
criterio final de identificación de cliente que todavía no confirmó
Integraly.

> **Actualización (ADR-023):** el "se marcan con incidencia" de arriba
> describía sólo el script puntual sobre estos 444 históricos — el camino
> en vivo (`transformarComanda`, el que corre en cada sincronización real)
> **no** tenía este manejo: dejaba que el mismo conflicto hiciera
> `ROLLBACK` del pedido entero, perdiéndolo en silencio. Corregido en
> ADR-023 — ahí está el detalle de la causa y la corrección.

**Consecuencias**: `GET /clients` deja de estar vacío. De los 4.250
pedidos: **3.806 (89,5%) quedaron con `client_id` resuelto**, **444
(10,4%)** con incidencia `conflicte_identitat_client` (dato contradictorio
entre pedidos del mismo cliente, sin resolver a propósito), y **0** con
`sense_dades_client` (nunca faltó el dato — cuando falló, fue por
contradicción, no por ausencia). El costo es que el criterio de matching
(NIF→email, sin considerar `woo_customer_id` como tercera vía) es una
decisión nuestra, no del cliente, y los números de arriba son evidencia
real de que la calidad del dato de NIF en WooCommerce no alcanza para
resolverlo sólo con código — si Integraly confirma otro criterio o aporta
un dato más confiable (P-11), esta ADR se marca `Superseded` y se corrige
`resolucio-client.ts`, no el resto del sistema.

---

## ADR-021 — Firebase Auth: autenticado sí, restringido por rol no

**Estado**: Aceptado.

**Contexto**: el contrato de API (`docs/contrato-api.md`, sección 2) exige
`Authorization: Bearer <token de Firebase>` en toda ruta de negocio salvo
`/salut`, y hasta ahora eso no estaba implementado — el backend en modo
desarrollo aceptaba cualquier petición sin token (ver ADR-019, brecha
esperada de esa capa). Michel crea el proyecto de Firebase recién ahora
(guía de GCP); no hay credenciales reales todavía.

Sobre permisos: el cliente decidió (ver `contexto-negocio.md`, sección
"Roles y permisos") que no hace falta restringir accesos — todo usuario
autenticado ve y opera cualquiera de los cuatro paneles, el rol sólo decide
la ubicación por defecto al entrar. VisioFlow decidió igual mantener
Firebase Auth con roles (mismo criterio de la propuesta original), para
tener `uid` y rol disponibles en auditoría aunque no se usen para bloquear
nada.

**Decisión**:

- **Middleware de verificación real, no una capa cosmética.** Un
  `preHandler` de Fastify (`crearMiddlewareAuth`, en `http/auth-firebase.ts`)
  usa `firebase-admin` (`getAuth(app).verifyIdToken`) para validar el token
  del header `Authorization`. Sin token o con un token inválido: `401
NO_AUTENTICAT`, misma forma de error del contrato. No valida ningún rol —
  cualquier usuario autenticado pasa.
- **El hook vive sólo dentro del scope de plugin `/api/v1`.** Se registra
  con `api.addHook('preHandler', ...)` adentro del `fastify.register(...,
{ prefix: '/api/v1' })` de `servidor.ts`, antes de las rutas de negocio.
  `/salut`, `/webhooks/woocommerce` y `/tasques/*` se registran en la
  instancia externa de `fastify`, fuera de ese scope — la encapsulación de
  plugins de Fastify los excluye automáticamente, sin necesidad de
  chequear rutas a mano. Cada uno sigue con su propio mecanismo (sin
  autenticación, HMAC, y secreto compartido/OIDC respectivamente — ADR-009,
  ADR-016).
- **Bypass de desarrollo, mismo criterio que la guarda de `WC_BASE_URL`
  (config/env.ts).** `AUTH_DISABLED=true` salta la verificación real y
  adjunta un uid fijo (`"dev-sense-auth"`, rol `null`) — pero sólo existe
  como variable explícita, y `config/env.ts` rechaza el arranque completo
  si `NODE_ENV=production` y `AUTH_DISABLED=true` a la vez. El caso seguro
  (token obligatorio) es el default; el bypass es opt-in y estructuralmente
  imposible de desplegar a producción por descuido.
- **Verificador inyectable, para no depender de un proyecto de Firebase
  real en los tests.** `crearMiddlewareAuth(verificador: VerificadorToken =
verificarTokenFirebase)` recibe la función de verificación como parámetro
  — los tests inyectan un verificador simulado (`auth-firebase.test.ts`);
  la implementación real (`verificarTokenFirebase`) inicializa el SDK de
  Firebase de forma perezosa (recién en el primer uso real, nunca al
  importar el módulo) y nunca se ejecuta en este repo hoy. En Cloud Run
  usará las credenciales por defecto de la instancia (ADC), sin variables
  nuevas; en local, sólo si algún día se prueba con `AUTH_DISABLED=false`
  contra un proyecto real, hace falta `GOOGLE_APPLICATION_CREDENTIALS`
  (estándar del SDK, no una variable propia — ver `.env.example`).
- **`uid` y `rol` quedan en `req.usuari`** (augmentación de tipos de
  Fastify, mismo patrón que `req.rawBody` en `webhook.ts`), disponibles
  para el resto del handler. Primer uso real: `PATCH
.../linies/:liniaId/lliurament` graba el `uid` en
  `comanda_linia.confirmat_per` (antes un marcador de texto fijo, ver
  ADR-019) y lo devuelve en `confirmatPer.nom` de la respuesta — deja de
  ser un placeholder.

**Consecuencias**: las rutas de negocio exigen autenticación real desde
ahora (salvo el bypass explícito de desarrollo); ningún endpoint bloquea
por rol, como pidió el cliente. Cuando exista el proyecto de Firebase real,
activar la verificación es sólo configurar `AUTH_DISABLED` (o quitarla) y,
en local, `GOOGLE_APPLICATION_CREDENTIALS` — no cambia ningún código. El
costo es que `req.usuari.rol` queda sin uso real por ahora (ninguna ruta lo
lee) más allá de quedar disponible para cuando el frontend decida el panel
por defecto y para auditoría; si el cliente cambia de criterio y pide
restringir por rol más adelante, el punto de enganche ya existe
(`req.usuari.rol` en cada handler) y no hace falta tocar el middleware.

**Nota (30/08/2026) — capa 39/43, el punto de enganche ya se usó, pero
sin efecto real todavía**: pese a lo dicho arriba, sí llegaron guards de
módulo puntuales — `crearGuardaModul` en `usuaris`/`rols` (capa 39,
hallazgo de seguridad) y en `origens-comanda` (capa 43, `'comandes'`).
El de `origens-comanda` está construido y probado (test con un rol
sintético), pero **hoy no bloquea a nadie en la práctica**: los únicos 2
roles existentes (`Administrador`, `General`, ver ADR de migración
`0014_usuaris_i_rols`) tienen ambos el módulo `'comandes'` en
`moduls_permesos`. Va a empezar a tener efecto real recién el día que
exista un rol más restrictivo sin ese módulo — que quede registrado acá
para que no se confunda con un bug cuando eso pase.

---

## ADR-022 — CI necesita su propio Postgres efímero, con el mismo puerto que espera `vitest.config.ts`

**Estado**: Aceptado.

**Contexto**: **todos** los runs de CI fallaron desde el primer commit del
repositorio (`gh run list` lo confirma: 10/10 runs en rojo, capa 1 en
adelante) con la misma firma — `Error: Connection terminated unexpectedly`
en `pg`, `TypeError: Cannot read properties of undefined (reading 'end')`
al intentar cerrar una conexión que nunca llegó a abrirse, y
`salut.test.ts` recibiendo `503` en vez de `200` (exactamente la respuesta
correcta de `/salut` cuando `pool.query('SELECT 1')` falla — ver
`salut.ts`). Los tres síntomas apuntan a lo mismo: ningún test pudo hablar
con Postgres.

**El diagnóstico inicial ("CI nunca declaró un servicio de Postgres") no
era correcto** — `ci.yml` tiene un `services.postgres` con healthcheck
desde la capa 1 (`136baa0`), antes de que existiera un solo test que
tocara base de datos. La causa real, confirmada leyendo `vitest.config.ts`
junto con `ci.yml`, es más específica y más interesante:

- `vitest.config.ts` (`test.env`) fija `DATABASE_URL` a
  `postgres://dpages:dpages@localhost:5434/dpages_test` — puerto **5434**,
  el mismo que usa `postgres-test` en `docker-compose.yml` (efímero,
  tmpfs, para no correr tests contra los datos de desarrollo). Este bloque
  se aplica SIEMPRE que corre `vitest run`, sin importar el entorno.
- El `services.postgres` de `ci.yml` mapeaba el contenedor al puerto de
  host **5432** (el default de Postgres, no el 5434 que espera
  `vitest.config.ts`).
- `ci.yml` además declaraba su propio `env.DATABASE_URL` a nivel de job,
  también apuntando al 5432 — una **segunda copia** del mismo dato,
  redundante con la de `vitest.config.ts` y nunca leída por
  `vitest run` (el `test.env` de Vitest siempre gana sobre el `env` del
  proceso que lo invoca).

Ninguna de las dos copias estaba "mal" en el sentido de tener un error de
sintaxis — simplemente **dejaron de coincidir**, y nada detectaba esa
divergencia porque el job-level `env.DATABASE_URL` de CI resultaba
inerte: ninguno de los cinco pasos del workflow (`npm ci`, lint,
typecheck, test, build) ejecuta código que lea `config/env.ts` en tiempo
de ejecución excepto `npm run test`, y ese paso ignora por completo el
`env` del job en favor del suyo propio.

**Decisión**:

1. **El puerto de host del servicio de Postgres de CI pasa a ser 5434**
   (`ports: ["5434:5432"]`, el contenedor sigue escuchando en el 5432
   interno de siempre) — para coincidir con lo único que
   `vitest.config.ts` realmente usa, en cualquier entorno donde corra.
2. **Se elimina el `env.DATABASE_URL`/`NODE_ENV` a nivel de job en
   `ci.yml`.** No se "corrige" el valor a 5434 y se deja — se borra,
   porque mantener una segunda copia de un dato que ya tiene una única
   fuente de verdad (`vitest.config.ts`) es precisamente el patrón que
   causó este incidente: nada obliga a que las dos copias avancen juntas.
   Ningún paso del workflow necesita esa variable.
3. **No hace falta un paso explícito de "aplicar migraciones antes de los
   tests".** Cada archivo de test que toca base crea su propio esquema
   descartable y corre `migrarArriba` sobre él (mismo patrón en
   `webhook.test.ts`, `tasques.test.ts`, `test-suport.ts` de
   `rutes/api/`, y el propio `db/migrate.test.ts`, que testea el runner de
   migraciones directamente). No existe ningún test que dependa de un
   esquema `public` pre-migrado — agregar ese paso sería trabajo sin
   ningún test que lo necesite.
4. **`actions/checkout` y `actions/setup-node` se actualizan a `v7`**
   (desde `v4`) para dejar de correr sobre una versión de Node.js que
   GitHub ya marca deprecada para sus propias actions — sin relación con
   el bug de Postgres, pero mismo commit por ser otro ítem de
   mantenimiento de bajo riesgo en el mismo archivo.

**Por qué CI necesita su Postgres propio, separado del de desarrollo y el
de test locales** (aunque esto no era la causa del bug, vale dejarlo
explícito porque `ci.yml` lo asume sin decirlo): un service container de
GitHub Actions vive y muere con el job — no hay estado que sobreviva entre
runs, ni riesgo de que un run deje datos que contaminen el siguiente. Es
un tercer Postgres, ni el de desarrollo (`docker-compose`, puerto 5433)
ni el de test local (`postgres-test`, puerto 5434, aunque casualmente
comparte puerto por la razón de arriba) — nunca hay que sincronizar su
estado con nada, cada run empieza de cero.

**Consecuencias**: si `vitest.config.ts` alguna vez cambia el puerto o la
forma de `DATABASE_URL`, `ci.yml` deja de funcionar de la misma manera
silenciosa en que dejó de funcionar acá — pero ahora hay un único lugar
(`vitest.config.ts`) que hay que mirar, no dos que puedan desalinearse sin
que nada avise. Verificado: la corrección se empujó como commit aparte
después de este ADR y el run correspondiente en la pestaña Actions del
repositorio quedó en verde (ver el commit de este cambio para el enlace
al run).

---

## ADR-023 — Corrección de bug: un conflicto de identidad de cliente perdía el pedido entero en silencio

**Estado**: Aceptado. **Esto es la corrección de un bug de pérdida
silenciosa de datos, no una mejora ni una decisión de diseño nueva** — el
comportamiento anterior era incorrecto, no una elección previa que este
ADR reemplaza por otra.

**Contexto**: ADR-020 documentó que resolver el cliente de un pedido
(`resolverOCrearClient`) puede chocar contra un índice único de `client`
distinto del que declara `ON CONFLICT` — el NIF o el email de un pedido
nuevo a veces ya pertenecen a otro cliente ya registrado, con proporción
estable de ~10% de los pedidos reales. Para los 4.250 pedidos históricos,
ese 10% (444 casos) se marcó con incidencia `conflicte_identitat_client`
mediante un **script SQL puntual, corrido una sola vez** sobre datos ya
aterrizados — nunca se integró al camino en vivo de `transformarComanda`.

Al limpiar la base de desarrollo (dejar sólo pedidos desde el 1 de agosto)
y volver a correr la ingesta + transformación real sobre 216 pedidos de
los últimos 30 días, apareció el mismo ~10% de conflictos (22 de 216) —
pero esta vez a través del código que corre en producción, no del script
de ayer. El resultado fue **20 pedidos que nunca llegaron a existir como
`comanda`, y 2 que ya existían pero quedaron atascados** (cada
sincronización futura volvía a fallar en el mismo punto, sin poder
actualizar su cabecera ni vincular cliente) — ninguno de los 22 visible
para oficina, ninguno con incidencia, sin ningún error en primer plano:
`transformarComandes` sólo incrementaba un contador `errors` y seguía con
el resto del lote.

**Causa raíz**: `resolverOCrearClient` dejaba que la excepción de Postgres
(`unique_violation`, código `23505`) se propagara sin capturar. Como
`transformarComanda` corre dentro de una única transacción por pedido
(`BEGIN`/`COMMIT`/`ROLLBACK`), esa excepción hacía `ROLLBACK` de **todo**
lo que ese pedido llevaba escrito hasta ahí — cabecera, líneas, todo — no
sólo la resolución de cliente que había fallado.

**Decisión**:

- **`resolverOCrearClient` captura específicamente `23505` cuando el
  índice que chocó es uno de los tres conocidos** (`idx_client_nif`,
  `idx_client_email`, `idx_client_woo_customer_id`, ver migraciones 0003 y 0009) y lo traduce a una excepción propia, tipada:
  `ConflicteIdentitatClient` (con `.index` indicando cuál de los tres). No
  es un `catch` genérico — cualquier otro error (columna inexistente,
  conexión caída, lo que sea) se sigue propagando exactamente como antes.
- **`SAVEPOINT` alrededor del `INSERT` riesgoso**, no sólo un `try/catch`
  en JavaScript: un `unique_violation` deja TODA la transacción de
  Postgres en estado `aborted` hasta el próximo `ROLLBACK`, sin importar
  que el error ya se haya capturado del lado de la aplicación — capturar
  la excepción en JS no alcanza para seguir usando la misma conexión.
  `SAVEPOINT resolucio_client` / `ROLLBACK TO SAVEPOINT` acota el daño a
  ese único `INSERT`, dejando el resto de la transacción del pedido
  utilizable. Se encontró este problema empíricamente al escribir el test
  de integración (`current transaction is aborted, commands ignored...`),
  no se anticipó de entrada.
- **`transformarComanda` captura `ConflicteIdentitatClient`** en el punto
  donde antes llamaba a `resolverOCrearClient` sin protección: el pedido
  se crea/actualiza igual, con `client_id` en `NULL`, y se registra una
  incidencia `conflicte_identitat_client` con el índice que chocó en el
  `detall` — mismo patrón exacto que `sense_dades_client` (que sí
  funcionaba bien en el camino en vivo desde ADR-020; sólo el caso de
  conflicto, no el de ausencia de datos, se estaba perdiendo). Chequeo de
  idempotencia igual que las otras incidencias: no acumula una fila nueva
  en cada corrida mientras el conflicto siga sin resolverse a mano.

**Consecuencias**: verificado end-to-end sobre los 216 pedidos reales de
los últimos 30 días — antes de la corrección, 20 no existían y 2 estaban
atascados; después de reprocesar (sin volver a traer nada de WooCommerce),
`SELECT count(*) FROM comanda` da **216** (los 216 aterrizados, ninguno
perdido) y `SELECT count(*) FROM incidencia_comanda WHERE tipus =
'conflicte_identitat_client'` da **22** (exactamente los que antes
desaparecían o quedaban atascados). Test de integración nuevo en
`transform/comandes.test.ts` reproduce el escenario a través de
`transformarComanda` tal como corre en producción (no el script de
batch), con un conflicto de email y uno de `woo_customer_id`,
confirmando que ambos pedidos terminan existiendo con su incidencia.
El costo es el `SAVEPOINT` extra por pedido en el ~10% de los casos que
chocan — insignificante frente a perder el pedido entero.

---

## ADR-024 — Sincronización con WooCommerce resuelta en backend, sin n8n

**Estado**: Aceptado.

**Contexto**: En una etapa temprana del proyecto se evaluó apoyar la
sincronización con WooCommerce en n8n (automatización de terceros) en vez de
resolverla con lógica propia. El equipo técnico decidió que no hacía falta
depender de una herramienta externa para esto: el mecanismo real que
terminó implementándose — webhook de notificación + polling incremental con
cursor + reconciliación diaria, aterrizaje crudo y transformación propia
(ADR-002/003, `sync/ingesta.ts`, `transform/comandes.ts`) — se resuelve
enteramente a nivel de backend, sin ninguna pieza intermedia.

**Decisión**: No usar n8n. Toda la lógica de sincronización (ingesta,
normalización, resolución de artículo/cliente, idempotencia) vive en el
backend del proyecto, en el código versionado de este repositorio.

**Fecha**: no documentada con precisión en ningún commit ni ADR anterior a
este. La evidencia indirecta disponible: el primer código de ingesta
(`sync/ingesta.ts`, capa 5) se integró el 2026-08-15, ya con el mecanismo de
cursor/polling que reemplaza cualquier automatización externa — por lo que
para esa fecha la decisión de no depender de n8n ya estaba tomada y
funcionando. Se documenta como aproximación razonable, no como fecha exacta
confirmada; falta cerrarla con precisión con el equipo si hiciera falta para
algún entregable formal.

**Consecuencias**: Ninguna dependencia externa de automatización en el
stack de sincronización — todo el comportamiento (reintentos, ventanas de
consulta, manejo de fallos) es código propio, testeado y versionado junto
al resto del backend, sin un sistema aparte que mantener o al que dar de
alta accesos.

## ADR-025 — Dirección y nota de entrega mapeadas desde WooCommerce (decidido internamente, pendiente de validación del cliente)

**Estado**: Decidido internamente, pendiente de validación del cliente —
ver auditoría del 08/10/2026 sobre los 3 pedidos reales guardados
(`aterratge_woocommerce`, woo_order_id 6711/6712/6713) y una muestra de 200
pedidos de la tienda real.

**Contexto**: Hasta esta tarea, `comanda.adreca_lliurament` y
`comanda.obs_lliurament` quedaban siempre `NULL` en los pedidos
sincronizados — la auditoría confirmó que WooCommerce sí trae los datos de
origen (`shipping.address_1/address_2/postcode`, `customer_note`) pero
`WooShippingAddress`/`WooOrder` (`@dpages/shared`) no los capturaban. No
existe ningún campo de fecha de expedición/entrega ni de transportista en el
payload real (se revisaron cabecera y `meta_data`) — esos siguen sin mapeo
posible, a completar por Oficina.

**Decisión**: cuatro reglas, todas aplicadas únicamente al CREAR la comanda
(`transform/comandes.ts:crearComanda`), nunca en la actualización posterior:

1. `WooShippingAddress` captura `address_1`/`address_2`/`postcode`
   (opcionales); `WooOrder` captura `customer_note` (opcional).
2. `adreca_lliurament = address_1 + ", " + address_2 (si no vacío) + ", " +
postcode (si no vacío)`, con `trim` en cada parte, sin `city` (ya va en
   `poblacio_desti`) y sin comas colgando. `NULL` si `address_1` falta/está
   vacío, o si algún `shipping_lines` tiene `method_id === 'local_pickup'`
   (recogida en tienda: no hay dirección de entrega que mapear).
3. `obs_lliurament = customer_note` con `trim`, `NULL` si falta o está vacía.
4. `actualitzarCapcaleraSiCorrespon` NO toca ninguna de las dos columnas:
   después de creadas son propiedad de Oficina (mismo criterio de ADR-005) —
   una actualización posterior de WooCommerce, aunque traiga una versión más
   nueva, nunca pisa lo que Oficina haya corregido a mano.

Ajuste relacionado (mismo cambio, sin ADR propio): una línea que WooCommerce
agrega en una actualización a una comanda YA EXISTENTE ahora hereda
`comanda_linia.data_produccio` de la cabecera (si la cabecera la tiene) —
antes quedaba siempre en `NULL`, invisible para Obrador/Producció (filtran
por `comanda_linia.data_produccio`, ver `http/rutes/api/panells.ts`). Ver
`transform/comandes.ts` (cálculo de `dataProduccioNoves`, antes de
`processarLinies`).

**Fecha**: 2026-10-08.

**Consecuencias**: cubre dos de los vacíos reales observados en los 3
pedidos auditados (dirección y nota), con una regla de negocio explícita
(`local_pickup`) en vez de dejarlo siempre a mano. `data_expedicio`,
`data_lliurament`, `transportista_id`, `bultos` y `tarifa_id` siguen sin
ningún origen posible en la tienda — siguen siendo 100% de Oficina, sin
cambios en esta tarea. Pendiente: validar con Francesc si el formato elegido
para `adreca_lliurament` y el destino de `customer_note` en
`obs_lliurament` son los esperados.

## ADR-026 — Líneas de un pedido sincronizado se protegen tras la primera edición de Oficina

**Estado**: Aceptado.

**Contexto**: Una verificación de solo lectura (08/10/2026, ver sección
"Reemplazo manual" del informe de esa fecha) probó, en un esquema
descartable, que `processarLinies` (`transform/comandes.ts`) rompía el
flujo "Oficina revisa y corrige un esborrany" en tres formas, todas
reproducidas con evidencia real: (a) pisaba `unitats_demanades`/
`preu_unitari`/pesos de una línea que Oficina ya había corregido a mano,
en la siguiente sincronización del mismo pedido; (b) marcaba `esborrat`
una línea agregada manualmente (sin `woo_line_item_id`) al no encontrarla
entre las líneas que "vinieron" en el payload; (c) recreaba como fila
nueva una línea que Oficina había borrado, duplicando el mismo
`woo_line_item_id` (una `esborrat=true`, otra `esborrat=false`). Esto es
coherente con ADR-005 tal cual estaba escrito (unidades/precio son "de
WooCommerce, el sync puede sobrescribir") — el problema no es una
contradicción de ADR-005, es que esa regla general no contempla el caso de
una corrección manual explícita sobre un pedido que de todos modos sigue
sincronizándose. No hay pedidos reales de WooCommerce en producción
todavía, así que no hay datos que migrar ni que reparar.

**Decisión**: columna nueva `comanda.linies_editades_a TIMESTAMPTZ`
(migración 0024, nullable, aditiva). La PRIMERA vez que una de las tres
rutas de línea de Oficina (`POST /comandes/:comandaId/linies`,
`PATCH`/`DELETE .../linies/:liniaId`) modifica una línea de un pedido con
`woo_order_id` no nulo, ese UPDATE fija `linies_editades_a = now()` en la
MISMA transacción que la modificación (`http/rutes/api/comandes.ts`,
función `protegirLiniesSiEsDeWoocommerce`) — si la modificación falla y
hace ROLLBACK, la marca tampoco queda. Las tres rutas toman el mismo
`pg_advisory_xact_lock(woo_order_id)` que ya usa `transformarComanda`, para
serializar la edición manual contra una sincronización concurrente del
mismo pedido. Un pedido de origen manual (`woo_order_id` nulo) nunca se
marca — nada lo sincroniza, así que no aplica.

En `transformarComanda` (`transform/comandes.ts`), para un pedido existente
y no congelado: si `linies_editades_a` no es nula, no se llama a
`processarLinies` ni se registra la incidencia `article_no_resolt` — la
cabecera sigue actualizándose exactamente como antes (estado web, total,
poblacón destino, `data_modificacio_woo`). `ResultatComanda.liniesProtegides`
y el contador `ResultatTransformacioComandes.comandesLiniesProtegides`
hacen visible cuántos pedidos están en este estado. Sin la marca, el
comportamiento es exactamente el de antes de este ADR.

**Fecha**: 2026-10-08.

**Consecuencias**: Una vez que Oficina corrige cualquier línea de un
pedido de WooCommerce, ese pedido queda "desconectado" de la sincronización
de líneas para siempre (no hay forma de revertir la marca desde la API hoy)
— la cabecera sigue viva. Esto es deliberadamente conservador: prioriza no
perder trabajo de Oficina por sobre mantener el pedido 100% espejado. Si en
el futuro hiciera falta una reconciliación más fina (línea por línea, no
pedido por pedido), es un cambio aparte, no cubierto acá. No se tocó el
contrato de la API: ningún shape de request/response cambia, sólo el
comportamiento interno de sincronización (ver `docs/contrato-api.md`,
sección 4.5, nota agregada en el mismo cambio).
