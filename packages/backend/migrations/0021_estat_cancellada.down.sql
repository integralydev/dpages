-- Reversión: los pedidos cancelados vuelven a 'oberta' antes de restaurar el
-- CHECK de 4 valores (si no, el ADD CONSTRAINT falla). Se pierde la marca de
-- cancelación de esos pedidos: revisar a mano antes de revertir en un
-- entorno con datos reales.
UPDATE comanda SET estat = 'oberta' WHERE estat = 'cancellada';
ALTER TABLE comanda DROP CONSTRAINT comanda_estat_check;
ALTER TABLE comanda ADD CONSTRAINT comanda_estat_check
  CHECK (estat IN ('oberta', 'en_proces', 'tancada', 'amb_incidencia'));
