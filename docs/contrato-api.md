# Contrato de la API — dPagès

**Versión 1.0 · agosto 2026 · VisioFlow Tech**

Este documento define la forma de la API interna entre el backend (Gerardo) y el
frontend (Michel). Su propósito es que ambos puedan trabajar en paralelo sin
esperarse: Michel construye contra datos simulados que respetan este contrato, y
cuando el backend esté listo sólo cambia de dónde vienen los datos.

Va en el repositorio como `docs/contrato-api.md`.

---

## 1. Cómo usar este documento

**Para Michel:** cada endpoint incluye una respuesta JSON de ejemplo completa.
Copiálas tal cual como datos simulados. Si respetás esas formas, el día que
conectemos la API real las pantallas no se enteran del cambio.

**Los tipos TypeScript están en `@dpages/shared`.** No los redefinas en el
frontend: importalos. Si necesitás un campo que no existe, avisame antes de
tocar ese paquete — lo usamos los dos.

**Regla de oro:** si algo de este documento no coincide con lo que hace el
backend, es un error del backend, no del frontend. Avisá.

### Notas de arquitectura

**El sistema dejó de tratarse como espejo de WooCommerce** (confirmado con el
cliente el 18/08/2026). Es el sistema de pedidos propio; WooCommerce es un
canal de entrada más, no la fuente de verdad. Esto ya se aplicaba a los
pedidos — ahora se extiende al catálogo en un punto puntual:

**El catálogo se sigue sincronizando desde WooCommerce** (artículos,
precios, etc.) — eso no cambió. Pero **la categoría del producto ya NO se
sincroniza**: es autoridad del propio sistema, relacionada por SKU. Si en
algún momento WooCommerce y el sistema discrepan en a qué categoría
pertenece un artículo, gana el sistema.

---

## 2. Convenciones generales

### Base

```
Desarrollo local:  http://localhost:8080/api/v1
Producción:        https://<pendiente>/api/v1
```

La URL base va en una variable de entorno del frontend, nunca escrita a mano
en el código.

### Autenticación

Todas las rutas de negocio (todo lo de la sección 4) requieren el token de
Firebase Auth. `/salut`, el webhook de WooCommerce y `/tasques/*` quedan
afuera — tienen su propio mecanismo, no te conciernen desde el frontend.

```
Authorization: Bearer <Firebase ID token>
```

Sin token o con uno inválido: `401 NO_AUTENTICAT`. El backend valida el token
de verdad (no hay ningún modo "sin autenticación" salvo en desarrollo local
del propio backend, con una variable de entorno que vos no controlás) — no lo
des por opcional en ningún ambiente donde pruebes contra el backend real.

Todos los endpoints de negocio restringen por rol con un guard real de
backend (`crearGuardaModul`, `http/rutes/api/comu.ts`): quien llame sin el
módulo requerido en `usuari.rol.modulsPermesos` recibe `403 SENSE_PERMIS`.
El rol (fila de `usuari` resuelta por `firebase_uid`, no un custom claim de
Firebase) decide tanto en qué panel lo ubica el frontend por defecto al
entrar como qué puede llamar de verdad contra el backend — ver
`decisiones-arquitectura.md`, ADR-021 (superado por este hallazgo de
seguridad: el criterio original de "ningún endpoint restringe por rol" ya
no aplica).

Tres criterios de guard, según el endpoint:

- **Estricto** — exige el módulo dueño del recurso (`comandes`, `catalog`,
  `tarifes`, `categories`, `transportistes`, `tarifes-clients`,
  `rendiments-porcs`, `usuaris`, `rols`, o el `panell-*` correspondiente).
  Aplica a la escritura de todo recurso (incluida toda escritura sobre
  `comandes`: `POST /comandes`, `PATCH /comandes/:id`,
  `POST`/`PATCH`/`DELETE .../linies`) y a la lectura de `/panells/*` y
  `/rendiments-porcs`.
