import type { ComandaResumApi, FilaPanellOficinaApi } from '@/lib/api';
import { ESTAT_LABELS } from '@/lib/comandaEstat';
import { formatData } from '@/lib/dates';
import { formatDecimal } from '@/lib/decimals';

/**
 * Llistats de comandes en PDF, A4 apaisat (petició del client, 29/09/2026):
 * a Comandes i al Panell Oficina, amb les mateixes columnes que la taula de
 * cada pantalla i TOTES les comandes que surten amb els filtres actius, no
 * només la pàgina visible. Es genera al navegador i es descarrega
 * directament; jsPDF es carrega només en prémer el botó, no forma part del
 * bundle de la pàgina.
 */

type ColumnaPdf = {
  titol: string;
  /** mm. Entre totes han de sumar 273 (297 - 2 × MARGE). */
  ample: number;
  alineacio?: 'left' | 'center' | 'right';
  negreta?: boolean;
};

type OpcionsLlistat = {
  titol: string;
  nomFitxer: string;
  columnes: ColumnaPdf[];
  files: string[][];
  /** Línia de resum sota la capçalera (s'hi afegeix la data de generació). */
  resum: string;
  /** Resum llegible dels filtres actius ("Estat: Oberta"...); buit = cap. */
  filtres: string[];
  midaLletra?: number;
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

function comptarComandes(total: number): string {
  return `${total} ${total === 1 ? 'comanda' : 'comandes'}`;
}

async function descarregarPdfLlistat({
  titol,
  nomFitxer,
  columnes,
  files,
  resum,
  filtres,
  midaLletra = 8.5,
}: OpcionsLlistat): Promise<void> {
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
  doc.text(textPdf(titol), ample - MARGE, 13.5, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...GRIS_TEXT);
  doc.text(textPdf(`${resum} · Generat el ${formatData(ara.toISOString(), true)}`), MARGE, 29);
  const liniaFiltres = textPdf(
    filtres.length > 0 ? `Filtres: ${filtres.join(' · ')}` : 'Filtres: cap (totes les comandes)',
  );
  const filtresPartits = doc.splitTextToSize(liniaFiltres, ample - 2 * MARGE) as string[];
  doc.text(filtresPartits, MARGE, 34);

  autoTable(doc, {
    startY: 34 + filtresPartits.length * 4 + 2,
    margin: { top: MARGE, right: MARGE, bottom: 14, left: MARGE },
    head: [columnes.map((columna) => columna.titol)],
    body: files.map((fila) => fila.map(textPdf)),
    theme: 'striped',
    // Una comanda mai es parteix entre dues pàgines.
    rowPageBreak: 'avoid',
    styles: {
      font: 'helvetica',
      fontSize: midaLletra,
      cellPadding: 2,
      textColor: [51, 51, 51],
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: { fillColor: CARBO, textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: GRIS_FONS },
    columnStyles: Object.fromEntries(
      columnes.map((columna, index) => [
        index,
        {
          cellWidth: columna.ample,
          halign: columna.alineacio ?? 'left',
          ...(columna.negreta ? { fontStyle: 'bold' as const } : {}),
        },
      ]),
    ),
    // columnStyles només s'aplica al cos: la capçalera s'alinea a mà amb
    // els valors de sota (xifres a la dreta, caselles al centre).
    didParseCell: (cell) => {
      if (cell.section === 'head') {
        cell.cell.styles.halign = columnes[cell.column.index]?.alineacio ?? 'left';
      }
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

  doc.save(`${nomFitxer}-${ara.toISOString().slice(0, 10)}.pdf`);
}

function dataOGuio(data: string | null): string {
  return data ? formatData(data, false) : '-';
}

// ── Comandes ─────────────────────────────────────────────────────────────

// 273 mm útils: Tarifa i Client, els textos més llargs, són les columnes
// que més creixen respecte de la pantalla.
const COLUMNES_COMANDES: ColumnaPdf[] = [
  { titol: 'Núm.', ample: 20, negreta: true },
  { titol: 'Client', ample: 42 },
  { titol: 'Origen', ample: 22 },
  { titol: 'Tarifa', ample: 46 },
  { titol: 'Data comanda', ample: 21 },
  { titol: 'Data producció', ample: 27 },
  { titol: 'Data lliurament', ample: 21 },
  { titol: 'Transportista', ample: 30 },
  { titol: 'Bultos', ample: 13, alineacio: 'right' },
  { titol: 'Estat', ample: 31 },
];

export function descarregarPdfLlistatComandes({
  comandes,
  filtres,
  originLabel,
}: {
  comandes: ComandaResumApi[];
  filtres: string[];
  originLabel: (codi: string) => string;
}): Promise<void> {
  return descarregarPdfLlistat({
    titol: 'Llistat de comandes',
    nomFitxer: 'llistat-comandes',
    columnes: COLUMNES_COMANDES,
    resum: comptarComandes(comandes.length),
    filtres,
    files: comandes.map((comanda) => {
      const estat = ESTAT_LABELS[comanda.estat] ?? comanda.estat;
      return [
        comanda.num,
        comanda.client?.nom ?? '-',
        originLabel(comanda.origen),
        comanda.tarifa?.nom ?? '-',
        formatData(comanda.dataComanda, false),
        comanda.datesProduccioLinies.map((data) => formatData(data, false)).join(', ') || '-',
        dataOGuio(comanda.dataLliurament),
        comanda.transportista?.nom ?? '-',
        comanda.bultos !== null ? String(comanda.bultos) : '-',
        comanda.congelada ? `${estat} · Congelada` : estat,
      ];
    }),
  });
}

// ── Panell Oficina ───────────────────────────────────────────────────────

// Les 13 columnes de la taula del panell, 273 mm útils. Les dues caselles
// d'observacions surten com a "Sí" / "-".
const COLUMNES_OFICINA: ColumnaPdf[] = [
  { titol: 'Núm.', ample: 16, negreta: true },
  { titol: 'Client', ample: 30 },
  { titol: 'Població de destí', ample: 24 },
  { titol: 'Tarifa', ample: 36 },
  { titol: 'Transportista', ample: 22 },
  { titol: 'Estat', ample: 18 },
  { titol: 'Data comanda', ample: 18 },
  { titol: 'Data expedició', ample: 18 },
  { titol: 'Data lliurament', ample: 18 },
  { titol: 'Total kg demanats', ample: 20, alineacio: 'right' },
  { titol: 'Núm. bultos', ample: 13, alineacio: 'right' },
  { titol: 'Obs. producció', ample: 20, alineacio: 'center' },
  { titol: 'Obs. lliurament', ample: 20, alineacio: 'center' },
];

export function descarregarPdfPanellOficina({
  comandes,
  totalKg,
  filtres,
}: {
  comandes: FilaPanellOficinaApi[];
  /** `totals.totalKg` del panell (string NUMERIC), per al resum. */
  totalKg: string | null;
  filtres: string[];
}): Promise<void> {
  const resumKg = totalKg !== null ? ` · ${formatDecimal(totalKg, 3)} kg demanats` : '';
  return descarregarPdfLlistat({
    titol: "Panell d'Oficina",
    nomFitxer: 'panell-oficina',
    columnes: COLUMNES_OFICINA,
    resum: `${comptarComandes(comandes.length)}${resumKg}`,
    filtres,
    midaLletra: 8,
    files: comandes.map((comanda) => [
      comanda.num,
      comanda.client ?? '-',
      comanda.poblacioDesti || '-',
      comanda.tarifa ?? '-',
      comanda.transportista ?? '-',
      ESTAT_LABELS[comanda.estat] ?? comanda.estat,
      formatData(comanda.dataComanda, false),
      dataOGuio(comanda.dataExpedicio),
      dataOGuio(comanda.dataLliurament),
      formatDecimal(comanda.totalKg, 3),
      comanda.bultos !== null ? String(comanda.bultos) : '-',
      comanda.obsProduccio ? 'Sí' : '-',
      (comanda.obsLliurament ?? '').trim().length > 0 ? 'Sí' : '-',
    ]),
  });
}
