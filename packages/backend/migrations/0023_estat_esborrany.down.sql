-- Reversió: les comandes en esborrany passen a 'oberta' abans de restaurar
-- el CHECK de 5 valors (si no, l'ADD CONSTRAINT fallaria). Es perd la marca
-- d'esborrany d'aquestes comandes.
UPDATE comanda SET estat = 'oberta' WHERE estat = 'esborrany';
ALTER TABLE comanda DROP CONSTRAINT comanda_estat_check;
ALTER TABLE comanda ADD CONSTRAINT comanda_estat_check
  CHECK (estat IN ('oberta', 'en_proces', 'tancada', 'amb_incidencia', 'cancellada'));
