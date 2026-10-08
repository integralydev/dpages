-- Reversión: se pierde la marca de qué pedidos tienen líneas protegidas de
-- la sincronización. No afecta ningún otro dato.
ALTER TABLE comanda DROP COLUMN linies_editades_a;
