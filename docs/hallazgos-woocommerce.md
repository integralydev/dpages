# Hallazgos verificados — WooCommerce (dpages.cat)

Estos hallazgos vienen de una evaluación técnica **de sólo lectura** sobre la
tienda real. No son hipótesis: son datos medidos. Condicionan el diseño del
esquema y de la integración — ver los ADRs correspondientes en
`decisiones-arquitectura.md`.

## Entorno

- WooCommerce 10.9.3, WordPress, PHP 8.5, 39 extensiones activas.
- API a usar: **`/wp-json/wc/v3/`** (la moderna). **No** la legacy
  `/wc-api/v3/` — usa otros nombres de campo (`title` vs `name`,
  `created_at` vs `date_created`). Hay documentación vieja circulando que la
  referencia; hay que ignorarla.
- Moneda EUR, peso en kg.
- Almacenamiento de pedidos de alto rendimiento activo (HPOS): el esquema de
  pedidos vive en tablas propias de WooCommerce, no en `wp_posts`.
- Latencia observada: ~3 segundos por consulta.
- Sin bloqueos de firewall detectados durante la evaluación.
- Los importes llegan **sin IVA** y con decimales largos (ejemplo:
  `7,27272725 €` = `8,00 €` con IVA al 10%).
- **Capa 41 — el servidor de dpages.cat descarta el header `Authorization`
  antes de que llegue a WordPress**, confirmado con curl directo: el mismo
  par de credenciales (`consumer_key`/`consumer_secret`) da `401` por
  header y `200` por query string. WooCommerce/WordPress soportan las dos
  formas oficialmente — esto no es un problema de WooCommerce ni de las
  credenciales, es algo puntual de cómo está configurado (probablemente un
  proxy/WAF delante) el servidor real de esta tienda. El cliente
  (`woocommerce/cliente.ts`) manda las credenciales por query string por
  este motivo — ver el comentario en `credencialsWoo()` para el detalle y
  la redacción obligatoria en logs/errores que esto exige.