- **De apoyo** — la lectura (`GET`) de `/categories`, `/productes`,
  `/tarifes/matriu`, `/transportistes` y `/clients` acepta CUALQUIERA de
  los 5 módulos operativos (`comandes`, `panell-oficina`, `panell-obrador`,
  `panell-empaquetat`, `panell-produccio`) — son datos de referencia que
  varias pantallas necesitan mostrar (ej. el nombre del transportista en el
  Panell d'Oficina) sin que eso implique poder gestionar ese recurso. La
  escritura de esos mismos 5 recursos sigue siendo estricta (módulo dueño).
- **De lectura acotada, caso único** — `GET /comandes` y `GET /comandes/:id`
  aceptan `comandes` O `panell-oficina` (no los 5 módulos operativos: se
  confirmó que ningún otro panell consume esta ruta). Existe porque el
  Panell d'Oficina lee el detalle de un pedido en modo estricto de sólo
  lectura (`office/[id]/page.tsx`), compartiendo la misma ruta que la
  gestión completa de pedidos (`orders/[id]/page.tsx`, con escritura). Hoy
  no cambia el acceso de ningún rol real (`Oficina` ya tiene el módulo
  `comandes` además de `panell-oficina`) — es una red de seguridad para un
  rol futuro de "oficina, sólo lectura" creado en vivo vía `RoleFormModal`
  con únicamente `panell-oficina`.

### CORS

En desarrollo, el backend sólo acepta peticiones cross-origin desde
`http://localhost:3000` — si tu servidor de desarrollo corre en otro puerto,
avisame para agregarlo. En producción el origen permitido es explícito por
variable de entorno; si tu dominio de producción no está configurado ahí, el
navegador va a bloquear la petición aunque el token sea válido.

### Idioma

```
Accept-Language: ca        (por defecto)
Accept-Language: es
```

El backend devuelve los textos ya resueltos en el idioma pedido. El frontend
no tiene que elegir entre versiones ni conocer la duplicación que existe en
WooCommerce.

> Pendiente de confirmar con el cliente si el sistema es bilingüe o sólo
> catalán. El contrato funciona en ambos casos: si es monolingüe, la cabecera
> simplemente se ignora.

### Formatos de dato

| Tipo                          | Formato                      | Ejemplo                  | Motivo                                                                           |
| ----------------------------- | ---------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Fecha y hora                  | ISO-8601 UTC con `Z`         | `"2026-08-15T09:30:00Z"` | La conversión a hora local de Cataluña se hace en el frontend, en un único punto |
| Pesos (kg)                    | **String**, 3 decimales      | `"1.250"`                | Confirmado por el cliente: siempre kg con 3 decimales                            |
| Importes (€)                  | **String**, 2 decimales      | `"12.50"`                | Los decimales en coma flotante de JavaScript pierden precisión al sumar          |
| Unidades de línea (entrada)   | Número JS, hasta 2 decimales | `2.5`                    | `unitatsDemanades`/`unitatsLliurades` — admite fracción de pieza (capa 38)       |
| Unidades de línea (salida)    | **String**, 2 decimales      | `"2.50"`                 | Columna `NUMERIC(10,2)` desde la capa 38 — mismo motivo que kg/importes          |
| Otras unidades (ej. `bultos`) | Número entero                | `3`                      | Sin cambios — la capa 38 sólo tocó `unitatsDemanades`/`unitatsLliurades`         |
| Identificadores               | Número entero                | `142`                    |                                                                                  |

**Importante sobre los decimales:** llegan como texto, no como número. Para
mostrarlos, formatealos; para operar con ellos, convertí explícitamente. Si el
backend enviara `12.5` como número de JavaScript, sumar cien líneas daría un
total con centavos fantasma.

### Filtros de rango de fecha (`...Des` / `...Fins`)

**Regla transversal a TODOS los endpoints con filtros de este tipo** (capa
36 — antes había un bug sistémico, corregido en todos a la vez):

- **`...Des`** incluye el día completo desde su comienzo: `?dataDes=2026-08-28`
  matchea cualquier registro desde `2026-08-28T00:00:00Z` en adelante.
- **`...Fins`** incluye el día completo hasta su final: `?dataFins=2026-08-28`
  matchea cualquier registro hasta `2026-08-28T23:59:59.999Z` inclusive — NO
  se corta a medianoche del inicio del día. Un pedido creado hoy a las 14:14
  aparece al filtrar `Des=hoy&Fins=hoy`, tal como se espera.
- Pasar sólo la fecha (`YYYY-MM-DD`), sin hora, es lo esperado y documentado
  (`format: date`, no `date-time`, en cada parámetro de este tipo). Si en
  algún momento se pasa un timestamp completo, la hora que traiga `...Fins`
  se ignora igual (se trata como el día completo de esa fecha).

### Sobre los identificadores

El campo `id` que devuelve la API es un número entero secuencial por tabla,
no la clave interna real de la base de datos (que es UUID). Es una capa de
simplificación deliberada: el contrato se mantiene legible con ids chicos,
y la clave interna nunca se expone hacia afuera. Para el frontend esto es
transparente — usá el id tal como viene en cada respuesta, en cualquier
endpoint que lo pida de vuelta.

Documentado en ADR-019.

### Paginación

Parámetros de consulta:

```
?pagina=1&mida=50
```

`mida` por defecto 50, máximo 200. Todas las respuestas de listado vienen
envueltas:

```json
{
  "dades": [ ... ],
  "paginacio": {
    "pagina": 1,
    "mida": 50,
    "total": 137,
    "totalPagines": 3
  }
}
```

### Ordenación

```
?ordre=dataComanda:desc
?ordre=client:asc
```

### Errores

Siempre con esta forma, en cualquier código de estado:

```json
{
  "error": {
    "codi": "VALIDACIO",
    "missatge": "Les unitats i els kg lliurats no són vàlids",
    "detalls": [
      {
        "camp": "unitatsLliurades",
        "missatge": "ha de ser un número vàlid, com a màxim 2 decimals"
      }
    ]
  }
}
```

| Código HTTP | `codi`          | Cuándo                                               |
| ----------- | --------------- | ---------------------------------------------------- |
| 400         | `VALIDACIO`     | Datos mal formados o que violan una regla de negocio |
| 401         | `NO_AUTENTICAT` | Falta el token o está vencido                        |
| 403         | `SENSE_PERMIS`  | Autenticado pero sin permiso para esa acción         |
| 404         | `NO_TROBAT`     | El recurso no existe                                 |
| 409         | `CONFLICTE`     | Por ejemplo, editar un pedido congelado              |
| 500         | `ERROR_INTERN`  | Fallo del servidor                                   |

`missatge` está pensado para mostrarse al usuario y viene en catalán.

---

## 3. Enumeraciones

Todas están en `@dpages/shared`. Importalas, no las escribas a mano.

```typescript
type EstatComanda = 'oberta' | 'en_proces' | 'tancada' | 'amb_incidencia';
type TipusProducte = 'simple' | 'variable';
type Idioma = 'ca' | 'es';
```

> **`origen` (de `ComandaResumApi`/`ComandaDetallApi`) dejó de ser un enum
> fijo** (confirmado 18/08/2026): es el `codi` de una tabla mantenible
> (`origen_comanda`), no un union literal — por eso el tipo en
> `@dpages/shared` es `string`, no una lista cerrada. Los valores válidos
> hoy son `"woocommerce"` y `"manual"`; es extensible sin tocar código (a
> futuro, `"manual"` se puede desglosar en `"whatsapp"`/`"email"`/`"telefon"`
> agregando una fila, no una migración de tipo). Ver la sección "Orígenes
> de pedido" para el CRUD.

Etiquetas para mostrar (el backend no las envía, van en el frontend):

| Valor            | Catalán        | Castellano     |
| ---------------- | -------------- | -------------- |
| `oberta`         | Oberta         | Abierta        |
| `en_proces`      | En procés      | En proceso     |
| `tancada`        | Tancada        | Cerrada        |
| `amb_incidencia` | Amb incidència | Con incidencia |

`incidencies[].tipus` (de `GET /comandes/:id`, ver sección 4.5) **no** es un
enum cerrado en el backend — es texto libre en base, para no exigir una
migración cada vez que aparece un motivo nuevo. Los valores que existen hoy
en datos reales:

| Valor                        | Significado                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `article_no_resolt`          | Una línea del pedido no pudo resolverse a ningún artículo del catálogo.                                                                  |
| `conflicte_identitat_client` | El NIF/email resuelto contradice el ya registrado para ese cliente.                                                                      |
| `sense_dades_client`         | El pedido no trae ni NIF ni email utilizable — no se pudo crear cliente.                                                                 |
| `manual`                     | (capa 31) Un usuario de oficina marcó el pedido `amb_incidencia` a mano, con un motivo (`detall`) que el sistema no podía detectar solo. |

No lo trates como un enum fijo en el frontend: mostrá `tipus` tal cual si no
lo reconocés, en vez de asumir que la lista de arriba es exhaustiva.

---

## 4. Endpoints por pantalla

En el orden de prioridad que marcó el cliente.

---

### 4.1 · Categories

**`GET /categories`**

```json
{
  "dades": [
    {
      "id": 1,
      "nom": "Fresc",
      "elaboratPorc": true,
      "agrupacioRendiment": "KG"
    },
    {
      "id": 2,
      "nom": "Embotits cuits",
      "elaboratPorc": true,
      "agrupacioRendiment": "PAQ"
    },
    {
      "id": 4,
      "nom": "Magre",
      "elaboratPorc": true,
      "agrupacioRendiment": "MAGRE"
    },
    {
      "id": 3,
      "nom": "Conserves",
      "elaboratPorc": false,
      "agrupacioRendiment": null
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 16, "totalPagines": 1 }
}
```

**`POST /categories`**

```json
{ "nom": "Elaborats", "elaboratPorc": true, "agrupacioRendiment": "MAGRE" }
```

Respuesta `201`, misma forma que una fila de `GET /categories`.
`elaboratPorc` arranca en `false` si no se manda. Misma validación cruzada
que el `PATCH` de abajo: `agrupacioRendiment` sólo se acepta si
`elaboratPorc` es `true`.

**`PATCH /categories/:id`** — cuerpo parcial, sólo los campos a cambiar.

**`DELETE /categories/:id`** — borrado protegido: si **cualquier** producto
todavía usa esta categoría — **activo o inactivo, sin distinción** (capa 27) — responde `409 CONFLICTE` con el recuento en el mensaje en vez de
dejar productos con una referencia rota. `204` sin cuerpo si el borrado se
pudo hacer.

> Un producto inactivo bloquea el borrado exactamente igual que uno activo
> — nunca se borra una categoría "por transitividad" sin acción explícita.
> Razón: si se permitiera borrar con productos inactivos asociados, un
> producto reactivado más tarde aparecería sin categoría sin que nadie lo
> haya tocado directamente. (Antes de la capa 27, la guarda sólo contaba
> productos activos, pero la FK de la base no distingue por `actiu` —
> Postgres bloqueaba el `DELETE` igual, y el error cae como `500` en vez de
> `409` porque no estaba capturado; ya corregido.)

> **`agrupacioRendiment`** (confirmado con el cliente el 18/08/2026, ya no
> pendiente) toma uno de tres valores, y decide cómo esa categoría entra en
> el cálculo del Panell Producció (ver esa sección):
>
> - **`"KG"`** — el rendimiento se calcula en kilos.
> - **`"PAQ"`** — el rendimiento se calcula en paquetes/unidades.
> - **`"MAGRE"`** — no participa fila por fila: va al total global de
>   `PanellProduccioApi.totals`.
>
> **`null` sólo cuando `elaboratPorc` es `false`** — es una regla de
> negocio (esa categoría no participa del cálculo de rendimiento porcino),
> no un dato pendiente de cargar. Si `elaboratPorc` es `true`, siempre trae
> uno de los tres valores.

---

### 4.2 · Catàleg de productes

**`GET /productes`**

Filtros: `?categoriaId=1&tipus=simple&actiu=true&cerca=llom&agrupacioProduccio=Llom`

> **`agrupacioProduccio` (capa 45, corrección de Michel)**: coincidencia
> EXACTA, case-insensitive (`LOWER(...) = LOWER(...)`, regla 3.1
> transversal) — hasta esta capa quedó case-sensitive por descuido. No
> confundir con `cerca`, que sí es substring (`ILIKE`) sobre
> descripció/descripcioVenda/codi.

```json
{
  "dades": [
    {
      "id": 12,
      "codi": "LLF01",
      "descripcio": "Llom fresc de porc",
      "descripcioVenda": "Llom",
      "tipus": "simple",
      "pesKg": "1.250",
      "preuVenda": "9.86",
      "actiu": true,
      "categoria": { "id": 1, "nom": "Fresc" },
      "agrupacioProduccio": "Llom",
      "format": "SENCER",
      "envasat": "NORMAL (pes)"
    },
    {
      "id": 13,
      "codi": "PIC01",
      "descripcio": "Picada de porc",
      "descripcioVenda": "Picada",
      "tipus": "simple",
      "pesKg": null,
      "preuVenda": "7.60",
      "actiu": true,
      "categoria": { "id": 1, "nom": "Fresc" },
      "agrupacioProduccio": null,
      "format": null,
      "envasat": "NORMAL"
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 111, "totalPagines": 3 }
}
```

**`GET /productes/:id`** · **`POST /productes`** · **`PATCH /productes/:id`**

> **`pesKg` puede ser `null`, y eso es funcional, no un error.** Significa que
> es un artículo _a medida_: en la línea de pedido su peso queda a cero y es
> editable. Si tiene peso, el campo de la línea se calcula solo y **no es
> editable**. Es una regla que el cliente confirmó por escrito, y afecta
> directamente al comportamiento de la pantalla de pedidos.
>
> Hoy casi todo el catálogo tiene `pesKg` en `null`, porque el dato aún no
> llegó del cliente. Michel: construí bien los dos caminos.

> **Tres campos nuevos, confirmados con el cliente el 18/08/2026:**
>
> - **`agrupacioProduccio`** — texto libre. Agrupa varios códigos bajo una
>   misma familia lógica de producción (por ejemplo, variantes de un mismo
>   corte que se elaboran juntas). `null` si el artículo no pertenece a
>   ninguna agrupación. Es la misma agrupación que usa el Panell Producció.
> - **`format`** — uno de `"SENCER"`, `"TALLAT"`, `"LLESCAT"`, o `null`.
> - **`envasat`** — uno de `"NORMAL"`, `"NORMAL (pes)"`, `"NORMAL (web)"`,
>   `"ESPECIAL"`, o `null`.
>
> No los trates como opcionales en el sentido de "puede faltar el dato": los
> tres pueden ser `null` legítimamente cuando no aplican a ese artículo.

---

### 4.3 · Llistat de tarifes

La matriz de precios: una fila por artículo, una columna por tarifa, editable
en celda.

**`GET /tarifes/matriu`**

Filtros: `?categoriaId=1&cerca=llom`

```json
{
  "tarifes": [
    { "id": 1, "codi": "GEN", "nom": "General" },
    { "id": 2, "codi": "REST", "nom": "Restaurants" },
    { "id": 3, "codi": null, "nom": "Botigues" }
  ],
  "dades": [
    {
      "producteId": 12,
      "codi": "LLF01",
      "descripcio": "Llom fresc de porc",
      "preus": { "1": "9.86", "2": "8.90", "3": "9.20" }
    },
    {
      "producteId": 13,
      "codi": "PIC01",
      "descripcio": "Picada de porc",
      "preus": { "1": "7.60", "2": null, "3": "7.10" }
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 111, "totalPagines": 3 }
}
```

Las claves de `preus` son los identificadores de tarifa en texto. `null` significa
que ese artículo no tiene precio en esa tarifa.

> `tarifes[].codi` puede ser `null` en tarifas que todavía no tienen código
> cargado (las que ya existían antes de que el alta empezara a pedirlo como
> obligatorio).

**`POST /tarifes`**

```json
{ "codi": "VIP", "nom": "Clients VIP" }
```

Respuesta `201`, misma forma que una fila de `tarifes[]` de la matriz de
arriba. `codi` es obligatorio y único — un `codi` repetido responde
`409 CONFLICTE`.

**`PATCH /tarifes/:tarifaId/preus/:producteId`**

```json
{ "preu": "9.50" }
```

Respuesta `200`:

```json
{ "tarifaId": 1, "producteId": 12, "preu": "9.50" }
```

> Guarda una sola celda. El cliente pidió expresamente edición en línea sin
> ventana emergente, igual que el mantenimiento de tarifas del prototipo.

**`DELETE /tarifes/:tarifaId/preus/:producteId`** (capa 28) — vuelve la celda
a "sin precio". `204` sin cuerpo si había un precio cargado; `404 NO_TROBAT`
si esa celda nunca tuvo precio (mismo criterio que el resto de los `DELETE`
del sistema — `DELETE /categories/:id`, `DELETE /rendiments-porcs/:id` — no
es idempotente-204, es 404 cuando no hay nada que borrar), o si `tarifaId`/
`producteId` no existen.

> El `PATCH` de arriba nunca aceptó `null`/vacío (siempre exige un decimal
> válido) — antes de este endpoint no había forma de volver una celda ya
> cargada a "sin precio". Borrar la fila hace que la cascada de resolución
> de `ComandaLiniaApi.preuUnitari` (sección 4.5 — 1º tarifa del cliente, 2º
> precio de catálogo del producto, 3º `"0.00"` con incidencia si no hay
> ninguno de los dos) caiga sola al precio de catálogo, exactamente igual
> que si esa celda nunca hubiera tenido valor.

---

### 4.4 · Tarifes per client

**`GET /clients`**

Filtros: `?cerca=nom&tarifaId=2&actiu=true`

```json
{
  "dades": [
    {
      "id": 45,
      "codi": "CLI45",
      "nom": "Restaurant Example",
      "nif": "B12345678",
      "email": "exemple@example.com",
      "telefon": "600000000",
      "poblacio": "Manresa",
      "tarifa": { "id": 2, "nom": "Restaurants" },
      "transportistaDefecte": { "id": 1, "nom": "DHL" },
      "actiu": true
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 1222, "totalPagines": 25 }
}
```

> **`codi`:** nunca queda vacío para ningún cliente, sin importar el
> origen. Siempre autogenerado, `CLI` + `id` (el mismo `id` público de este
> mismo objeto), **sin ancho fijo** — `CLI45`, `CLI4916`, `CLI15118`, lo
> que corresponda. (Un intento inicial rellenaba con ceros a 3 dígitos
> como en el ejemplo de arriba; se descartó porque TRUNCABA en vez de
> ensanchar en cuanto el id llegaba a 4 cifras — dos clientes reales con id
> 4916 y 4918 generaban el mismo código y chocaban contra el índice
> único.) Empezó con los clientes resueltos por el sync de WooCommerce
> (capa 25; los que ya existían se completaron una sola vez con un script
> de backfill) y **desde la capa 29 aplica igual al alta manual**
> (`POST /clients`, abajo) — mismo mecanismo para los dos orígenes, sin
> distinción. **Es de sólo lectura para siempre**: ningún endpoint lo
> acepta como entrada editable, ni al crear ni en `PATCH /clients/:id`
> después — si llega en el body de cualquiera de los dos, se ignora en
> silencio.

**`PATCH /clients/:id`** — para asignar tarifa o transportista. `codi` no es
un campo editable (ver nota de arriba) — mandarlo no produce error, sólo se
ignora.

**`POST /clients`** — alta manual. Es el camino de los pedidos por teléfono y
WhatsApp, que no traen ningún cliente de WooCommerce que resolver.

```json
{
  "nom": "Forn del Barri",
  "poblacio": "Vic",
  "tarifaId": 2,
  "email": "forn@example.com",
  "telefon": "600222333",
  "nif": "B87654321"
}
```

`nom` y `poblacio` son obligatorios (los campos mínimos del prototipo).
`tarifaId`, `email`, `telefon` y `nif` son opcionales —
`email`/`telefon`/`nif` no aparecen en el modal del prototipo, pero hacen
falta como dato de contacto en los pedidos que no vienen de la web. `codi`
**no va en este cuerpo** — se autogenera siempre (ver nota de arriba); si
se manda igual, se ignora.

Respuesta `201`, misma forma que una fila de `GET /clients` — con `codi`
ya asignado:

```json
{
  "id": 200,
  "codi": "CLI200",
  "nom": "Forn del Barri",
  "nif": "B87654321",
  "email": "forn@example.com",
  "telefon": "600222333",
  "poblacio": "Vic",
  "tarifa": { "id": 2, "nom": "Restaurants" },
  "transportistaDefecte": null,
  "actiu": true
}
```

**`GET /transportistes`**

```json
{
  "dades": [
    { "id": 1, "codi": "TR-DHL", "nom": "DHL", "actiu": true },
    { "id": 2, "codi": null, "nom": "Recollida a la botiga", "actiu": true }
  ]
}
```

**`POST /transportistes`**

```json
{ "nom": "Seur", "codi": "TR-SEUR" }
```

Respuesta `201`, misma forma que una fila de `GET /transportistes`.
`codi` es opcional (texto libre, nemotécnico) pero único cuando se manda —
un `codi` repetido responde `409 CONFLICTE`.

**`PATCH /transportistes/:id`** — cuerpo parcial (`nom` y/o `codi`).

---

### 4.5 · Comandes

**`GET /comandes`**

Filtros: `?estat=oberta&clientId=45&origen=web&dataDes=2026-08-01&dataFins=2026-08-31&dataProduccioDes=&dataProduccioFins=&dataLliuramentDes=&dataLliuramentFins=&cerca=142`

> `dataFins`/`dataProduccioFins`/`dataLliuramentFins` incluyen el día
> completo — ver "Filtros de rango de fecha" en la sección 2 (capa 36).
>
> **`cerca` (issue #17, Michelle/Francesc) — substring (`ILIKE`), sobre
> `num` DEL PEDIDO O nombre del CLIENTE** (`cl.nom`), reemplaza un filtro
> client-side que daba totales/resultados inconsistentes al filtrar sólo
> sobre la página ya cargada. No confundir con el criterio de `cerca` en
> `productes`/`tarifes` (exacto, LOWER — sección 2, regla 3.1): acá
> buscar por parte del nombre de un cliente sí tiene sentido de negocio.
> No reemplaza `clientId` (filtro exacto por id, sin cambios).

```json
{
  "dades": [
    {
      "id": 142,
      "num": "000142",
      "origen": "woocommerce",
      "estat": "oberta",
      "client": { "id": 45, "nom": "Restaurant Example", "poblacio": "Manresa" },
      "tarifa": { "id": 2, "nom": "Restaurants" },
      "transportista": { "id": 1, "nom": "DHL" },
      "poblacioDesti": "Manresa",
      "adrecaLliurament": "Carrer Major, 12, 3r 2a",
      "dataComanda": "2026-08-14T09:12:00Z",
      "dataProduccio": "2026-08-16T00:00:00Z",
      "datesProduccioLinies": ["2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z"],
      "dataExpedicio": "2026-08-17T00:00:00Z",
      "dataLliurament": "2026-08-18T00:00:00Z",
      "bultos": 3,
      "totalLinies": 8,
      "totalKg": "24.500",
      "totalEur": "312.40",
      "congelada": false,
      "totalIncidencies": 0,
      "tipusIncidencia": null
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 411, "totalPagines": 9 }
}
```

> **`totalIncidencies`/`tipusIncidencia`** son el resumen liviano para no pedir
> el detalle completo por cada fila de una tabla con cientos de resultados.
> `tipusIncidencia` sólo trae un valor cuando **todas** las incidencias de esa
> comanda son del mismo tipo — si hay mezcla (por ejemplo un
> `article_no_resolt` y un `conflicte_identitat_client` en la misma comanda),
> queda `null` y hay que abrir el detalle (`GET /comandes/:id`) para ver de
> qué se trata. El detalle completo de motivos está en `incidencies` de esa
> misma respuesta — ver abajo.
>
> **`datesProduccioLinies`** (capa 21): las fechas de producción DISTINTAS
> entre las líneas del pedido (`linies[].dataProduccio`, ver más abajo),
> ordenadas cronológicamente, sin nulls — **array vacío** si ninguna línea
> tiene fecha de producción cargada, nunca `null`. Distinto de
> `dataProduccio` (el campo de arriba, a nivel de CABECERA del pedido): un
> pedido puede tener varias líneas con fechas de producción distintas entre
> sí (visto en el demo: la columna "Fecha producción" de la pantalla
> Pedidos mostraba `20/08/2026, 21/08/2026` para un mismo pedido). Viaja en
> ISO-8601 UTC como cualquier otra fecha del contrato (sección 2) — el
> frontend arma el string separado por comas y lo formatea a fecha local,
> en el mismo punto único donde ya hace esa conversión para el resto de las
> fechas. No hay una razón para que este campo rompa esa convención.
>
> **`dataDes`/`dataFins`** filtran por `dataComanda`. **Issue #16 (Francesc)
> — BREAKING:** hasta ahora `dataComanda` era directamente `comanda.creat_en`
> (cuándo entró el pedido al sistema); desde la migración 0019 es
> `comanda.dataComanda` (columna `DATE` propia, obligatoria, EDITABLE por el
> usuario, con HOY como valor por defecto en el frontend). `creat_en` sigue
> existiendo como timestamp real e inalterable de auditoría, pero ya no se
> expone en la API — los dos ya pueden divergir. Los tres pares nuevos son
> independientes entre sí y de éste:
>
> - **`dataProduccioDes`/`dataProduccioFins`** — mismo nombre que ya usa
>   `GET /panells/obrador` (sección 4.7), pero acá filtra por el PEDIDO
>   completo: matchea si **al menos una** de sus líneas tiene
>   `dataProduccio` dentro del rango (la misma línea cumple ambos extremos
>   a la vez, no dos líneas distintas cumpliendo cada una un extremo).
>   Pensado para planificación ("qué pedidos tienen algo que producir esta
>   semana").
> - **`dataLliuramentDes`/`dataLliuramentFins`** — mismo patrón de nombres
>   (`<campo>Des`/`<campo>Fins`) que ya usan `dataExpedicioDes`/`Fins` en
>   `GET /panells/oficina`/`GET /panells/empaquetat`, aplicado acá a
>   `dataLliurament` (fecha de entrega de la cabecera) — coincidencia
>   simple `>=`/`<=`, sin la semántica de "al menos una línea" de arriba.

**`GET /comandes/:id`** — incluye las líneas:

```json
{
  "id": 142,
  "num": "000142",
  "origen": "woocommerce",
  "estat": "oberta",
  "client": { "id": 45, "nom": "Restaurant Example", "poblacio": "Manresa" },
  "tarifa": { "id": 2, "nom": "Restaurants" },
  "transportista": { "id": 1, "nom": "DHL" },
  "poblacioDesti": "Manresa",
  "adrecaLliurament": "Carrer Major, 12, 3r 2a",
  "dataComanda": "2026-08-14T09:12:00Z",
  "dataProduccio": "2026-08-16T00:00:00Z",
  "dataExpedicio": "2026-08-17T00:00:00Z",
  "dataLliurament": "2026-08-18T00:00:00Z",
  "bultos": 3,
  "obsProduccio": "Tallar més gruixut",
  "obsLliurament": "Entregar pels matins",
  "totalKg": "24.500",
  "totalEur": "312.40",
  "congelada": false,
  "congelatA": null,
  "linies": [
    {
      "id": 981,
      "ordinal": 1,
      "producte": { "id": 12, "codi": "LLF01", "descripcio": "Llom fresc de porc" },
      "categoria": "Fresc",
      "format": "SENCER",
      "envasat": "NORMAL (pes)",
      "unitatsDemanades": "10.00",
      "kgDemanats": "12.500",
      "kgEditable": false,
      "unitatsLliurades": "0.00",
      "kgLliurats": "0.000",
      "confirmatA": null,
      "preuUnitari": "9.86",
      "totalLinia": "98.60",
      "dataProduccio": "2026-08-16T06:00:00Z",
      "obsProduccio": "Tallar fi",
      "esborrat": false
    },
    {
      "id": 982,
      "ordinal": 2,
      "producte": { "id": 13, "codi": "PIC01", "descripcio": "Picada de porc" },
      "categoria": "Fresc",
      "format": null,
      "envasat": "NORMAL",
      "unitatsDemanades": "4.00",
      "kgDemanats": "0.000",
      "kgEditable": true,
      "unitatsLliurades": "0.00",
      "kgLliurats": "0.000",
      "confirmatA": null,
      "preuUnitari": "7.60",
      "totalLinia": "30.40",
      "dataProduccio": null,
      "obsProduccio": null,
      "esborrat": false
    }
  ],
  "incidencies": [
    {
      "tipus": "article_no_resolt",
      "detall": "Línia 2: SKU sense alias a AliasProducte",
      "creatA": "2026-08-14T09:12:05Z"
    }
  ]
}
```

> **`incidencies`** es el motivo detrás de `"estat": "amb_incidencia"` — vacío
> si el pedido no tiene ninguna. `tipus` es uno de los valores documentados en
> la sección 3 (por ejemplo `article_no_resolt`, `conflicte_identitat_client`,
> `sense_dades_client`); `detall` es texto libre pensado para que oficina
> entienda el problema sin tener que investigar en la base. Ordenado del más
> antiguo al más nuevo — si hay más de una, la primera suele ser la causa
> original.

> **`adrecaLliurament`** es la dirección de entrega en texto libre — distinta
> de `poblacioDesti`, que es sólo la población/ciudad. Editable vía
> `PATCH /comandes/:id`, igual que `poblacioDesti`.
>
> **`linies[]` sólo trae líneas activas** — una línea borrada
> (`DELETE /comandes/:comandaId/linies/:liniaId`, borrado lógico, ver
> ADR-006) nunca vuelve a aparecer en `linies[]`, en ninguna respuesta que
> incluya el detalle del pedido (`GET`/`POST`/`PATCH /comandes/:id` y los
> dos endpoints de línea de la capa 30). Por eso `esborrat` siempre sale
> `false` en `linies[]` — el campo queda por compatibilidad, no hace falta
> mirarlo para saber si una línea está activa. **(Capa 33)** — hasta esta
> capa esto tenía un bug puntual: `SELECT_COMANDA_LINIA`, el único punto de
> verdad de `linies[]`, no filtraba `esborrat`, así que las líneas borradas
> sí volvían a aparecer.
>
> **`linies[].dataProduccio`** es la fecha de producción de ESA línea en
> particular, distinta de `dataProduccio` a nivel de cabecera (la de arriba,
> que es del pedido completo). El prototipo muestra ambas como editables por
> separado.
>
> **`linies[].categoria`/`format`/`envasat`** (capa 20): mismos tres campos
> que ya devuelve `GET /panells/obrador` para esta misma línea (sección
> 4.7), resueltos igual — `categoria` es el nombre de la categoría del
> artículo, `format`/`envasat` vienen tal cual de la ficha del producto.
> `null` cuando la línea no tiene artículo resuelto, o cuando el artículo
> no tiene esos campos cargados.
>
> **`linies[].unitatsDemanades`/`unitatsLliurades` — BREAKING (capa 38):
> pasaron de número a string.** El motivo es de negocio: Michel reportó que
> `unitatsLliurades` (INTEGER) bloqueaba entregas parciales de pieza (ej.
> 2.5 unidades cuando no se produjo la pieza completa); Gerardo amplió el
> alcance a `unitatsDemanades` también, mismo criterio para los dos campos.
> La columna pasó de INTEGER a `NUMERIC(10,2)` (2 decimales — alcanza para
> cuartos/mitades, no hace falta la precisión de los kilos) y, como con
> cualquier columna NUMERIC, la salida es texto (`"2.50"`, no `2.5`) —
> mismo patrón que `kgDemanats`/`preuUnitari`, que ya eran string por esto
> mismo. **El body de entrada sigue aceptando un JS number normal**
> (`{ "unitatsDemanades": 2.5 }`) en los 4 puntos donde se escribe:
> `POST /comandes`, `POST /comandes/:comandaId/linies`,
> `PATCH /comandes/:comandaId/linies/:liniaId` y
> `PATCH .../lliurament` (sección 5) — sólo la salida cambió de tipo. Válido:
> mayor que cero, como máximo 2 decimales; más de 2 decimales rechaza con
> `400 VALIDACIO`.

**`POST /comandes`** — alta manual. Es el camino de los pedidos por teléfono,
correo y WhatsApp, que son la mayoría del volumen real.

```json
{
  "origen": "manual",
  "clientId": 45,
  "tarifaId": 3,
  "dataComanda": "2026-08-14",
  "dataLliurament": "2026-08-20T00:00:00Z",
  "transportistaId": 1,
  "obsLliurament": "Entregar pels matins",
  "linies": [
    { "producteId": 12, "unitatsDemanades": 10, "dataProduccio": "2026-08-19T00:00:00Z" },
    {
      "producteId": 13,
      "unitatsDemanades": 4,
      "kgDemanats": "3.200",
      "dataProduccio": "2026-08-19T00:00:00Z"
    },
    { "producteId": 14, "unitatsDemanades": 2, "dataProduccio": "2026-08-19T00:00:00Z" }
  ]
}
```

> **Issue #16 (Francesc, Bloqueante) — BREAKING: `dataComanda`, `dataLliurament`
> y `linies[].dataProduccio` pasan a ser OBLIGATORIOS**, sin valor por
> defecto en el backend. El frontend precarga `dataComanda` con HOY
> (correcto: es la fecha real de creación) — `dataLliurament` NO debe
> precargarse (corregido tras confirmación de Michelle; se había
> documentado por error con el mismo criterio que `dataComanda`). Quien
> garantiza la obligatoriedad de ambas es esta validación, `400 VALIDACIO`
> si falta cualquiera. Antes (capa 34), `linies[].dataProduccio` era opcional
> en la alta — dejó de serlo acá; `dataComanda` es un campo nuevo (antes ni
> existía como entrada, ver la nota de `dataDes`/`dataFins` más arriba).
>
> **Actualización — `POST /comandes/:comandaId/linies` (más abajo) TAMBIÉN
> exige `dataProduccio` ahora.** El issue #16 original lo dejó afuera a
> propósito (agregar una línea a un pedido ya creado se consideró un caso
> distinto); Francesc/Michelle confirmaron después que el mismo criterio
> aplica ahí también — ver el bloque de ese endpoint más abajo.
>
> `linies[].dataProduccio` se sigue validando contra las reglas de
> coherencia de fechas — ver el bloque dedicado más abajo. **Actualización —
> `dataComanda` SÍ participa ahora (regla 7, confirmada):** no puede ser
> posterior a `dataLliurament`.

> **`tarifaId` (capa 32) es opcional.** Si viene, se usa ESA tarifa (no la
> del cliente) para resolver el precio de **todas** las líneas de esta alta,
> y queda guardada en `comanda.tarifaId`. Si no viene, sin cambios: se usa
> la tarifa del cliente (`client.tarifaId`). `tarifaId` inválido (no
> existe) → `400 VALIDACIO`, mismo criterio que `clientId` inválido.
>
> **Límite de alcance, a propósito:** editar `tarifaId` después vía
> `PATCH /comandes/:id` **no recalcula** las líneas ya creadas — sólo
> cambia el valor de la columna, sin efecto retroactivo. Y
> `POST /comandes/:comandaId/linies` (agregar una línea a un pedido ya
> creado, capa 30) tampoco lo usa: esa ruta siempre resuelve el precio
> contra la tarifa del **cliente**, nunca contra `comanda.tarifaId`, tanto
> si se fijó al crear como si se editó después. Si en algún momento hace
> falta que ambos casos sigan `comanda.tarifaId`, es un cambio aparte.

> **Coherencia temporal entre fechas (capa 34, + regla 7 del issue #16) — 7
> reglas.** Las 6 originales aplican en TODOS los puntos de entrada que
> pueden fijar una de estas fechas (`POST /comandes`,
> `POST /comandes/:comandaId/linies`,
> `PATCH /comandes/:comandaId/linies/:liniaId`, `PATCH /comandes/:id`); la
> regla 7 sólo aplica en `POST /comandes` y `PATCH /comandes/:id` — son los
> únicos dos puntos donde `dataComanda` se fija o puede cambiar:
>
> 1. `dataLliurament` no anterior a `dataProduccio` (cabecera).
> 2. `dataExpedicio` no anterior a `dataProduccio` (cabecera).
> 3. `dataExpedicio` no posterior a `dataLliurament`.
> 4. `linies[].dataProduccio` no anterior a `dataProduccio` de cabecera.
> 5. `linies[].dataProduccio` no posterior a `dataLliurament`.
> 6. `linies[].dataProduccio` no posterior a `dataExpedicio`.
> 7. `dataComanda` no posterior a `dataLliurament` (issue #16, confirmada).
>
> Cada regla sólo aplica cuando **ambas** fechas comparadas tienen valor —
> si falta alguna de las dos, esa regla puntual no bloquea nada. "anterior"/
> "posterior" es **estricto**: fechas iguales están permitidas (no había una
> resolución explícita del cliente sobre este caso límite; queda como
> criterio documentado, no un misterio). Violación → `400 VALIDACIO` con el
> detalle de qué regla falló.
>
> **El caso delicado es `PATCH /comandes/:id`:** si el body cambia
> `dataProduccio`/`dataExpedicio`/`dataLliurament`/`dataComanda` de
> cabecera, se valida el estado **resultante** (valor nuevo si vino, si no
> el que ya estaba guardado) contra las reglas 1/2/3/7, pero también las
> reglas 4/5/6 contra **todas** las líneas activas del pedido — no sólo las
> que este PATCH esté tocando (no toca ninguna: este endpoint no edita
> líneas). Un cambio de fecha de cabecera puede volver inválida una línea de
> la que nadie se está ocupando en ese momento, y el pedido lo rechaza
> igual. Esto incluye el caso donde el PATCH sólo trae `dataComanda` (o sólo
> `dataLliurament`): la regla 7 se evalúa igual, comparando contra el valor
> **ya guardado en la base** de la fecha que no vino en el body — nunca
> contra `null`, nunca asumiendo que la regla no aplica porque sólo cambió
> una de las dos.
>
> En `POST /comandes/:comandaId/linies` y
> `PATCH /comandes/:comandaId/linies/:liniaId`, la comparación es contra las
> fechas de cabecera **ya guardadas** del pedido (no las del propio body,
> que en esos dos endpoints no toca cabecera) — y sólo las reglas 4/5/6
> (la 7 no aplica ahí: ninguno de los dos toca `dataComanda`/
> `dataLliurament`). En `POST /comandes` (alta), como
> `dataProduccio`/`dataExpedicio` de cabecera no son campos de ese body
> (sólo existen después, vía `PATCH /comandes/:id`), en la práctica ahí sólo
> pueden dispararse la regla 5 (línea vs. `dataLliurament`) y la regla 7
> (`dataComanda` vs. `dataLliurament`, ambas siempre presentes en este body).

**`PATCH /comandes/:id`** · **`DELETE /comandes/:id/linies/:liniaId`**

> **Issue #16 (Francesc) — `dataComanda` es editable acá**, a diferencia de
> `producteId`/`categoriaId` en otros endpoints (regla de negocio
> confirmada): se puede corregir después de creado el pedido. NO se puede
> vaciar — `null` o string vacío rechaza con `400 VALIDACIO` (es
> obligatoria, a diferencia de `dataProduccio`/`dataExpedicio`/
> `dataLliurament`, que sí admiten `null` para "vaciar" el campo). Cambiarla
> dispara la regla 7 de coherencia (`dataComanda` no posterior a
> `dataLliurament`, ver el bloque dedicado más arriba) — comparada contra el
> `dataLliurament` que venga en el mismo body, o si no vino, contra el que
> ya estaba guardado.

> **Dos reglas que afectan la pantalla:**
>
> **`kgEditable`** te dice si el campo de kilos de esa línea se puede editar.
> Viene calculado por el backend según si el artículo tiene peso en su ficha.
> No lo deduzcas en el frontend: usá el campo.
>
> **No se puede grabar un pedido con líneas a cero** en unidades o kilos. El
> backend lo rechaza con `400 VALIDACIO`, pero validalo también en el
> formulario para no hacer viajar la petición.
>
> **`congelada`** en `true` significa que el pedido entró en producción y ya no
> admite cambios desde la web. Cualquier intento de modificarlo devuelve
> `409 CONFLICTE`. Mostralo visualmente.

**`estat` en `PATCH /comandes/:id`** (capa 31) — permite mover el pedido a
mano entre los 4 valores de `EstatComanda`, sin restricción de transición
(cualquier estado puede pasar a cualquier otro). Pensado para los casos que
el sistema no puede detectar solo: marcar incidencia por una queja del
cliente o falta de stock, o volver de `amb_incidencia` a otro estado una vez
resuelta.

```json
{ "estat": "amb_incidencia", "detall": "Client va trucar per queixar-se de la qualitat" }
```

Si `estat` es `"amb_incidencia"`, `detall` es **obligatorio en el mismo
body** — sin eso, `400 VALIDACIO`. Al aplicar, se registra una incidencia
nueva (`tipus: "manual"`, ver sección 3) en `incidencies[]`, igual que las
automáticas. Para cualquier otro valor de `estat`, `detall` se ignora si
viene. Un `estat` que no sea uno de los 4 valores válidos también es
`400 VALIDACIO`. Mismo `409 CONFLICTE` si el pedido está congelado.

**`origen` en `PATCH /comandes/:id`** — reasigna el canal del pedido, sin
importar cuál sea el origen actual (incluye pedidos hoy en `"woocommerce"`
o en el valor histórico `"manual"`: cualquiera de los dos se puede mover a
uno de los 4 canales elegibles).

```json
{ "origen": "whatsapp" }
```

Sólo acepta uno de estos 4 códigos — `"whatsapp"`, `"telefon"`,
`"correu"`, `"woocommerce"` — **nunca** `"manual"` (valor histórico):
cualquier otro valor es `400 VALIDACIO`, con el mensaje indicando los
códigos válidos. `"woocommerce"` es a la vez el valor que asigna la
sincronización automática y un destino elegible a mano — las dos cosas
coexisten sin conflicto. Un código bien formado pero inexistente en
`origen_comanda` también es `400 VALIDACIO` (chequeo defensivo — los
canales están sembrados de fábrica). Mismo `409 CONFLICTE` que el resto de
los campos si el pedido está congelado — sin ninguna excepción especial
para este campo. Si `origen` no viene en el body, no se toca.

**`POST /comandes/:comandaId/linies`** (capa 30) — agregar una línea a un
pedido **ya creado**. Hasta esta capa, la única forma de corregir un pedido
existente era borrarlo entero y recargarlo de cero, perdiendo el número de
pedido original.

```json
{ "producteId": 12, "unitatsDemanades": 5, "dataProduccio": "2026-08-19T00:00:00Z" }
```

Mismo shape que una línea de `POST /comandes` (`producteId`,
`unitatsDemanades`, `kgDemanats` opcional — sólo tiene sentido si el
artículo es "a medida"). Respuesta `201`, **la comanda completa actualizada**
(mismo shape que `GET /comandes/:id`), no sólo la línea nueva — para
refrescar toda la pantalla de una. `409 CONFLICTE` si la comanda está
congelada, igual que el resto de las escrituras sobre un pedido.

> El precio de la línea nueva se resuelve con la **misma cascada** que al
> crear el pedido (tarifa del cliente → precio de catálogo → `"0.00"` con
> incidencia). Si la línea queda sin precio resuelto, se registra la
> incidencia `sense_preu` y el pedido pasa a `amb_incidencia` si no lo
> estaba ya — mismo criterio que un pedido que nace con una línea así.
>
> **`dataProduccio` es OBLIGATORIA (issue #16, confirmado en segunda
> ronda).** La versión original del issue dejó este endpoint explícitamente
> afuera de la obligatoriedad (sólo `POST /comandes` la exigía); Francesc/
> Michelle confirmaron después que agregar una línea a un pedido existente
> debe seguir el mismo criterio. Falta o vacía → `400 VALIDACIO`. Se sigue
> validando además contra las reglas 4/5/6 de coherencia de fechas (ver el
> bloque dedicado más arriba) — contra las fechas de cabecera ya guardadas
> del pedido, no las de este mismo body (este endpoint no toca cabecera).

**`PATCH /comandes/:comandaId/linies/:liniaId`** (capa 30) — editar una
línea existente.

```json
{ "unitatsDemanades": 8, "obsProduccio": "Tallar més fi" }
```

Cuerpo parcial: `unitatsDemanades`, `kgDemanats`, `dataProduccio`,
`obsProduccio`, todos opcionales — actualiza sólo lo que venga. Respuesta
`200`, la comanda completa actualizada (mismo criterio que el endpoint de
arriba). `409 CONFLICTE` si la comanda está congelada. `kgDemanats` sólo
se acepta si el artículo es "a medida" (`kgEditable: true` en esa línea) —
si el artículo tiene ficha de peso, rechaza con `400 VALIDACIO` (el peso
se recalcula solo a partir de `unitatsDemanades`, igual que al crear).

> **Importante — esto NO re-resuelve `preuUnitari`.** Editar cantidades
> nunca cambia el precio ya asignado a la línea; sólo recalcula
> `totalLinia` (`preuUnitari` sin tocar × `unitatsDemanades` nuevo, si
> vino). Si en algún momento hace falta re-resolver precio a propósito
> (por ejemplo, la tarifa del cliente cambió después de crear el pedido),
> es una acción separada — todavía no existe un endpoint para eso.
>
> **`dataProduccio` (capa 34):** si se cambia, se valida contra las 6 reglas
> de coherencia de fechas (ver el bloque dedicado más arriba) — contra las
> fechas de cabecera ya guardadas del pedido. Si no viene en el body, no se
> re-valida nada (no cambió).

---

### 4.6 · Panell Oficina

Sólo lectura, con filtros y subtotales.

**`GET /panells/oficina`**

Filtros: `?dataExpedicioDes=&dataExpedicioFins=&dataComandaDes=&dataComandaFins=&dataLliuramentDes=&dataLliuramentFins=&transportistaId=&tarifaId=&estat=&clientId=&poblacioDesti=`

> Los tres `...Fins` (`dataExpedicioFins`, `dataComandaFins`,
> `dataLliuramentFins`) incluyen el día completo — ver "Filtros de rango de
> fecha" en la sección 2 (capa 36).

> **Filtros nuevos (capa 35):** `tarifaId` (coincidencia exacta, mismo
> patrón que `transportistaId`/`clientId` — id inválido no numérico →
> `400 VALIDACIO`, id que no existe → `dades: []`), `poblacioDesti`
> (coincidencia exacta case-insensitive — regla 3.1 transversal, no
> substring), `dataComandaDes`/`dataComandaFins` (rango sobre `dataComanda`,
> mismo criterio que `dataExpedicioDes`/`Fins`), `dataLliuramentDes`/
> `dataLliuramentFins` (rango sobre `dataLliurament`).

```json
{
  "totals": {
    "comandes": 12,
    "linies": 97,
    "totalKg": "284.750",
    "totalEur": "3612.80"
  },
  "dades": [
    {
      "comandaId": 142,
      "num": "000142",
      "client": "Restaurant Example",
      "poblacioDesti": "Manresa",
      "tarifa": "Restaurants",
      "transportista": "DHL",
      "estat": "oberta",
      "dataComanda": "2026-08-14T09:12:00Z",
      "dataExpedicio": "2026-08-17T00:00:00Z",
      "dataLliurament": "2026-08-18T00:00:00Z",
      "bultos": 3,
      "linies": 8,
      "totalKg": "24.500",
      "totalEur": "312.40",
      "obsProduccio": true,
      "obsLliurament": "Entregar pels matins",
      "totalIncidencies": 0,
      "tipusIncidencia": null
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 12, "totalPagines": 1 }
}
```

> **`bultos` (capa 35)** — sin novedad más allá de exponerlo: es
> `comanda.bultos` tal cual, editable vía `PATCH /comandes/:id`.
>
> **`obsProduccio` (capa 35) — BREAKING, cambió de tipo.** Antes era el
> texto de `comanda.obsProduccio` (`string | null`); ahora es un booleano
> pensado para el checkbox del panel ("¿hay algo que ver en producción?"),
> `true` si la cabecera tiene contenido **O** alguna línea activa (no
> esborrada) tiene su propio `obsProduccio` cargado — antes, una
> observación cargada sólo en una línea era invisible en este listado,
> aunque sí se veía en `GET /comandes/:id`. El texto completo de cabecera y
> de cada línea sigue disponible ahí para quien lo necesite.
>
> **`obsLliurament` NO cambió** — sigue siendo el texto de
> `comanda.obsLliurament` tal cual, sin equivalente de "revisar líneas":
> `comanda_linia` no tiene una columna `obsLliurament` propia, sólo
> `obsProduccio`. No hay nada a nivel de línea que este campo pudiera
> reflejar.

> `totals` corresponde a **todo lo filtrado**, no sólo a la página visible. Es
> el bloque de subtotales que va arriba de la tabla.
>
> `totalIncidencies`/`tipusIncidencia`: mismo criterio que en `GET /comandes`
> (sección 4.5) — resumen liviano, el detalle completo está en
> `GET /comandes/:id`.

---

### 4.7 · Panell Obrador

**Cambio de criterio, confirmado con el cliente el 18/08/2026 (prototipo +
reunión): ya NO es "agrupado por producto".** Obrador muestra líneas de
pedido individuales, sin agrupar — cada fila es una línea real de un pedido
real, no un total sumado. `TotalsPanellObradorApi` no cambió:
`linies`/`totalUnitats`/`totalKg` siguen siendo válidos sumados sobre las
líneas individuales visibles.

**`GET /panells/obrador`**

Filtros: `?dataProduccioDes=&dataProduccioFins=&categoriaId=&tipus=&producte=&format=&envasat=`

> `dataProduccioFins` incluye el día completo — ver "Filtros de rango de
> fecha" en la sección 2 (capa 36).

> **Orden por defecto (capa 46), no opcional**: las líneas **pendientes**
> (`treballatA` es `null`) salen siempre primero, sin que el frontend pida
> nada — necesario porque con paginación real (`?mida=`) una página podría
> mostrar sólo líneas ya trabajadas si las pendientes cayeran en otra
> página. Dentro de cada grupo (pendientes / trabajadas) el orden es el
> mismo de siempre: `dataProduccio` ascendente, después `num` de pedido,
> después `ordinal` de línea — sin ningún criterio nuevo ahí.

```json
{
  "totals": {
    "linies": 34,
    "totalUnitats": "187.00",
    "totalKg": "142.300"
  },
  "dades": [
    {
      "liniaId": 982,
      "comandaId": 142,
      "producte": { "id": 13, "codi": "PIC01", "descripcio": "Picada de porc" },
      "categoria": "Fresc",
      "format": null,
      "envasat": "NORMAL",
      "client": "Restaurant Example",
      "dataProduccio": null,
      "unitats": "4.00",
      "kg": "0.000",
      "obsProduccio": null,
      "treballatA": null,
      "treballatPer": null
    },
    {
      "liniaId": 981,
      "comandaId": 142,
      "producte": { "id": 12, "codi": "LLF01", "descripcio": "Llom fresc de porc" },
      "categoria": "Fresc",
      "format": "SENCER",
      "envasat": "NORMAL (pes)",
      "client": "Restaurant Example",
      "dataProduccio": "2026-08-16T06:00:00Z",
      "unitats": "10.00",
      "kg": "12.500",
      "obsProduccio": "Tallar fi",
      "treballatA": "2026-08-16T07:15:00Z",
      "treballatPer": { "id": 4, "nom": "Marc Obrador" }
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 34, "totalPagines": 1 }
}
```

> El orden de este ejemplo cambió en la capa 46 (antes mostraba la línia
> trabajada primero) — ver la nota de orden por defecto arriba.

> Cada fila es exactamente una `comanda_linia` — `liniaId`/`comandaId`
> identifican de qué pedido viene, por si obrador necesita volver al
> detalle. `dataProduccio` es la de la LÍNEA (ver sección 4.5), no la de la
> cabecera del pedido.
>
> **`unitats`/`totals.totalUnitats` — BREAKING (capa 38): string, no
> number** — mismo motivo y mismo criterio que
> `ComandaLiniaApi.unitatsDemanades` (sección 4.5): la columna es
> `NUMERIC(10,2)` desde esta capa. `totalUnitats` (SUM agregado) recibió el
> mismo cast explícito que ya tenía `totalKg`, por el mismo motivo — evitar
> sumar en JS con floats.

> **Filtros nuevos (capa 20), pedidos por el demo de Lovable:**
>
> - **`producte`** filtra por `producte.descripcio` — coincidencia EXACTA,
>   sin distinguir mayúsculas/minúsculas (no substring). Mismo criterio que
>   `GET /rendiments-porcs` y `GET /panells/produccio` (sección 4.10) — es
>   una regla transversal del proyecto: el frontend pasa la descripción
>   completa tal como aparece en un desplegable, no un texto de búsqueda
>   libre.
> - **`format`**/**`envasat`** filtran por `producte.format`/`producte.envasat`
>   — coincidencia exacta.
>
> Ningún filtro nuevo devuelve error si no matchea nada: `dades` queda
> vacío y `totals` en cero, igual que cualquier otro filtro de este panel.

> **`treballatA`/`treballatPer` (capa 40)** — Obrador no tenía forma de
> marcar una línea como "trabajada", a diferencia de Empaquetat
> (`confirmatA`/`confirmatPer`, sección 4.8/5). Se marca con
> `PATCH /comandes/:comandaId/linies/:liniaId/treball` (ver más abajo).
> `treballatA` es `null` si nadie la marcó (o se desmarcó). `treballatPer`
> es una referencia real `{id, nom}` — a diferencia de `confirmatPer`
> (texto plano con el uid de Firebase, diseñado antes de que existiera la
> tabla de usuarios), acá sí hay un FK real a `usuari`, así que se resuelve
> a un nombre de persona de verdad.

**`PATCH /comandes/:comandaId/linies/:liniaId/treball`** (capa 40) — marca
o desmarca una línea como trabajada desde Obrador.

```json
{ "marcat": true }
```

Respuesta `200`:

```json
{
  "liniaId": 981,
  "comandaId": 142,
  "treballatA": "2026-08-16T07:15:00Z",
  "treballatPer": { "id": 4, "nom": "Marc Obrador" }
}
```

- `marcat: true` → `treballatA` pasa a la hora del servidor, `treballatPer`
  al usuario autenticado que hizo la llamada.
- `marcat: false` → **desmarca**: ambos vuelven a `null`.
- La respuesta siempre se relee de la base después de escribir — nunca
  ecoa valores calculados en el momento (ver el hallazgo de la capa 38
  sobre `LliuramentRespostaApi.unitatsLliurades`, que si hacía eso).
- `409 CONFLICTE` si la comanda está congelada — mismo criterio que el
  resto de los endpoints de línea. `400 VALIDACIO` si `marcat` falta o no
  es booleano. `404 NO_TROBAT` si la línea no existe.

---

### 4.8 · Panell Empaquetat

**Es el único panel con edición.** Todo lo demás es sólo lectura.

**`GET /panells/empaquetat`**

Filtros: `?dataExpedicioDes=&dataExpedicioFins=&dataLliuramentDes=&dataLliuramentFins=&transportistaId=&clientId=&producte=`

> `dataExpedicioFins`/`dataLliuramentFins` incluyen el día completo — ver
> "Filtros de rango de fecha" en la sección 2 (capa 36).
>
> **Filtros nuevos (capa 37):** `dataLliuramentDes`/`dataLliuramentFins`
> (rango sobre `dataLliurament`, mismo criterio que
> `dataExpedicioDes`/`Fins`) y `producte` (coincidencia EXACTA
> case-insensitive contra `producte.descripcio` — regla 3.1 transversal,
> mismo criterio que `?producte=` en `/panells/obrador`,
> `/panells/produccio` y `/rendiments-porcs` — no substring).

> **Orden por defecto (capa 46), no opcional**: mismo criterio que
> `/panells/obrador` (sección 4.7) — las líneas **pendientes**
> (`confirmatA` es `null`) salen siempre primero, sin que el frontend pida
> nada. Dentro de cada grupo (pendiente / confirmada) el orden es el mismo
> de siempre: `dataExpedicio` ascendente, después `num`, después `ordinal`.

```json
{
  "totals": {
    "linies": 50,
    "unitatsDemanades": "312.00",
    "unitatsLliurades": "118.00",
    "kgDemanats": "284.750",
    "kgLliurats": "96.400",
    "liniesConfirmades": 18,
    "liniesPendents": 32
  },
  "dades": [
    {
      "liniaId": 981,
      "comandaId": 142,
      "num": "000142",
      "dataExpedicio": "2026-08-17T00:00:00Z",
      "dataLliurament": "2026-08-18T00:00:00Z",
      "transportista": "DHL",
      "client": "Restaurant Example",
      "codi": "LLF01",
      "producte": "Llom fresc de porc",
      "unitatsDemanades": "10.00",
      "kgDemanats": "12.500",
      "unitatsLliurades": "0.00",
      "kgLliurats": "0.000",
      "confirmatA": null,
      "confirmatPer": null
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 50, "totalPagines": 1 }
}
```

> **`unitatsDemanades`/`unitatsLliurades` (línia y `totals`) — BREAKING
> (capa 38): string, no number** — mismo motivo y mismo criterio que
> `ComandaLiniaApi.unitatsDemanades` (sección 4.5). Los dos `totals` (SUM
> agregados) recibieron el mismo cast explícito que ya tenían `kgDemanats`/
> `kgLliurats`, por el mismo motivo.

---

### 4.9 · Rendiments Porcs

Nueva (confirmada con el cliente el 18/08/2026). Ficha de rendimiento por
producto: cuántas unidades salen de un cerdo y cuánto pesa cada una — es la
base del cálculo del Panell Producció (sección 4.10).

**`GET /rendiments-porcs`**

Filtros: `?agrupacioRendiment=KG&categoria=Fresc&agrupacioProduccio=Llom&producte=Llom fresc de porc`

`producte` filtra por descripció con **coincidencia exacta** (no
case-sensitive) — regla 3.1 transversal del proyecto
(`docs/especificacion-funcional-dpages.md`): buscar "Llom" no debe traer
"Cap de llom". Igual que `agrupacioRendiment`/`categoria`/`agrupacioProduccio`,
que también son coincidencia exacta.

> **`agrupacioProduccio` (capa 45, corrección de Michel)**: hasta esta
> capa quedó case-sensitive por descuido, inconsistente con `producte` de
> arriba — buscar "llom" no traía nada si el dato real era "Llom". Ya
> aplica el mismo criterio (`LOWER(...) = LOWER(...)`, regla 3.1). El
> mismo fix se aplicó también en `GET /productes` (sección 4.2), que tiene
> el mismo filtro con el mismo bug.

```json
{
  "dades": [
    {
      "id": 1,
      "agrupacioRendiment": "KG",
      "categoria": "Fresc",
      "agrupacioProduccio": "Llom",
      "unitatsPerPorc": "2.00",
      "kgPerUnitat": "3.500",
      "pesTotal": "7.000"
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 42, "totalPagines": 1 }
}
```

> **BREAKING (capa 22):** la fila ya NO trae `producte` — Francesc sacó esa
> columna de la pantalla (ver nota de Panell Producció más abajo, mismo
> motivo). `producteId` sigue existiendo como campo de ENTRADA de
> `POST /rendiments-porcs` (el alta/edición sigue necesitando elegir el
> producto) — esto sólo afecta lo que se devuelve. El filtro `?producte=`
> tampoco cambia.

> `agrupacioRendiment`, `categoria` y `agrupacioProduccio` son de **sólo
> lectura** acá: se derivan del producto/categoría asociados (secciones 4.1
> y 4.2), no se editan en este CRUD. `pesTotal` es calculado por el backend
> (`unitatsPerPorc × kgPerUnitat`), tampoco se envía en las escrituras.
>
> Una fila sólo aparece en el listado si el producto asociado pertenece a
> una categoría con `agrupacioRendiment` definido (no `null`) — si no, no
> hay con qué rellenar `agrupacioRendiment`/`categoria`, que en este
> contrato no son nulables. `POST` aplica la misma regla como validación de
> alta (ver abajo), así que en la práctica una fila nunca debería quedar
> "invisible" salvo que la categoría del producto cambie _después_ de
> crearla.

**`POST /rendiments-porcs`**

```json
{ "producteId": 12, "unitatsPerPorc": "2.00", "kgPerUnitat": "3.500" }
```

`unitatsPerPorc` admite hasta 2 decimales, `kgPerUnitat` hasta 3 (mismas
escalas que la columna en base). Rechaza con `400 VALIDACIO` si el producto
no existe o si su categoría no tiene `agrupacioRendiment` definido — sin
esto, la fila creada no podría aparecer nunca en el `GET` (ver nota arriba).

Respuesta `201`, misma forma que una fila de `GET /rendiments-porcs`.

**`PATCH /rendiments-porcs/:id`** — línea por línea, mismo criterio de
edición en línea que el resto del sistema (sin ventana emergente). Cuerpo
parcial: `unitatsPerPorc` y/o `kgPerUnitat`. `producteId` no se edita una vez
creada la fila.

**`DELETE /rendiments-porcs/:id`** — `204` sin cuerpo.

---

### 4.10 · Panell Producció

Confirmada con el cliente el 18/08/2026, implementada en la capa 16. Sólo
lectura. Una fila por **agrupació de producció** (no por producte
individual — varios artículos pueden compartir una misma agrupación) con
demanda en el rango filtrado, calculada a partir de los pedidos y de la
ficha de `Rendiments Porcs`.

**`GET /panells/produccio`**

Filtros: `?nombrePorcs=5&agrupacioRendiment=KG&producte=Llom fresc de porc&dataDes=2026-08-01&dataFins=2026-08-31`

- **`dataFins` en este endpoint YA incluía el día completo antes de la capa
  36** — compara sólo la parte de fecha en ambos lados (`::date BETWEEN`),
  sin el bug sistémico que sí tenían los demás filtros `...Fins` del
  proyecto. No se tocó.
- **`nombrePorcs` es obligatorio.** Sin él, o con `0`/negativo, responde
  `400 VALIDACIO` — es una calculadora interactiva, un default silencioso
  podría hacer pensar que un número inventado es el resultado real.
- `producte` filtra por descripció con **coincidencia exacta**
  (case-insensitive), igual que `GET /rendiments-porcs` (regla 3.1
  transversal del proyecto).
- `dataDes`/`dataFins` son opcionales — default `dataDes` = mañana (hoy +
  1 día), `dataFins` = hoy + 7 días.

> **BREAKING (capa 22):** la fila de respuesta ya NO trae `producte`.
> Anteriormente traía sólo UN artículo representativo de la agrupación (el
> de `id` más chico entre los que la componen, elegido de forma
> determinística) — con datos reales, una agrupación de producción suele
> tener varios SKUs asociados, y mostrar sólo uno confundía más de lo que
> ayudaba. Francesc lo sacó de las dos pantallas afectadas (esta y
> Rendiments Porcs, sección 4.9). El filtro `?producte=` sigue existiendo
> — esto sólo afecta la respuesta, no la capacidad de filtrar. No afecta al
> cálculo, que siempre opera sobre la agrupación completa.

```json
{
  "totals": {
    "totalKgAElaborar": "0.000",
    "totalKgMagro": "0.000",
    "diferencia": "0.000",
    "kgJamon": "60.000",
    "kgRecortes": "30.000",
    "kgPaletillas": "35.000"
  },
  "dades": [],
  "paginacio": { "pagina": 1, "mida": 50, "total": 0, "totalPagines": 0 }
}
```

> **`kgJamon`/`kgRecortes`/`kgPaletillas`** (capa 24) — rendimiento fijo por
> cerdo, confirmado por Francesc: de un cerdo salen en promedio 12 kg de
> jamón, 6 kg de recortes y 7 kg de paletillas. Son **constantes de
> negocio**, NO calculadas desde `Rendiments Porcs` (no hay artículos de
> catálogo individuales para "jamón"/"recortes"/"paletillas" con esos
> rendimientos cargados) — simplemente `constante × nombrePorcs`. Ejemplo
> del ejemplo de arriba con `nombrePorcs = 5`: `12 × 5 = 60,000`,
> `6 × 5 = 30,000`, `7 × 5 = 35,000`. Con `nombrePorcs = 10` (el caso
> confirmado por Francesc): `120,000` / `60,000` / `70,000`. Siempre traen
> un valor — nunca `null` — porque `nombrePorcs` ya es obligatorio para
> todo el endpoint (ver arriba). Si estos valores cambian en el futuro
> (por ejemplo con datos reales de rendimiento porcino), están pendientes
> de exponerse como configuración en vez de una constante en el código.

**Las tres fórmulas**, según `agrupacioRendiment` de la categoría de cada
producto — cada agrupación calcula un par distinto de campos, el resto
queda en `null` por fila:

**Agrupación `"KG"`** (cálculo por línea, en kilos — sólo `kgAElaborar`
tiene valor, `paqPedido` queda `null`, no aplica):

```
Rendiment  = unitatsPerPorc × kgPerUnitat × nombrePorcs
Diferencia = Rendiment − kgAElaborar
```

Ejemplo real (con `nombrePorcs = 5`): producto **COSTELLETA**,
`unitatsPerPorc = 2,00`, `kgPerUnitat = 12,000`.
`Rendiment = 2,00 × 12,000 × 5 = 120,000`. Con `kgAElaborar = 35,000`:
`Diferencia = 120,000 − 35,000 = 85,000`.

**Agrupación `"PAQ"`** (cálculo por línea, en unidades — sólo `paqPedido`
tiene valor, `kgAElaborar` queda `null`):

```
Rendiment  = unitatsPerPorc × nombrePorcs
Diferencia = Rendiment − paqPedido
```

Ejemplo real: producto **PEUS**, `unitatsPerPorc = 4,00`,
`nombrePorcs = 5`. `Rendiment = 4,00 × 5 = 20,00`. Con `paqPedido = 132,00`:
`Diferencia = 20,00 − 132,00 = −112,00` (negativo: se pidió más de lo que
rinden esos cerdos).

**Agrupación `"MAGRE"`** (sin cálculo por línea — `rendiment`/`diferencia`
quedan `null` en estas filas; se calcula un único total global, no se
reparte fila por fila):

```
totalKgMagro      = Σ(kgPerUnitat de cada agrupación de producción marcada
                       como magra en Rendiments Porcs) × nombrePorcs
diferencia global = totalKgMagro − totalKgAElaborar
```

Ejemplo real: tres agrupaciones magras rinden 12, 6 y 7 kg por cerdo
respectivamente. Con `nombrePorcs = 5`: `totalKgMagro = (12 + 6 + 7) × 5 =
125`. Con `totalKgAElaborar = 512,982` (ver abajo): `Diferencia = 125 −
512,982 = −387,982`.

**`totals.totalKgAElaborar`** (cabecera): suma de la columna `kgAElaborar`
de **todas** las filas visibles (incluidas las de agrupación `"KG"`) en el
rango de fechas filtrado — no sólo las de agrupación `"MAGRE"`.

> Estas fórmulas se derivaron por ingeniería inversa contra los datos de
> ejemplo del prototipo de Lovable, y verifican exacto en las 13 filas de
> referencia disponibles. **Pendiente de ratificación formal por el cliente
> (Francesc)** — no bloquea la implementación, pero si al confirmarlas
> aparece alguna corrección, esta sección (y el cálculo del backend cuando
> exista) se actualiza.

---

### 4.11 · Orígens de comanda

Confirmada con el cliente el 18/08/2026, implementada capa 43. CRUD de la
tabla `origen_comanda` — reemplaza el enum fijo `OrigenComanda` que tenía
el contrato hasta la versión anterior (ver sección 3). Modelo real de
negocio (capa 43): `woocommerce` (automático, sólo para pedidos
sincronizados, nunca se elige a mano), `manual` (valor histórico de
pedidos ya cargados a mano antes de esta capa — deja de ofrecerse en el
desplegable de alta nueva, pero sigue siendo un valor válido para lo
existente), y los 3 canales reales de un pedido manual: `whatsapp`,
`telefon`, `correu`.

**`GET /origens-comanda`**

```json
{
  "dades": [
    { "id": 1, "codi": "woocommerce", "nom": "WooCommerce", "actiu": true },
    { "id": 2, "codi": "manual", "nom": "Manual", "actiu": true },
    { "id": 3, "codi": "whatsapp", "nom": "WhatsApp", "actiu": true },
    { "id": 4, "codi": "telefon", "nom": "Telèfon", "actiu": true },
    { "id": 5, "codi": "correu", "nom": "Correu", "actiu": true }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 5, "totalPagines": 1 }
}
```

**`POST /origens-comanda`** — exige el mòdul `"comandes"`; sense ell, `403
SENSE_PERMIS`.

```json
{ "codi": "whatsapp", "nom": "WhatsApp" }
```

Respuesta `201`, misma forma que una fila de `GET /origens-comanda`
(`actiu` arranca en `true` si no se manda). `codi` repetido → `409
CONFLICTE`.

**`PATCH /origens-comanda/:id`** — cuerpo parcial (`nom`, `actiu`). Exige
el mòdul `"comandes"`, mismo criterio que `POST`. `codi` no se edita una
vez creado — es la clave estable que usan
`ComandaResumApi.origen`/`ComandaDetallApi.origen`; si se manda igual en
el cuerpo, se ignora en silencio (mismo criterio que `firebaseUid`/`email`
en `PATCH /usuaris/:id`).

> No hay `DELETE /origens-comanda/:id` (capa 43, mismo criterio que
> `/transportistes` y `/usuaris`): para dar de baja un origen,
> `PATCH { "actiu": false }` — borrarlo de verdad podría dejar
> `comanda.origen_id` apuntando a nada.

---

### 4.12 · Usuaris i rols

Confirmada con el cliente el 18/08/2026, implementada en la capa 17. Un
**rol** define qué módulos de la aplicación puede VER el usuario — no
restringe acciones dentro de un módulo. Ver ADR-021: hasta la capa 19,
ningún endpoint de negocio bloqueaba por rol; `modulsPermesos` era sólo lo
que el **frontend** usaba para decidir qué mostrar en el menú. La capa 19
(`POST /usuaris`) fue la primera excepción: el backend mismo exige el
módulo `"usuaris"` porque dar de alta gente con acceso al sistema no puede
quedar librado a que el frontend oculte el botón.

> **Agujero de seguridad corregido en la capa 39.** Tres endpoints de
> gestión de usuarios/roles se habían quedado sin esa misma protección:
> `PATCH /usuaris/:id` (cualquier usuario autenticado, incluido uno recién
> auto-provisionado como `"General"`, podía editar el `rolId` de
> cualquiera — incluido el propio, auto-promoviéndose a Administrador) y
> `POST`/`PATCH /rols` (cualquier usuario autenticado podía crear o editar
> roles, incluido agregarles `"usuaris"`/`"rols"` a `modulsPermesos`). Los
> tres exigen ahora el mismo módulo `"usuaris"` que ya exigía
> `POST /usuaris` — `403 SENSE_PERMIS` sin él. El resto de los endpoints de
> negocio sigue sin restricción de rol, tal como antes.

> **Decisión de negocio ya tomada:** hoy existen dos roles. `"General"`
> tiene acceso a todos los módulos **operativos** del negocio (lo que
> pidió el cliente, "todos ven todo"); `"Administrador"` tiene además la
> gestión de usuarios y roles (`usuaris`, `rols`). **Todo usuario nuevo se
> asigna a `"General"` automáticamente** (ver auto-provisioning más
> abajo) — nadie obtiene gestión de usuarios/roles sólo por loguearse
> primero. Promover a alguien a `"Administrador"` es una acción manual
> posterior, hecha por alguien que ya sea Administrador, vía
> `PATCH /usuaris/:id { "rolId": <id de Administrador> }`. El sistema de
> roles queda parametrizable sin desarrollo futuro si algún día quieren
> más granularidad: basta con crear más roles (`POST /rols`) y reasignar
> usuarios, no hace falta ningún cambio de código.

**`GET /rols`**

```json
{
  "dades": [
    {
      "id": 1,
      "nom": "Administrador",
      "modulsPermesos": [
        "categories",
        "catalog",
        "tarifes",
        "tarifes-clients",
        "comandes",
        "rendiments-porcs",
        "panell-oficina",
        "panell-obrador",
        "panell-empaquetat",
        "panell-produccio",
        "usuaris",
        "rols"
      ]
    },
    {
      "id": 2,
      "nom": "General",
      "modulsPermesos": [
        "categories",
        "catalog",
        "tarifes",
        "tarifes-clients",
        "comandes",
        "rendiments-porcs",
        "panell-oficina",
        "panell-obrador",
        "panell-empaquetat",
        "panell-produccio"
      ]
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 2, "totalPagines": 1 }
}
```

> **`paginacio` (capa 46)**: era la única de ~12 rutas de listado sin este
> objeto. Mismo patrón que el resto (`?pagina=&mida=`, sección 2) — el
> orden (`nom ASC`) no cambió.

**`POST /rols`** · **`PATCH /rols/:id`** (cuerpo parcial) · **`DELETE /rols/:id`**
(capa 39) — **los tres exigen el módulo `"usuaris"`** (ver nota de
seguridad arriba); sin él, `403 SENSE_PERMIS`.

```json
{ "nom": "Obrador", "modulsPermesos": ["panell-obrador"] }
```

> **`modulsPermesos` (capa 39) se valida contra una lista cerrada.**
> Cualquier valor fuera de esta lista rechaza con `400 VALIDACIO`, con el/
> los valor(es) inválido(s) en el detalle del error. Hoy es (`"rols"`
> incluido, aunque el frontend todavía no tiene una pantalla de gestión de
> roles que lo consuma — sigue siendo un permiso válido):
>
> `categories`, `catalog`, `tarifes`, `tarifes-clients`, `comandes`,
> `rendiments-porcs`, `panell-oficina`, `panell-obrador`,
> `panell-empaquetat`, `panell-produccio`, `usuaris`, `rols`,
> `transportistes`.
>
> **Esta lista puede quedar desactualizada acá** (ya pasó con
> `transportistes`, agregado a `MODULS_VALIDS` sin actualizar este
> ejemplo) — `GET /rols/moduls-valids` (capa 44, ver abajo) es la fuente
> viva, pensada exactamente para que ningún consumidor (frontend incluido)
> tenga que mantener su propia copia hardcodeada.

**`GET /rols/moduls-valids`** (capa 44) — la lista real y actual de
módulos válidos, la misma constante que valida `modulsPermesos` arriba.
Sin guard (información de referencia, igual que `GET /rols`). Pensado
para que el frontend (`lib/roles.ts`, `MODULS_VALIDS`) deje de mantener su
propia copia — el hallazgo que motivó esta capa: un módulo agregado de un
lado sin avisar al otro fallaba en silencio (pasó con `transportistes`).

```json
{
  "dades": [
    "categories",
    "catalog",
    "tarifes",
    "tarifes-clients",
    "comandes",
    "rendiments-porcs",
    "panell-oficina",
    "panell-obrador",
    "panell-empaquetat",
    "panell-produccio",
    "usuaris",
    "rols",
    "transportistes"
  ]
}
```

> Sólo los códigos, no nombres legibles: `MODULS_VALIDS` en el backend
> nunca tuvo nombres para mostrar en UI — eso vive hoy sólo en el
> frontend (`MODUL_LABELS` de `lib/roles.ts`). Agregar acá un mapeo de
> etiquetas habría creado una segunda fuente de verdad para texto de
> interfaz que el backend no necesita — no es el duplicado que esta capa
> vino a resolver.

**`DELETE /rols/:id`** (capa 39, no existía) — **borrado protegido**, mismo
criterio que `DELETE /categories/:id`: si algún `usuari` tiene este rol
asignado (`usuari.rolId`), rechaza con `409 CONFLICTE` — nunca se puede
borrar un rol en uso, porque `usuari.rolId` es obligatorio y no hay a qué
reasignarlo automáticamente. Sin usuarios asignados, `204` sin cuerpo.
`404 NO_TROBAT` si el id no existe.

**`GET /usuaris`**

Filtros: `?actiu=true&cerca=anna`

> **`cerca` (issue #17, Michelle/Francesc) — substring (`ILIKE`), sobre
> `nom` O `email`** (OR multi-columna), reemplaza un filtro client-side que
> daba resultados inconsistentes al filtrar sólo sobre la página ya
> cargada. Mismo criterio substring que `cerca` en `clients`/`comandes` —
> no el de `productes`/`tarifes` (exacto, sección 2, regla 3.1).

```json
{
  "dades": [
    {
      "id": 1,
      "firebaseUid": "abc123firebase",
      "nom": "Anna Oficina",
      "email": "anna@dpages.cat",
      "rol": {
        "id": 2,
        "nom": "General",
        "modulsPermesos": ["categories", "comandes", "panell-produccio"]
      },
      "actiu": true
    }
  ],
  "paginacio": { "pagina": 1, "mida": 50, "total": 8, "totalPagines": 1 }
}
```

**`PATCH /usuaris/:id`** (cuerpo parcial) — sólo `nom`, `rolId` y `actiu`.
`firebaseUid` y `email` son **inmutables** una vez creado el usuario (el
vínculo con el token de Firebase no se reasigna a mano). **Exige el módulo
`"usuaris"` (capa 39)** — sin él, `403 SENSE_PERMIS`, incluido el caso de
un usuario intentando editar su propio `rolId` (auto-promoción).

```json
{ "nom": "Anna Empaquetat", "rolId": 2 }
```

> Tampoco hay `DELETE /usuaris/:id`: para dar de baja a alguien,
> `PATCH { "actiu": false }` (ver rechazo 403 abajo) — igual que
> `origen_comanda`, borrar de verdad podría dejar referencias rotas
> (`comanda_linia.confirmatPer`, auditoría).

**`POST /usuaris`** (capa 19) — alta manual de un usuario, hecha por un
Administrador. **Sólo accesible para usuarios con `"usuaris"` en su
`modulsPermesos`**; sin ese módulo, `403 SENSE_PERMIS` (mismo código que
el rechazo por `actiu = false` de abajo, pero el motivo es otro: acá no es
que el usuario esté desactivado, es que su rol no incluye este módulo).

```json
{ "nom": "Marc Empaquetat", "email": "marc@dpages.cat", "rolId": 2 }
```

Respuesta `201`:

```json
{
  "usuari": {
    "id": 9,
    "firebaseUid": "xyz789firebase",
    "nom": "Marc Empaquetat",
    "email": "marc@dpages.cat",
    "rol": { "id": 2, "nom": "General", "modulsPermesos": ["categories", "comandes"] },
    "actiu": true
  },
  "linkEstabliment": "https://.../__/auth/action?mode=resetPassword&oobCode=..."
}
```

> **No hay envío de email automático — el backend no tiene esa
> capacidad.** El flujo es: (1) valida que `rolId` exista y que el email
> no esté ya usado (`409 CONFLICTE` si sí); (2) crea el usuario en
> Firebase Authentication (sin contraseña utilizable — se genera una
> aleatoria descartable, nadie la conoce); (3) crea la fila de `usuari`
> local; (4) genera con el Admin SDK de Firebase un link de "establecé tu
> contraseña" de **un solo uso** (`generatePasswordResetLink`) y lo
> devuelve en `linkEstabliment`. **El Administrador que dio de alta a la
> persona es quien comparte ese link a mano**, por el canal que use
> (WhatsApp, email personal, lo que sea) — el frontend debe mostrarlo de
> forma que se pueda copiar fácilmente, porque no hay ninguna otra manera
> de que la persona nueva lo reciba. Si algo falla después de crear el
> usuario en Firebase (el alta local o generar el link), el backend
> revierte borrando el usuario de Firebase — nunca queda un usuario
> huérfano allá sin fila local acá.
>
> El campo `linkEstabliment` nunca debe quedar en un log ni guardarse en
> ningún sitio más allá de esta respuesta — es un token de un solo uso que
> da acceso a establecer la contraseña de otra persona.
>
> **A dónde redirige Firebase DESPUÉS de que la persona ya estableció su
> contraseña (capa 47)**: `<origen>/login?passwordReset=success` — nadie
> ve `linkEstabliment` en sí (es la URL de Firebase con el `oobCode`), pero
> sí ve esta pantalla al terminar. `<origen>` se resuelve con el MISMO
> criterio que CORS (`http/cors.ts`/`opcionsCors()`): fuera de producción,
> `http://localhost:3000` fijo; en producción, `CORS_ORIGIN`. Si
> `CORS_ORIGIN` falta en producción, `POST /usuaris` falla explícito en vez
> de generar un link con un origen vacío/roto.

**`GET /jo`** — devuelve el usuario autenticado (resuelto por el `uid` del
token de Firebase, sección 2) con su rol y módulos permitidos. Es lo
primero que llama el frontend después de loguearse, para saber en qué
panel ubicar a la persona por defecto y qué mostrar en el menú.

```json
{
  "id": 1,
  "firebaseUid": "abc123firebase",
  "nom": "Anna Oficina",
  "email": "anna@dpages.cat",
  "rol": {
    "id": 2,
    "nom": "General",
    "modulsPermesos": ["categories", "comandes", "panell-produccio"]
  },
  "actiu": true
}
```

#### Auto-provisioning (comportamiento observable, no sólo interno)

**Todo endpoint de negocio (sección 2) resuelve automáticamente un
`usuari` a partir del `uid` del token de Firebase.** Si es la primera vez
que ese `uid` llama a la API, el sistema **crea la fila de `usuari`
en el momento**, con:

- `rolId` = el rol `"General"` (siempre, hoy — ver decisión de negocio
  arriba). **Nunca** `"Administrador"`: nadie obtiene gestión de usuarios
  ni roles sólo por loguearse primero. Alguien ya-Administrador tiene que
  promoverlo a mano después, con `PATCH /usuaris/:id`.
- `nom`/`email` = los claims `name`/`email` del propio token; si el
  proveedor de autenticación no trae `name`, se usa el `email`.
- `actiu` = `true`.

Esto es deliberado: no bloquea a nadie con una pantalla de alta de
usuarios que todavía no existe. Sigue activo incluso ahora que existe
`POST /usuaris` (capa 19) — ambos caminos conviven: alta manual por un
Administrador de antemano, o auto-provisioning la primera vez que alguien
se loguea sin haber sido dado de alta. Revisar si conviene desactivarlo
(exigiendo que el usuario ya exista) es una decisión pendiente, no
tomada todavía.

**Usuario existente con `actiu = false`:** la petición se rechaza con
`403 SENSE_PERMIS` antes de llegar a cualquier endpoint — no hay forma de
que un usuario desactivado siga usando el sistema con un token todavía
válido.

---

## 5. El endpoint de empaquetado

Es el más delicado del sistema. Merece su propia sección.

**`PATCH /comandes/:comandaId/linies/:liniaId/lliurament`**

```json
{
  "unitatsLliurades": 8,
  "kgLliurats": "9.750"
}
```

Respuesta `200`:

```json
{
  "liniaId": 981,
  "comandaId": 142,
  "unitatsLliurades": "8.00",
  "kgLliurats": "9.750",
  "confirmatA": "2026-08-15T11:42:00Z",
  "confirmatPer": { "id": 7, "nom": "Operari empaquetat" }
}
```

> **`unitatsLliurades` — BREAKING (capa 38): en la respuesta es string, no
> number** (mismo motivo que en `ComandaLiniaApi.unitatsDemanades`, sección
> 4.5 — la columna es `NUMERIC(10,2)` desde esta capa). **En el body de
> entrada sigue siendo un JS number normal**, admite decimales (ej.
> `{ "unitatsLliurades": 2.5 }` para una entrega parcial de pieza) — sólo
> la salida cambió de tipo.

### Reglas de negocio, confirmadas por el cliente

**Ambos campos son obligatorios, pero SÍ pueden quedar en cero** — issue
#19 (Francesc, confirmado hoy) reabrió y reemplazó la regla anterior
("nunca guardar una línea en cero"): un pedido puede terminar con 0
unidades/kg realmente entregados (ej. rotura total, artículo agotado),
y hay que poder registrarlo así, no forzar un valor ficticio. El
backend sigue rechazando con `400 VALIDACIO` cualquier valor inválido
(negativo, no numérico, o con más de 2 decimales en `unitatsLliurades`)
— sólo se sacó la condición de "mayor que cero".

**Ambos llegan siempre en cero por defecto**, aunque coincidan con lo pedido.
El operario debe teclearlos de todos modos. Es doble confirmación deliberada:
el cliente quiere que la persona _escriba_ el peso, no que marque un visto
bueno, porque el visto bueno se convierte en automatismo.

**No se puede guardar sin confirmar.** Rellenar los campos y no marcar la
confirmación no es un estado válido.

**Por qué existe todo esto:** por mermas se envía menos de lo pedido —una
longaniza sale más corta, falta materia prima— y la diferencia entre lo pedido
y lo enviado determina si se emite un abono o se cobra de más. Es conciliación
económica, no un detalle de interfaz.

### Requisitos de interfaz, pedidos expresamente

**Sin ventanas emergentes.** Edición en línea: columna editable más un botón de
aceptar por fila, con el mismo patrón del mantenimiento de tarifas.

El motivo lo explicó el consultor funcional del cliente con claridad: el
operario tiene delante una lista de unas 50 líneas y debe rellenarlas _todas_.
Cincuenta ventanas emergentes, con el camión esperando, es inviable. Y cada vez
que una ventana se cierra, la persona tiene que volver a ubicar visualmente en
qué fila estaba.

**Una llamada por fila.** No acumules cambios para enviarlos juntos: si el
operario confirma una fila, esa fila se guarda. Si la conexión se corta, no se
pierde el trabajo de las anteriores.

> **Emparentado, pero más simple (capa 40):**
> `PATCH /comandes/:comandaId/linies/:liniaId/treball` (sección 4.7) marca/
> desmarca una línea como trabajada desde Obrador — mismo guard de
> congelación, pero sin las reglas de "nunca cero"/doble confirmación de
> este endpoint: es un booleano, no una cantidad.

---

## 6. Salud del servicio

**`GET /salut`** — sin autenticación.

```json
{ "estat": "ok", "versio": "0.1.0", "baseDades": "ok" }
```

---

## 7. Pendiente de definición

No están en el contrato porque el cliente todavía no los definió. Michel: no
construyas nada encima de estos puntos.

| Tema                                     | Estado                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Fórmulas del Panell Producció            | Shape de la respuesta cerrado (sección 4.10); los números de las tres fórmulas (KG/PAQ/MAGRE) todavía no |
| Descuentos                               | El 45 % de los pedidos web llevan cupón, pero quedaron fuera de esta versión. Sin confirmar              |
| Asignación de transportista              | Sin criterio definido                                                                                    |
| Si el sistema es bilingüe o sólo catalán | Sin confirmar                                                                                            |

> **Resuelto el 18/08/2026** (ya no pendiente, ya está en el contrato):
> campos de agrupación del catálogo (`agrupacioProduccio`, `format`,
> `envasat`, sección 4.2), `agrupacioRendiment` de categoría (sección 4.1),
> y el shape de Panell Producció y Rendiments Porcs (secciones 4.9 y 4.10
> — sólo faltan los números de las fórmulas, ver arriba).

---

## 8. Cómo simular la API mientras no exista

Sugerencia para arrancar mañana sin depender del backend.

Poné cada respuesta de ejemplo de este documento en un archivo dentro de
`packages/frontend/src/mocks/`, y creá una única capa de acceso a datos que en
desarrollo lea de ahí y en producción llame a la API real. Toda petición pasa
por esa capa; ningún componente llama a `fetch` directamente.

Así, el día que conectemos, se cambia un archivo y nada más.

Tres cosas que conviene simular desde el principio, porque son los casos que
más rompen interfaces cuando aparecen tarde:

- Un artículo con `pesKg` en `null` (a medida) junto a otro con peso.
- Un pedido con `congelada: true`.
- Una respuesta de error `400 VALIDACIO`, para que el formulario sepa mostrarla.

---

## 9. Control de cambios

Este contrato es un acuerdo entre dos personas. Si hace falta cambiarlo:

1. Se avisa antes de tocar `@dpages/shared`.
2. Se actualiza este documento en el mismo cambio.
3. Los cambios que rompen compatibilidad se conversan, no se empujan.
