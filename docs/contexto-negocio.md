# Contexto de negocio

## El cliente y el problema

dPagès es una empresa catalana de producción y distribución de carne.
Gestiona 80–100 pedidos semanales mediante hojas de Excel interconectadas,
frágiles y dependientes de personas concretas. Este proyecto las reemplaza
por un sistema web propio.

## Canales de entrada

| Canal              | Volumen aproximado |
| ------------------ | ------------------ |
| Web (WooCommerce)  | 16–20%             |
| Correo electrónico | resto              |
| WhatsApp           | resto              |
| Teléfono           | resto              |

**El sistema no es un espejo de WooCommerce.** Es el sistema de pedidos de la
empresa; WooCommerce es uno de los cuatro canales de entrada, y el minoritario
en volumen. Cualquier diseño que asuma que "todo pedido viene de WooCommerce"
está mal.

## Equipo del cliente y operación

- ~10 personas entre oficina, obrador y empaquetado.
- Catálogo real: ~111 artículos (cortes, pesos, embalajes distintos por
  artículo).
- Cuatro paneles de uso: oficina, obrador, empaquetado, producción/
  planificación. Sólo empaquetado edita; el resto es de sólo lectura con
  filtros y subtotales.
- Idioma de salida: catalán. Bilingüe catalán/castellano posible, sin
  confirmar (ver "Pendientes" abajo).

## Roles y permisos

**Decisión del cliente**: no hace falta restringir accesos por rol. Todo el
mundo ve todo — cualquier usuario autenticado puede consultar y operar
cualquiera de los cuatro paneles (oficina, obrador, empaquetado,
producció/planificació). El rol de cada usuario sólo decide en qué panel
lo ubica el sistema por defecto al entrar, no qué puede ver o hacer.

**Decisión de VisioFlow**: mantener Firebase Auth con roles (custom claims)
de todos modos, mismo criterio de la propuesta original — no para bloquear
acceso a ningún endpoint, sino para tener el `uid` y el rol de quien hace
cada acción disponibles para auditoría (`comanda_linia.confirmat_per`, por
ejemplo). Implementación: ADR-021 en `decisiones-arquitectura.md`.

## Equipo de desarrollo

- **Gerardo** — backend, integración con WooCommerce, base de datos.
- **Michel** — frontend en Next.js.

Trabajan en paralelo; de ahí el monorepo con `packages/shared` como contrato
de tipos entre los dos.

## Plazos

Puesta en producción objetivo: **finales de septiembre de 2026**.

## Arquitectura (resumen — detalle en `decisiones-arquitectura.md`)

- Backend: Node.js sobre Cloud Run (Google Cloud).
- Base de datos: PostgreSQL sobre Cloud SQL (local: Docker).
- Autenticación: Firebase Auth (JWT con roles) — sólo autenticación, ningún
  dato de negocio.
- Frontend: Next.js + Tailwind.
- Región europea (europe-west1 o europe-southwest1) por RGPD.

## Reglas de negocio confirmadas por el cliente

- El peso es siempre en kg, con 3 decimales.
- No se puede grabar un pedido con líneas en cero (unidades o peso).
- Si el artículo tiene peso de ficha, el peso de línea no es editable (se
  calcula como unidades × peso de ficha). Si no tiene peso, es un artículo "a
  medida": arranca en cero, es editable, y no puede quedar en cero.
- En empaquetado, "unidades entregadas" y "kilos entregados"
  (`unitats_lliurades` / `kg_lliurats` en `comanda_linia`) son campos
  editables en línea, obligatorios, arrancan en cero, y requieren checkbox de
  confirmación explícita aunque coincidan con lo pedido (doble confirmación
  — motivo: por mermas se puede enviar menos de lo pedido, y hay que emitir
  abono o cargo).
- Cinco estados de pedido: `oberta`, `en_proces`, `tancada`,
  `amb_incidencia`, `cancellada` (añadido el 29/09/2026 a petición de Ari:
  los pedidos cancelados quedan fuera de todos los paneles, pero se siguen
  viendo en la pantalla de pedidos; en el Panel Oficina sólo aparecen si se
  filtra explícitamente por ese estado).
- El sistema sólo lee de WooCommerce. Nunca escribe de vuelta. La credencial
  de API es de sólo lectura.

## Pendientes de definición con el cliente

Estas decisiones están **abiertas**, no resueltas. No se implementan hasta
que se cierren — el código no debería anticiparlas ni asumir una respuesta:

- **Tratamiento de descuentos**: cómo se modelan y visualizan los cupones
  (ver `hallazgos-woocommerce.md` — un solo código de cupón explica 158
  pedidos y 1.654 € descontados en el período analizado).
- **Asignación de transportista**: los 11 métodos de envío observados en
  WooCommerce mezclan zona, gratuidad e idioma, y no identifican al
  transportista real.
- **Criterio final de identificación de cliente**: el NIF llega en dos
  campos distintos de WooCommerce con cobertura parcial y casos de
  discrepancia; falta definir la regla de negocio final (más allá del
  fallback técnico que se implemente).
- **Campos de agrupación del catálogo**: cómo se clasifican los artículos en
  las pantallas (por categoría, por tipo de corte, etc.).
- **Bilingüismo del sistema**: si la UI final es sólo catalán o
  catalán/castellano.

**El esquema de base de datos (capa de migraciones) no modela todavía nada
de esto a propósito**: `producte` no tiene columna de categoría/agrupación,
no existe ninguna tabla de descuentos, y aunque `transportista`/`tarifa`
existen como catálogos mínimos (`id`, `nom`), no hay ninguna regla de
asignación implementada — son referencias vacías a la espera de la
definición. Preferible una migración adicional después que columnas que
haya que rehacer.
