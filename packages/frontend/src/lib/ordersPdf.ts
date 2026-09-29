import type { ComandaResumApi } from '@/lib/api';
import { ESTAT_LABELS } from '@/lib/comandaEstat';
import { formatData } from '@/lib/dates';

/**
 * Llistat de comandes en PDF, A4 apaisat (petició del client, 29/09/2026):
 * les mateixes columnes que la taula de Comandes (menys "Accions"), amb les
 * comandes que surten amb els filtres actius — totes, no només la pàgina
 * visible. Es genera al navegador i es descarrega directament; jsPDF es
 * carrega només en prémer el botó, no forma part del bundle de la pàgina.
 */

type Opcions = {
  comandes: ComandaResumApi[];
  /** Resum llegible dels filtres actius ("Estat: Oberta"...); buit = cap. */
  filtres: string[];
  originLabel: (codi: string) => string;
};

// Colors de la identitat de dpages.cat (globals.css).
const GRAFIT: [number, number, number] = [79, 79, 79];
const CARBO: [number, number, number] = [41, 42, 48];
const GRIS_FONS: [number, number, number] = [248, 248, 248];
const GRIS_TEXT: [number, number, number] = [109, 109, 109];

const MARGE = 12; // mm
const LOGO_URL = '/brand/dpages-logotip.png';
const LOGO_RATIO = 313 / 112; // amplada/alçada del PNG

/**
 * Helvetica (la font estàndard de jsPDF) només cobreix Latin-1: el català
 * hi cap sencer (à, ç, ï, ·...), però la tipografia "intel·ligent" que pot
 * portar un nom de client o de tarifa (’ “ ” – …) sortiria com a
 * caràcters estranys. Es passa a l'equivalent ASCII.
 */
function textPdf(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\u0000-ÿ]/g, '?');
}

async function carregarLogo(): Promise<string | null> {
  try {
    const resposta = await fetch(LOGO_URL);
    if (!resposta.ok) return null;
    const blob = await resposta.blob();
    return await new Promise((resolve) => {
      const lector = new FileReader();
      lector.onload = () => resolve(typeof lector.result === 'string' ? lector.result : null);
      lector.onerror = () => resolve(null);
      lector.readAsDataURL(blob);
    });
  } catch {
    // Sense logo el llistat segueix sent útil: no es bloqueja per això.
    return null;
  }
}

function fila(comanda: ComandaResumApi, originLabel: (codi: string) => string): string[] {
  const estat = ESTAT_LABELS[comanda.estat] ?? comanda.estat;
  return [
    comanda.num,
    comanda.client?.nom ?? '-',
    originLabel(comanda.origen),
    comanda.tarifa?.nom ?? '-',
    formatData(comanda.dataComanda, false),
    comanda.datesProduccioLinies.map((data) => formatData(data, false)).join(', ') || '-',
    comanda.dataLliurament ? formatData(comanda.dataLliurament, false) : '-',
    comanda.transportista?.nom ?? '-',
    comanda.bultos !== null ? String(comanda.bultos) : '-',
    comanda.congelada ? `${estat} · Congelada` : estat,
  ].map(textPdf);
}

export async function descarregarPdfLlistatComandes({
  comandes,
  filtres,
  originLabel,
}: Opcions): Promise<void> {
  const [{ jsPDF }, { autoTable }, logo] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    carregarLogo(),
  ]);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const ample = doc.internal.pageSize.getWidth();
  const alt = doc.internal.pageSize.getHeight();
  const ara = new Date();

  // Capçalera (només a la primera pàgina): franja grafit amb el logotip,
  // com la web del client.
  doc.setFillColor(...GRAFIT);
  doc.rect(0, 0, ample, 22, 'F');
  if (logo) doc.addImage(logo, 'PNG', MARGE, 6, 10 * LOGO_RATIO, 10);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Llistat de comandes', ample - MARGE, 13.5, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...GRIS_TEXT);
  const resum = `${comandes.length} ${comandes.length === 1 ? 'comanda' : 'comandes'} · Generat el ${formatData(ara.toISOString(), true)}`;
  doc.text(textPdf(resum), MARGE, 29);
  const liniaFiltres = textPdf(
    filtres.length > 0 ? `Filtres: ${filtres.join(' · ')}` : 'Filtres: cap (totes les comandes)',
  );
  const filtresPartits = doc.splitTextToSize(liniaFiltres, ample - 2 * MARGE) as string[];
  doc.text(filtresPartits, MARGE, 34);

  autoTable(doc, {
    startY: 34 + filtresPartits.length * 4 + 2,
    margin: { top: MARGE, right: MARGE, bottom: 14, left: MARGE },
    head: [
      [
        'Núm.',
        'Client',
        'Origen',
        'Tarifa',
        'Data comanda',
        'Data producció',
        'Data lliurament',
        'Transportista',
        'Bultos',
        'Estat',
      ],
    ],
    body: comandes.map((comanda) => fila(comanda, originLabel)),
    theme: 'striped',
    // Una comanda mai es parteix entre dues pàgines.
    rowPageBreak: 'avoid',
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      cellPadding: 2,
      textColor: [51, 51, 51],
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: { fillColor: CARBO, textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: GRIS_FONS },
    // 273 mm útils (297 - 2 × 12): Tarifa i Client, els textos més llargs,
    // són les columnes que més creixen respecte de la pantalla.
    columnStyles: {
      0: { cellWidth: 20, fontStyle: 'bold' },
      1: { cellWidth: 42 },
      2: { cellWidth: 22 },
      3: { cellWidth: 46 },
      4: { cellWidth: 21 },
      5: { cellWidth: 27 },
      6: { cellWidth: 21 },
      7: { cellWidth: 30 },
      8: { cellWidth: 13, halign: 'right' },
      9: { cellWidth: 31 },
    },
    // columnStyles només s'aplica al cos: la capçalera de Bultos s'alinea
    // a mà amb els números de sota.
    didParseCell: (cell) => {
      if (cell.section === 'head' && cell.column.index === 8) cell.cell.styles.halign = 'right';
    },
  });

  // Peu de pàgina un cop feta la taula, quan ja se sap el total de pàgines.
  const totalPagines = doc.getNumberOfPages();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRIS_TEXT);
  for (let pagina = 1; pagina <= totalPagines; pagina++) {
    doc.setPage(pagina);
    doc.text('dpagès · Gestió de comandes', MARGE, alt - 7);
    doc.text(`Pàgina ${pagina} de ${totalPagines}`, ample - MARGE, alt - 7, { align: 'right' });
  }

  const data = ara.toISOString().slice(0, 10);
  doc.save(`llistat-comandes-${data}.pdf`);
}
