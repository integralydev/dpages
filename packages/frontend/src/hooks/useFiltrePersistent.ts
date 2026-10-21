'use client';

import { useCallback, useState } from 'react';

/**
 * Tasca 36 (Ari, 20/10/2026): filtres "estàtics" a Oficina i Comandes. Si
 * es filtra (p. ex. per transportista), s'entra a una comanda i es torna
 * enrere, el filtre ha de seguir aplicat. Cada filtre es desa a
 * sessionStorage: dura mentre la pestanya és oberta (no entre sessions de
 * navegador) i `esborrarFiltresPersistents()` el neteja en tancar sessió.
 *
 * Llegir a l'inicialitzador és segur: les pantalles privades no es
 * renderitzen al servidor (AuthGuard no pinta res fins que l'auth del
 * client ha carregat), així que no hi ha desajust d'hidratació.
 */
const PREFIX = 'dpages.filtres.';

function llegir<T>(clau: string, inicial: T): T {
  if (typeof window === 'undefined') return inicial;
  try {
    const valor = window.sessionStorage.getItem(PREFIX + clau);
    return valor === null ? inicial : (JSON.parse(valor) as T);
  } catch {
    return inicial;
  }
}

export function useFiltrePersistent<T>(clau: string, inicial: T): [T, (valor: T) => void] {
  const [valor, setValorEstat] = useState<T>(() => llegir(clau, inicial));

  const setValor = useCallback(
    (nou: T) => {
      setValorEstat(nou);
      try {
        window.sessionStorage.setItem(PREFIX + clau, JSON.stringify(nou));
      } catch {
        // Sense sessionStorage (mode privat estricte): el filtre només no es recorda.
      }
    },
    [clau],
  );

  return [valor, setValor];
}

/** Treu tots els filtres desats (en tancar sessió). */
export function esborrarFiltresPersistents(): void {
  try {
    const claus = Object.keys(window.sessionStorage).filter((clau) => clau.startsWith(PREFIX));
    for (const clau of claus) window.sessionStorage.removeItem(clau);
  } catch {
    // Res a netejar si no hi ha sessionStorage.
  }
}