- **Capa 49 (2026-09-02) — incidente real de producción: sync-comandes y
  sync-cataleg fallando de forma sostenida, cursores de `orders` Y
  `products` congelados varios días, con cientos de intentos fallidos
  consecutivos.**

  **Síntoma**: `cursor_sincronitzacio` de ambos recursos sin avanzar desde
  el 2026-08-31, `ultim_error` = `"Sin respuesta de WooCommerce en [...]
tras 5 reintentos: fetch failed"` en los dos. Cloud Scheduler
  (`sync-comandes` cada 5 min, `sync-cataleg` cada 30 min) devolviendo 500
  de forma consistente.

  **Causa probable**: no fue backlog acumulado (el catálogo son ~111
  artículos — un backlog de `products` nunca justificaría por sí solo
  varias páginas) sino que **una sola página de resultados** quedaba al
  límite o por encima de `TIMEOUT_PETICION_MS` (20s) en el hosting real.
  Prueba manual con curl directo (mismas credenciales, fuera del backend):
  una página de 50 pedidos con los parámetros reales del sync tardó ~8s —
  bastante más que los "~3 segundos por consulta" observados en la
  evaluación original (ver arriba); con `PER_PAGE` real de 100 (el doble),
  es plausible que una página completa superara los 20s en un hosting que
  ya venía lento. El texto exacto `"fetch failed"` (en vez de un
  `TimeoutError`/`AbortError` limpio) apunta más a un corte de conexión del
  lado del servidor/hosting que a nuestro propio `AbortSignal`
  disparándose — pero el código de esta capa hacia atrás **descartaba
  `err.cause`** por completo, así que no había forma de confirmarlo con los
  logs disponibles; hubo que reconstruir la investigación con pruebas
  manuales fuera del backend.

  **Cambios aplicados** (`woocommerce/cliente.ts`):
  1. `PER_PAGE`: `100` → `30` — páginas más chicas y rápidas.
  2. `TIMEOUT_PETICION_MS`: `20_000` → `45_000` — colchón si el hosting
     sigue lento incluso con páginas más chicas.
  3. Captura de `err.cause` (antes descartado) en el log de cada reintento
     y en el mensaje final de `ErrorWooCommerce`, para poder distinguir la
     próxima vez un abort propio de un corte de conexión real sin repetir
     esta investigación desde cero.

  Mitigación inmediata mientras se aplicaba el fix: los dos jobs de Cloud
  Scheduler se pausaron manualmente (fuera de este repo, a nivel de
  infraestructura) para no seguir cargando el hosting con reintentos
  fallidos mientras se diagnosticaba.

  **Corrección (2026-09-02, mismo día, tras desplegar la captura de
  `err.cause` de arriba) — el diagnóstico de "página lenta/timeout de
  lectura" era PARCIALMENTE INCORRECTO.** Con `err.cause` ya visible en
  los logs reales, el error de fondo resultó ser:

  ```
  ConnectTimeoutError: Connect Timeout Error (attempted address: dpages.cat:443, timeout: 10000ms)
  ```

  Es un **timeout de CONEXIÓN** (el handshake TCP/TLS nunca llega a
  completarse), no un timeout de lectura/respuesta lenta — y el límite es
  de **10 segundos**, un valor que no configuramos nosotros en ningún
  lado: es el `connectTimeout` **por defecto de undici** (la librería
  detrás del `fetch` nativo de Node), completamente independiente de
  `TIMEOUT_PETICION_MS`/`AbortSignal.timeout()`. Confirmado y reproducido
  localmente contra `192.0.2.1` (TEST-NET-1, RFC 5737 — dirección
  reservada que nadie responde, ideal para simular esto sin tocar nada
  real): el error reproducido fue carácter por carácter idéntico al de
  producción, y ocurrió a los ~10s pese a tener un `AbortSignal` de 20s —
  confirmando que el `AbortSignal` nunca llegó a intervenir.

  **Por qué el primer diagnóstico pareció encajar igual**: subir
  `PER_PAGE`→30 y `TIMEOUT_PETICION_MS`→45s no estaba mal por sí solo (son
  cambios razonables igual), pero no atacaba la causa real — el síntoma
  visible (`"fetch failed"` tras agotar reintentos, en ambos recursos) es
  compatible con las dos hipótesis, y sin `err.cause` no había forma de
  distinguirlas. Es exactamente el motivo por el que ese mismo cambio
  (capturar la causa) fue el primero en aplicarse: permitió pasar de
  especular a confirmar en el siguiente incidente real, en vez de tener
  que reproducir todo el diagnóstico a mano otra vez.

  **Fix real (capa 49bis, aplicado)**: el `connectTimeout` de undici se
  configura a nivel de `Agent`/dispatcher global (`setGlobalDispatcher`
  del paquete `undici`), no vía el `AbortSignal` del `fetch` — son dos
  mecanismos independientes, en capas distintas.

  Antes de aplicarlo se verificó empíricamente (local, sin tocar nada
  real) que el mecanismo funciona: `setGlobalDispatcher(new Agent({
connectTimeout: 45_000 }))` contra `192.0.2.1` cambió el error de
  `ConnectTimeoutError [...] timeout: 10000ms` a un timeout nativo del
  sistema operativo bastante más tardío — confirmando que (a) el paquete
  `undici` de npm SÍ controla también el `fetch` nativo de Node (comparten
  el dispatcher global por diseño), y (b) el techo artificial de 10s
  desaparece. Probado igual con `undici@6` y `undici@8.10.1` (la versión
  finalmente instalada).

  `packages/backend/src/woocommerce/cliente.ts` ahora llama a
  `setGlobalDispatcher(new Agent({ connectTimeout: TIMEOUT_PETICION_MS }))`
  una sola vez, al cargar el módulo — reusa la misma constante que ya
  regula el `AbortSignal`, para que ambos límites (conexión y
  lectura/respuesta) se muevan juntos si algún día hay que ajustarlos. Se
  agregó `undici` como dependencia directa (antes no era ni siquiera
  transitiva).

  **Pendiente de revisar por separado, a nivel de infraestructura (no es
  un cambio de código)**: un timeout de CONEXIÓN (nunca se completa el
  handshake) es distinto de "el servidor responde lento" — sugiere
  intermitencia de red entre Cloud Run (europe-west1) y el hosting real, o
  algo del lado del hosting descartando el SYN en silencio (no
  rechazándolo activamente). Cloud Run sale por defecto con un pool
  compartido y rotativo de IPs de Google — si el WAF/firewall del hosting
  bloquea/limita rangos conocidos de proveedores cloud, produciría
  exactamente este síntoma sin que ningún timeout del lado del cliente lo
  resuelva. Vale la pena confirmar si Cloud Run tiene IP de salida fija
  configurada, y si esa IP está permitida en el hosting.

  **Ajuste fino (capa 49ter, mismo día) — el fix de la 49bis funcionó para
  su síntoma específico, pero destapó un problema de diseño en los
  valores elegidos.** Ya en producción con el `connectTimeout` corregido,
  `sync-comandes` dejó de mostrar `ConnectTimeoutError` — pero siguió
  fallando, ahora con `"The operation was aborted due to timeout"` (el
  `AbortSignal`, no undici).

  **Validación matemática del peor caso, con la config de la 49bis**
  (`TIMEOUT_PETICION_MS = 45_000`, `REINTENTOS_MAXIMOS = 5`, backoff
  `500·2^(intento-1)` con tope 10s):

  ```
  Tiempo = (REINTENTOS_MAXIMOS + 1) × TIMEOUT_PETICION_MS + backoff acumulado
  Backoff = 500 + 1000 + 2000 + 4000 + 8000 = 15.500 ms
  Tiempo = 6 × 45.000 + 15.500 = 285.500 ms
  ```

  Un caso real de producción dio `responseTime: 285568ms` — **285,5s
  calculados contra 285,568s observados, prácticamente exactos.** Esto
  probó que los 6 intentos de una sola página tardaron el máximo permitido
  cada uno, de punta a punta — no "algunos rápidos, algunos lentos": la
  ventana completa de esa ejecución estuvo bloqueada de forma sostenida.
  Con sólo dos páginas fallando así (`2 × 195,5s = 391s`), el request
  entero excede inevitablemente los ~300s de Cloud Run, sin importar qué
  tan generosos sean los timeouts individuales — bajar sólo los timeouts
  no alcanza si no se toca también cuántas veces se reintenta.

  **El error de diseño de la 49bis, más allá del rendimiento**: usar el
  MISMO valor para `connectTimeout` y para el `AbortSignal` (ambos
  `TIMEOUT_PETICION_MS`) hace que, ante una conexión colgada, cuál de los
  dos dispara primero pase a depender de detalles internos de scheduling
  de Node, no de en qué fase falló de verdad — rompiendo justo la
  capacidad de diagnóstico que la captura de `err.cause` (capa 49) vino a
  dar. Que en producción volviera a aparecer el mensaje genérico del
  `AbortSignal` no implicaba necesariamente que el problema hubiera
  cambiado de fase — podía ser el mismo problema de conexión, disfrazado
  por el empate de relojes.

  **Valores nuevos** (`packages/backend/src/woocommerce/cliente.ts`):
  - `TIMEOUT_CONEXIO_MS = 15_000` (nuevo, antes no existía separado) — sólo
    para la fase de conectar (TCP/TLS).
  - `TIMEOUT_PETICION_MS`: `45_000` → `30_000` — la evidencia real (pruebas
    manuales aisladas contra el mismo endpoint/parámetros) nunca mostró más
    de ~24,4s en el peor caso (típico 2,2-2,8s); 45s no aportaba margen
    real, sólo alargaba cada intento fallido.
  - `REINTENTOS_MAXIMOS`: `5` → `2` — con la nueva config, una página que
    falla los 3 intentos completos consume `3 × 30.000 + 1.500 = 91.500ms`;
    incluso 3 páginas fallando así (`274,5s`) entran en el presupuesto de
    Cloud Run, dejando margen para las páginas que sí funcionan y para la
    transformación posterior.

  **Decisión de fondo, no sólo ajuste de números**: los reintentos de
  `peticionGet` son una defensa contra baches cortos (milisegundos a pocos
  segundos), no contra degradación sostenida de varios minutos — para eso
  ya existe el próximo disparo de Cloud Scheduler, 5 minutos después
  (`sync-comandes`), y los endpoints de tarea ya son idempotentes entre
  corridas (ADR-009). Insistir 5-6 veces seguidas dentro de una misma
  ejecución contra un host que ya viene mal no ayuda — sólo agota el
  presupuesto de tiempo sin, aparentemente, mejorar la chance de éxito (los
  6 intentos del caso real tardaron todos lo mismo, sin señal de que
  insistir estuviera funcionando). Fallar rápido y dejar que la próxima
  corrida programada sea el reintento real es la elección consciente acá,
  no un efecto secundario de "menos es más rápido".

