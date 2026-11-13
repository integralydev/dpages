-- Tasca 41 (Excel del client): nou Panell de Compres, la mateixa informació
-- que el Panell Empaquetat acumulada per client i també editable. És un
-- mòdul de permisos nou ('panell-compres').
--
-- Per defecte el rep tothom qui ja té 'panell-empaquetat': mateixes dades i
-- mateixa edició, només canvia la vista. Si algun rol no l'ha de veure, es
-- treu després des de la pantalla de rols (PATCH /rols/:id).
--
-- Idempotent, mateix criteri que 0020: només l'afegeix si encara no hi és.
UPDATE rol
SET moduls_permesos = array_append(moduls_permesos, 'panell-compres')
WHERE 'panell-empaquetat' = ANY (moduls_permesos)
  AND NOT ('panell-compres' = ANY (moduls_permesos));
