-- Si alguna transacció llarga té la taula bloquejada, millor fallar ràpid
-- que deixar en cua les lectures de client.
SET LOCAL lock_timeout = '5s';

-- Punt 35 (reformulat amb el client, 18/11/2026): tipus de client, per
-- filtrar les comandes dels clients fixos o dels esporàdics a Comandes.
--
-- Text amb CHECK i no un ENUM ni una taula: de moment només hi ha dos
-- valors; afegir-ne un altre és canviar el CHECK en una migració nova.
-- Tots els clients, els existents i els nous (alta manual o del sync de
-- WooCommerce), comencen com a 'esporadic' (decisió de Francesc): oficina
-- només ha de marcar els fixos.
ALTER TABLE client
  ADD COLUMN tipus TEXT NOT NULL DEFAULT 'esporadic'
  CONSTRAINT client_tipus_valid CHECK (tipus IN ('fix', 'esporadic'));
