-- Reversió manual (el runner només executa *.up.sql): treu 'panell-compres'
-- de tots els rols. array_remove no falla si el valor no hi és.
UPDATE rol
SET moduls_permesos = array_remove(moduls_permesos, 'panell-compres');
