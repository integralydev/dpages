-- Tasca 7 (01/10/2026): observacions d'empaquetat a nivell de LÍNIA de
-- comanda (p. ex. "unitat familiar X" per a cooperatives que demanen els
-- paquets separats). Es demana a l'entrada de comandes i es mostra al
-- Panell Empaquetat, on també s'hi pot filtrar (tasca 23). Aditiva:
-- nullable, cap fila existent canvia.
ALTER TABLE comanda_linia ADD COLUMN obs_empaquetat TEXT;
