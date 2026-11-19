'use client';

import { useCallback, useState, type CSSProperties } from 'react';

/**
 * Mesura l'alçada d'una barra fixa (sticky) de capçalera de pàgina i la
 * publica com a variable CSS `--alcada-barra-fixa` al contenidor de la
 * pàgina, perquè els elements fixos de més avall (p. ex. els títols de les
 * columnes de les línies d'una comanda) puguin quedar-se just a sota.
 *
 * L'alçada no és constant: els botons de la barra baixen de fila segons
 * l'amplada de la finestra, per això es torna a mesurar amb un
 * ResizeObserver cada vegada que la barra canvia de mida.
 *
 * Ús: `mesurar` (ref de callback) a la barra i `estil` al contenidor que la
 * conté. L'observador es crea i es desconnecta des del mateix ref de
 * callback (React 19 accepta que en retorni la neteja).
 */
export function useAlcadaBarraFixa() {
  const [alcada, setAlcada] = useState(0);

  const mesurar = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    // Primera mesura ara mateix, sense esperar el ResizeObserver (que només
    // avisa al següent fotograma): així els títols no comencen tapats.
    setAlcada(element.getBoundingClientRect().height);
    const observador = new ResizeObserver(() => {
      setAlcada(element.getBoundingClientRect().height);
    });
    observador.observe(element);
    return () => observador.disconnect();
  }, []);

  const estil = { '--alcada-barra-fixa': `${alcada}px` } as CSSProperties;
  return { mesurar, estil };
}
