-- Reversión SIMPLE: sacar 'transportistes' del array — el runner (migrate.ts)
-- sólo lee *.up.sql (no ejecuta *.down.sql automáticamente, ver comando
-- "status"/"up" en db/migrate.ts); este archivo es la referencia manual para
-- revertir, mismo criterio que el resto de migraciones del proyecto.
-- array_remove no falla si el valor no está presente — reversión segura
-- incluso si 'transportistes' ya no estuviera en el array por otro motivo.
UPDATE rol
SET moduls_permesos = array_remove(moduls_permesos, 'transportistes')
WHERE nom = 'Administrador';
