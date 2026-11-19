DROP TRIGGER IF EXISTS trg_comanda_calcul_per_pes ON comanda;
DROP FUNCTION IF EXISTS comanda_calcul_per_pes();
ALTER TABLE comanda DROP COLUMN IF EXISTS calcul_per_pes;
ALTER TABLE tarifa DROP COLUMN IF EXISTS calcul_per_pes;
