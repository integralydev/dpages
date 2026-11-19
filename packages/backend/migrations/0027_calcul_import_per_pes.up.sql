-- Tasca 40 (full de l'Ari, confirmat pel client el 17/11/2026): l'import
-- d'una línia és pes × preu, excepte a les tarifes que van per unitats
-- (unitats × preu). Abans tot era unitats × preu.
--
-- 1) Cada tarifa diu com calcula, editable a la pantalla de Tarifes. Per
--    defecte, per pes; van per unitats la 01 (web, paquet), MO (Mengem
--    Osona), 08 (Botigues Solsona paquet) i SARG (Sargaire).
ALTER TABLE tarifa ADD COLUMN calcul_per_pes BOOLEAN NOT NULL DEFAULT true;
UPDATE tarifa SET calcul_per_pes = false WHERE codi IN ('01', 'MO', '08', 'SARG');

-- 2) Només a partir d'ara: cada comanda guarda amb quin càlcul es va crear.
--    Les que ja existeixen queden per unitats (default false) i els seus
--    imports no canvien. Una de nova pren el de la seva tarifa (sense
--    tarifa, per unitats) i, si li canvien la tarifa, també el càlcul.
--    Amb un trigger perquè valgui per a tots els camins que creen o
--    modifiquen comandes (API, duplicar, sync de WooCommerce).
ALTER TABLE comanda ADD COLUMN calcul_per_pes BOOLEAN NOT NULL DEFAULT false;

-- La tarifa que compta és la de la comanda; si no en té, la del client (és
-- la que POST /comandes fa servir per al preu quan no se n'indica cap). Les
-- comandes de WooCommerce sense tarifa no miren la del client: el seu preu
-- és el de la web, per unitats.
CREATE FUNCTION comanda_calcul_per_pes() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.tarifa_id IS DISTINCT FROM OLD.tarifa_id
     OR (NEW.tarifa_id IS NULL AND NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
    NEW.calcul_per_pes := COALESCE(
      (SELECT t.calcul_per_pes FROM tarifa t
       WHERE t.id = COALESCE(
         NEW.tarifa_id,
         CASE WHEN NEW.woo_order_id IS NULL
              THEN (SELECT cl.tarifa_id FROM client cl WHERE cl.id = NEW.client_id) END
       )),
      false
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_comanda_calcul_per_pes
  BEFORE INSERT OR UPDATE OF tarifa_id, client_id ON comanda
  FOR EACH ROW
  EXECUTE FUNCTION comanda_calcul_per_pes();
