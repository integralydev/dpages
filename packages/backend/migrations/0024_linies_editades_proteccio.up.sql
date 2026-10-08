-- Tarea del 08/10/2026 (ADR-026): la sincronización de WooCommerce pisaba
-- las ediciones de Oficina en líneas de pedido (unitats_demanades,
-- preu_unitari, pesos) y marcaba esborrat una línea manual al re-procesar
-- un pedido con versión más nueva. `linies_editades_a` marca, en
-- comanda, el momento de la primera edición de línea hecha por Oficina
-- (POST/PATCH/DELETE .../linies) sobre un pedido con woo_order_id no nulo;
-- desde entonces el sync deja de tocar sus líneas (ver transformarComanda,
-- transform/comandes.ts). Aditiva: nullable, ninguna fila existente cambia.
ALTER TABLE comanda ADD COLUMN linies_editades_a TIMESTAMPTZ;
