-- Tasca 53 (full de l'Ari, 17/11/2026): «Núm. comanda WooCommerce» a la
-- capçalera de la comanda. A les comandes que arriben de WooCommerce és, per
-- defecte, el número de la comanda a la web (`number` de l'API); es pot
-- modificar, i el sync només l'escriu en crear la comanda (després és del
-- sistema, ADR de propietat de columnes). A les manuals, buit i editable.
-- Visible i cercable a Comandes, Oficina i Empaquetat.
ALTER TABLE comanda ADD COLUMN num_woo TEXT;

-- Les comandes de WooCommerce que ja hi són: el `number` del payload cru si
-- encara hi és a la taula d'aterratge; si no, l'id de la comanda a la web
-- (WooCommerce el fa servir com a número si no hi ha cap extensió de
-- numeració).
UPDATE comanda c
SET num_woo = COALESCE(
  (SELECT NULLIF(a.payload->>'number', '') FROM aterratge_woocommerce a
   WHERE a.recurs = 'orders' AND a.woo_id = c.woo_order_id),
  c.woo_order_id::text
)
WHERE c.woo_order_id IS NOT NULL;
