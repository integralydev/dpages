import type { Pool } from 'pg';

/**
 * Tarea 16 (03/10/2026): cuando Empaquetat confirma la última línia activa
 * de una comanda, la comanda pasa sola a `tancada`. Sólo desde `oberta` o
 * `en_proces`: una cancelada, en esborrany o con incidencia no se toca.
 *
 * Una sola sentencia sobre las líneas de esa comanda (índice por
 * comanda_id, ~8 líneas): coste despreciable en cada confirmación. Sin
 * transacción a propósito: se ejecuta después de que la confirmación ya
 * está grabada, así que de dos confirmaciones simultáneas la última siempre
 * ve las dos.
 */
export async function tancarSiTotLliurat(dbPool: Pool, comandaUuid: string): Promise<void> {
  await dbPool.query(
    `UPDATE comanda c SET estat = 'tancada'
     WHERE c.id = $1
       AND c.estat IN ('oberta', 'en_proces')
       AND EXISTS (SELECT 1 FROM comanda_linia cl WHERE cl.comanda_id = c.id AND NOT cl.esborrat)
       AND NOT EXISTS (
         SELECT 1 FROM comanda_linia cl
         WHERE cl.comanda_id = c.id AND NOT cl.esborrat AND cl.confirmat_a IS NULL
       )`,
    [comandaUuid],
  );
}

/**
 * Contrapartida de `tancarSiTotLliurat`: si se deshace la confirmación de
 * una línea de una comanda `tancada`, ya no está todo entregado y vuelve a
 * `oberta`.
 */
export async function reobrirSiTancada(dbPool: Pool, comandaUuid: string): Promise<void> {
  await dbPool.query(`UPDATE comanda SET estat = 'oberta' WHERE id = $1 AND estat = 'tancada'`, [
    comandaUuid,
  ]);
}