## Catálogo (253 registros, ~111 artículos reales)

- **Crítico — catálogo duplicado por idioma (Polylang).** Cada artículo
  existe dos veces, catalán y castellano, **compartiendo el mismo código
  (SKU)**. Ejemplo: "Llom" (id 6245) y "Lomo" (id 6335) son ambos el código
  `LLF01`. 109 de 111 códigos aparecen dos veces.
- **Ambas versiones reciben pedidos**: 1.774 líneas apuntan a la versión
  catalana y 1.647 a la castellana. 37 pedidos mezclan ambos idiomas en la
  misma cesta. Por lo tanto no se puede descartar ninguna versión, y el
  mapeo **no puede ser** `woo_product_id → artículo`. Hace falta una tabla de
  alias (ver ADR-008).
- **El peso no está informado**: 2 de 253 productos, y con valor erróneo
  (10 kg en un solomillo). 0 de 64 variaciones tienen peso. El peso vendrá de
  una carga de artículos que facilita el cliente, no de WooCommerce.
- **14 artículos publicados sin código**, incluido "Botifarra blanca" (3.º
  más vendido, 144 líneas de pedido en 6 meses) y "Frankfurt Eco" (61).
- 16 productos variables con 64 variaciones, diferenciadas por los atributos
  "Presentació" y "Talla". Sólo el 46,9% de las variaciones tiene código
  propio, y un mismo código llega a repetirse en 8 variaciones.
