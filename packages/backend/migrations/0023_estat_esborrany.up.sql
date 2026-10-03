-- Tasques 33 i 38 (03/10/2026): sisè estat de comanda, 'esborrany' —
-- comanda pendent de revisar. És l'estat amb què entren les comandes de
-- WooCommerce. No compta als panells d'Obrador ni Empaquetat; sí a Oficina
-- i Producció (ver panells.ts). Additiva: cap fila existent canvia.
ALTER TABLE comanda DROP CONSTRAINT comanda_estat_check;
ALTER TABLE comanda ADD CONSTRAINT comanda_estat_check
  CHECK (estat IN ('esborrany', 'oberta', 'en_proces', 'tancada', 'amb_incidencia', 'cancellada'));
