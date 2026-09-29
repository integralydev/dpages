-- Petición de Ari (29/09/2026): quinto estado de pedido, 'cancellada'. Un
-- pedido cancelado no se borra (conserva líneas, cliente y trazabilidad),
-- sólo deja de contar en los paneles — ver panells.ts. Aditiva: ninguna
-- fila existente cambia de valor.
ALTER TABLE comanda DROP CONSTRAINT comanda_estat_check;
ALTER TABLE comanda ADD CONSTRAINT comanda_estat_check
  CHECK (estat IN ('oberta', 'en_proces', 'tancada', 'amb_incidencia', 'cancellada'));