- El gramaje a veces está dentro del propio código (ej. SKU `BOT01750g`) o en
  texto libre del atributo Presentació ("250 gr", "600 gr", "4 unitats").

## Pedidos (411 en 6 meses, 4.248 históricos)

- Media de 8,3 líneas por pedido, máximo 23. 99,6% de líneas con SKU.
- Los pedidos traen **unidades, nunca kilos**. El kilaje se calcula:
  unidades × peso por unidad del artículo (que sale de nuestra propia tabla).
- **No existe fecha de entrega, producción ni expedición** en WooCommerce.
  Se revisaron las 22 claves de meta_data de pedido existentes: ninguna las
  contiene. Esas tres fechas son 100% nuestras.
- 45,5% de pedidos con cupón de descuento. Un solo código
  (`nestorblanca`) aparece en 158 pedidos de 68 clientes distintos, con
  1.654 € descontados.
- El NIF del cliente llega en **dos campos distintos** de meta_data: `nif` y
  `_billing_myfield5`. Cobertura del 57%, y en 5 de 41 casos con ambos,
  difieren entre sí.
- 23,4% de pedidos son de invitados (`customer_id = 0`). Sólo 10 de ellos
  traen NIF.
- 11 métodos de envío distintos que mezclan zona, gratuidad e idioma. No
  identifican al transportista.
- `modified_after` funciona correctamente tanto en `/orders` como en
  `/products` — confirmado con pruebas reales. Las cabeceras `X-WP-Total` y
  `X-WP-TotalPages` están presentes.

**Nota (08/10/2026) — campos de dirección y nota capturados (ADR-025, decidido internamente, pendiente de validación del cliente)**:
`WooShippingAddress` pasa a capturar también `address_1`, `address_2` y
`postcode` (opcionales — no todo pedido real los trae con valor), y
`WooOrder` captura `customer_note` (opcional). Van a `comanda.adreca_lliurament`
y `comanda.obs_lliurament` respectivamente, sólo al crear (ver
`transform/comandes.ts:construirAdrecaLliurament`/`construirObsLliurament`).
Sobre una muestra real de 200 pedidos se observaron tres `method_id`
distintos en `shipping_lines`: `flexible_shipping`, `flexible_shipping_single`
y `local_pickup` — ninguno identifica una empresa transportista (son modos
de entrega del plugin, ver línea 243 más arriba); `local_pickup` sí se usa
como señal de negocio: un pedido con ese método nunca tiene una dirección de
entrega real que mapear, así que `adreca_lliurament` queda en `NULL` aunque
la dirección venga completa.

**Nota (08/10/2026) — `after` (piso de activación, sólo `/orders`)**:
filtra por `date_created_gmt` (a diferencia de `modified_after`, que filtra
por `date_modified_gmt`) — se agrega cuando `INGESTA_COMANDES_DES_DE` está
configurada (`ingerirComandes`, `sync/ingesta.ts`), para no aterrizar datos
personales de pedidos anteriores al piso de activación sin necesidad. **No
es la barrera real**: la fiabilidad de `after`/`dates_are_gmt` del lado de
WooCommerce no está confirmada con pruebas reales (a diferencia de
`modified_after`, arriba) — `transformarComanda` (`transform/comandes.ts`)
vuelve a comparar `date_created_gmt` contra el mismo piso antes de crear
cualquier pedido, sin confiar en que la tienda filtró bien.

## Las seis reglas de consulta obligatorias

Se pierden registros si no se respetan todas:

1. `dates_are_gmt=true` **siempre**; comparar contra `date_modified_gmt`.
2. `orderby=modified&order=asc` — ordenar `desc` rompe la paginación si algo
   se modifica mientras se está paginando.
3. Ventana de solapamiento: restar 5 minutos al cursor guardado antes de
   consultar.
4. Avanzar el cursor **sólo** si el lote completo se procesó bien.
5. `status=any` en pedidos, para capturar cancelaciones.
6. Paginar por `X-WP-TotalPages` (cabecera), nunca "hasta que venga vacío".

## Cómo se obtuvieron estos datos

Script de exploración de un solo uso, sólo peticiones GET, con throttling y
manejo de errores por endpoint. No forma parte del servicio; su sucesor vive
en `packages/backend/src/scripts/` para cuando haga falta re-perfilar la
tienda (por ejemplo, al recibir la tabla maestra de artículos del cliente).
