-- Hallazgo B1 (guard por módulo, verificado contra los 6 roles reales de
-- producción confirmados por Gerardo): la migración 0014 sembró
-- 'Administrador' con 12 módulos, SIN 'transportistes' — ese módulo se
-- agregó después a mano en los entornos reales vía RoleFormModal
-- (PATCH /rols/:id), nunca se actualizó la migración de origen. Un deploy
-- limpio desde cero (o cualquier esquema de test recién migrado) heredaría
-- un 'Administrador' incompleto, sin acceso de escritura a /transportistes
-- pese a ser el único rol real pensado para gestionarlo.
--
-- Idempotente por construcción: sólo agrega 'transportistes' si el array
-- todavía no lo tiene (`NOT 'transportistes' = ANY(moduls_permesos)`) — así
-- correr esta migración sobre un entorno donde ya se agregó a mano (como
-- producción) no lo duplica ni lo toca dos veces.
UPDATE rol
SET moduls_permesos = array_append(moduls_permesos, 'transportistes')
WHERE nom = 'Administrador'
  AND NOT ('transportistes' = ANY (moduls_permesos));
