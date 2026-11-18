-- Reversió manual (el runner només executa *.up.sql).
UPDATE rol SET moduls_permesos = array_remove(moduls_permesos, 'proveidors');
ALTER TABLE comanda_linia DROP COLUMN proveidor_id;
ALTER TABLE producte DROP COLUMN proveidor_defecte_id;
DROP TABLE proveidor;
