-- Punt 55 (reformulat amb el client, 18/11/2026): proveïdors.
--
-- - Taula `proveidor`, de moment només amb el nom (únic, sense distingir
--   majúscules). Es pot esborrar del tot, però només si cap article ni cap
--   línia de comanda no el fa servir (les FK són RESTRICT): així mai es
--   perd en silenci el proveïdor d'una comanda.
-- - `producte.proveidor_defecte_id`: el «proveïdor preferit» de l'article,
--   opcional.
-- - `comanda_linia.proveidor_id`: el proveïdor de la línia, opcional. En
--   triar l'article s'hi posa el preferit i es pot canviar; el sync de
--   WooCommerce també l'hi posa en crear la línia, i després ja no el toca.
-- - Mòdul de permisos 'proveidors', per a tots els rols que ja tenen
--   'tarifes-clients' (el manteniment va al costat de Fitxes de clients).

SET LOCAL lock_timeout = '5s';

CREATE TABLE proveidor (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_seq  BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  nom     TEXT NOT NULL CHECK (btrim(nom) <> ''),
  creat_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_proveidor_nom ON proveidor (lower(nom));

ALTER TABLE producte
  ADD COLUMN proveidor_defecte_id UUID REFERENCES proveidor (id) ON DELETE RESTRICT;
CREATE INDEX idx_producte_proveidor_defecte ON producte (proveidor_defecte_id);

ALTER TABLE comanda_linia
  ADD COLUMN proveidor_id UUID REFERENCES proveidor (id) ON DELETE RESTRICT;
CREATE INDEX idx_comanda_linia_proveidor ON comanda_linia (proveidor_id);

UPDATE rol
SET moduls_permesos = array_append(moduls_permesos, 'proveidors')
WHERE 'tarifes-clients' = ANY (moduls_permesos)
  AND NOT ('proveidors' = ANY (moduls_permesos));
