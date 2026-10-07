import type {
  ClientApi,
  ComandaDetallApi,
  ComandaResumApi,
  FilaPanellObradorAcumulatApi,
  FilaPanellObradorApi,
  FilaPanellOficinaApi,
} from '@/lib/api';
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
  /** Text quan no hi ha cap filtre actiu. */
  senseFiltres?: string;
  /** Files (índex de `files`) en negreta i amb fons, p. ex. els acumulats. */
  filesDestacades?: Set<number>;
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
 * caràcters estranys. Es passa a l'equivalent ASCII. El símbol € sí que
 * hi és (codificació WinAnsi de jsPDF).
 */
function textPdf(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\u0000-ÿ€]/g, '?');
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
  senseFiltres = 'Filtres: cap (totes les comandes)',
  filesDestacades,
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
    filtres.length > 0 ? `Filtres: ${filtres.join(' · ')}` : senseFiltres,
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
      if (cell.section === 'body' && filesDestacades?.has(cell.row.index)) {
        cell.cell.styles.fontStyle = 'bold';
        cell.cell.styles.fillColor = [232, 232, 232];
        cell.cell.styles.textColor = CARBO;
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

// ── Panell Obrador: línies no fetes (tasca 27) ───────────────────────────

// 273 mm útils.
const COLUMNES_OBRADOR: ColumnaPdf[] = [
  { titol: 'Agrupació producció', ample: 30 },
  { titol: 'Producte', ample: 56, negreta: true },
  { titol: 'Envasat', ample: 25 },
  { titol: 'Format', ample: 18 },
  { titol: 'Client', ample: 40 },
  { titol: 'Data producció', ample: 22 },
  { titol: 'Unitats', ample: 18, alineacio: 'right' },
  { titol: 'Pes (kg)', ample: 20, alineacio: 'right' },
  { titol: 'Obs. producció', ample: 44 },
];

export function descarregarPdfObradorNoFetes({
  linies,
  filtres,
}: {
  linies: FilaPanellObradorApi[];
  filtres: string[];
}): Promise<void> {
  const kg = linies.reduce((total, linia) => total + Number(linia.kg), 0);
  const unitats = linies.reduce((total, linia) => total + Number(linia.unitats), 0);
  const nomLinies = linies.length === 1 ? 'línia' : 'línies';
  return descarregarPdfLlistat({
    titol: 'Obrador: línies no fetes',
    nomFitxer: 'obrador-no-fetes',
    columnes: COLUMNES_OBRADOR,
    resum: `${linies.length} ${nomLinies} · ${formatDecimal(kg.toFixed(3), 3)} kg · ${formatDecimal(unitats.toFixed(2), 2)} unitats`,
    filtres,
    senseFiltres: 'Filtres: cap (totes les línies no fetes)',
    // Ordenades per agrupació de producció i producte (les que no tenen
    // agrupació, al final).
    files: [...linies]
      .sort(
        (a, b) =>
          (a.agrupacioProduccio ?? '\uffff').localeCompare(
            b.agrupacioProduccio ?? '\uffff',
            'ca',
          ) || a.producte.descripcio.localeCompare(b.producte.descripcio, 'ca'),
      )
      .map((linia) => [
        linia.agrupacioProduccio ?? '-',
        linia.producte.descripcio,
        linia.envasat ?? '-',
        linia.format ?? '-',
        linia.client ?? '-',
        dataOGuio(linia.dataProduccio),
        formatDecimal(linia.unitats, 2),
        formatDecimal(linia.kg, 3),
        linia.obsProduccio ?? '',
      ]),
  });
}

// ── Panell Obrador tal com es veu (tasca 30) ─────────────────────────────

// 273 mm útils. Les files de producte només omplen agrupació, producte,
// unitats i pes; les de línia, la resta.
const COLUMNES_OBRADOR_PANTALLA: ColumnaPdf[] = [
  { titol: 'Agrupació producció', ample: 30 },
  { titol: 'Producte', ample: 56 },
  { titol: 'Envasat', ample: 24 },
  { titol: 'Format', ample: 18 },
  { titol: 'Client', ample: 38 },
  { titol: 'Data producció', ample: 22 },
  { titol: 'Unitats', ample: 18, alineacio: 'right' },
  { titol: 'Pes (kg)', ample: 20, alineacio: 'right' },
  { titol: 'Fet', ample: 12, alineacio: 'center' },
  { titol: 'Obs. producció', ample: 35 },
];

/**
 * El Panell Obrador desplegat sencer: una fila per producte amb els
 * acumulats i, a sota, totes les seves línies que compleixen els filtres.
 */
export function descarregarPdfObradorPantalla({
  grups,
  liniesPerProducte,
  totals,
  filtres,
}: {
  grups: FilaPanellObradorAcumulatApi[];
  liniesPerProducte: Map<number, FilaPanellObradorApi[]>;
  totals: { linies: number; totalKg: string; totalUnitats: string };
  filtres: string[];
}): Promise<void> {
  const files: string[][] = [];
  const destacades = new Set<number>();
  for (const grup of grups) {
    destacades.add(files.length);
    files.push([
      grup.agrupacioProduccio ?? '-',
      `${grup.producte.descripcio} (${grup.linies} ${grup.linies === 1 ? 'línia' : 'línies'})`,
      '',
      '',
      '',
      '',
      formatDecimal(grup.unitats, 2),
      formatDecimal(grup.kg, 3),
      `${grup.liniesFetes}/${grup.linies}`,
      '',
    ]);
    for (const linia of liniesPerProducte.get(grup.producte.id) ?? []) {
      files.push([
        '',
        '',
        linia.envasat ?? '-',
        linia.format ?? '-',
        linia.client ?? '-',
        dataOGuio(linia.dataProduccio),
        formatDecimal(linia.unitats, 2),
        formatDecimal(linia.kg, 3),
        linia.treballatA ? 'Sí' : '',
        linia.obsProduccio ?? '',
      ]);
    }
  }
  const nomProductes = grups.length === 1 ? 'producte' : 'productes';
  const nomLinies = totals.linies === 1 ? 'línia' : 'línies';
  return descarregarPdfLlistat({
    titol: "Panell d'Obrador",
    nomFitxer: 'panell-obrador',
    columnes: COLUMNES_OBRADOR_PANTALLA,
    resum: `${grups.length} ${nomProductes} · ${totals.linies} ${nomLinies} · ${formatDecimal(totals.totalKg, 3)} kg · ${formatDecimal(totals.totalUnitats, 2)} unitats`,
    filtres,
    senseFiltres: 'Filtres: cap (totes les línies)',
    filesDestacades: destacades,
    files,
  });
}

// ── Detall de comanda (tasca 13) ─────────────────────────────────────────

/**
 * Una o més comandes, cadascuna començant en pàgina nova (A4 vertical),
 * amb un format semblant al correu de comanda de WooCommerce: capçalera
 * amb el logotip, número i data, client i lliurament, taula de productes
 * i totals. El client complet (NIF, telèfon, email) surt de `clients`;
 * si no hi és, només el nom que porta la comanda.
 */
export async function descarregarPdfComandes({
  comandes,
  clients,
  originLabel,
}: {
  comandes: ComandaDetallApi[];
  clients: Map<number, ClientApi>;
  originLabel: (codi: string) => string;
}): Promise<void> {
  const [{ jsPDF }, { autoTable }, logo] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    carregarLogo(),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ample = doc.internal.pageSize.getWidth();
  const alt = doc.internal.pageSize.getHeight();
  const util = ample - 2 * MARGE;
  // Per al peu: a quina comanda pertany cada pàgina.
  const trams: { num: string; primera: number; darrera: number }[] = [];

  comandes.forEach((comanda, index) => {
    if (index > 0) doc.addPage();
    const primera = doc.getNumberOfPages();

    // Franja grafit amb el logotip, com el correu de la web.
    doc.setFillColor(...GRAFIT);
    doc.rect(0, 0, ample, 22, 'F');
    if (logo) doc.addImage(logo, 'PNG', MARGE, 6, 10 * LOGO_RATIO, 10);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text('Comanda', ample - MARGE, 13.5, { align: 'right' });

    doc.setTextColor(...CARBO);
    doc.setFontSize(14);
    doc.text(textPdf(`Comanda ${comanda.num}`), MARGE, 33);
    doc.text(formatData(comanda.dataComanda, false), ample - MARGE, 33, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRIS_TEXT);
    const estat = ESTAT_LABELS[comanda.estat] ?? comanda.estat;
    doc.text(
      textPdf(
        [
          `Origen: ${originLabel(comanda.origen)}`,
          `Estat: ${estat}`,
          comanda.tarifa && `Tarifa: ${comanda.tarifa.nom}`,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      MARGE,
      39,
    );

    // Dues columnes: client i lliurament.
    const client = comanda.client ? clients.get(comanda.client.id) : undefined;
    const liniesClient = [
      comanda.client?.nom ?? 'Sense client',
      client?.nif && `NIF: ${client.nif}`,
      client?.telefon && `Telèfon: ${client.telefon}`,
      client?.email,
      (client?.poblacio ?? comanda.client?.poblacio) || null,
    ].filter((linia): linia is string => Boolean(linia));
    const liniesLliurament = [
      comanda.adrecaLliurament,
      comanda.poblacioDesti,
      comanda.transportista && `Transportista: ${comanda.transportista.nom}`,
      comanda.dataLliurament && `Data lliurament: ${formatData(comanda.dataLliurament, false)}`,
      comanda.dataProduccio && `Data producció: ${formatData(comanda.dataProduccio, false)}`,
      comanda.bultos !== null && `Bultos: ${comanda.bultos}`,
    ].filter((linia): linia is string => Boolean(linia));
    if (liniesLliurament.length === 0) liniesLliurament.push('-');

    const ampleColumna = util / 2 - 4;
    const columnaClient = doc.splitTextToSize(
      textPdf(liniesClient.join('\n')),
      ampleColumna,
    ) as string[];
    const columnaLliurament = doc.splitTextToSize(
      textPdf(liniesLliurament.join('\n')),
      ampleColumna,
    ) as string[];

    let y = 49;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...GRIS_TEXT);
    doc.text('Client', MARGE, y);
    doc.text('Lliurament', MARGE + util / 2, y);
    doc.setDrawColor(220, 220, 220);
    doc.line(MARGE, y + 2, ample - MARGE, y + 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(51, 51, 51);
    doc.text(columnaClient, MARGE, y + 7);
    doc.text(columnaLliurament, MARGE + util / 2, y + 7);
    y += 7 + Math.max(columnaClient.length, columnaLliurament.length) * 4.6;

    for (const [titol, valor] of [
      ['Obs. lliurament', comanda.obsLliurament],
      ['Obs. producció', comanda.obsProduccio],
    ] as const) {
      if (!valor?.trim()) continue;
      const text = doc.splitTextToSize(textPdf(`${titol}: ${valor.trim()}`), util) as string[];
      doc.text(text, MARGE, y);
      y += text.length * 4.6;
    }

    const linies = comanda.linies.filter((linia) => !linia.esborrat);
    autoTable(doc, {
      startY: y + 3,
      margin: { top: MARGE, right: MARGE, bottom: 14, left: MARGE },
      head: [['Producte', 'Unitats', 'Kg', 'Preu', 'Import']],
      body: linies.map((linia) => {
        const producte = linia.producte
          ? `${linia.producte.descripcio}${linia.producte.codi ? ` (#${linia.producte.codi})` : ''}`
          : 'Article no resolt';
        const notes = [
          linia.obsProduccio && `Obs. producció: ${linia.obsProduccio}`,
          linia.obsEmpaquetat && `Obs. empaquetat: ${linia.obsEmpaquetat}`,
        ].filter(Boolean);
        return [
          [producte, ...notes].join('\n'),
          formatUnitats(linia.unitatsDemanades),
          formatDecimal(linia.kgDemanats, 3),
          `${formatDecimal(linia.preuUnitari, 2)} €`,
          `${formatDecimal(linia.totalLinia, 2)} €`,
        ].map(textPdf);
      }),
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: {
        font: 'helvetica',
        fontSize: 9.5,
        cellPadding: 2.5,
        textColor: [51, 51, 51],
        lineColor: [210, 210, 210],
        overflow: 'linebreak',
        valign: 'middle',
      },
      headStyles: { fillColor: GRIS_FONS, textColor: CARBO, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 96 },
        1: { cellWidth: 20, halign: 'right' },
        2: { cellWidth: 22, halign: 'right' },
        3: { cellWidth: 22, halign: 'right' },
        4: { cellWidth: util - 160, halign: 'right' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'head' && cell.column.index > 0) cell.cell.styles.halign = 'right';
      },
    });

    // Totals a la dreta, sota la taula (com Subtotal/Total del correu).
    const finalTaula = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY;
    let yTotals = finalTaula + 3;
    if (yTotals + 18 > alt - 14) {
      doc.addPage();
      yTotals = MARGE;
    }
    autoTable(doc, {
      startY: yTotals,
      margin: { left: ample - MARGE - 80, right: MARGE },
      body: [
        ['Total kg', formatDecimal(comanda.totalKg, 3)],
        ['Total', `${formatDecimal(comanda.totalEur, 2)} €`],
      ],
      theme: 'grid',
      styles: {
        font: 'helvetica',
        fontSize: 10,
        cellPadding: 2.5,
        textColor: [51, 51, 51],
        lineColor: [210, 210, 210],
      },
      columnStyles: {
        0: { cellWidth: 40, fontStyle: 'bold' },
        1: { cellWidth: 40, halign: 'right' },
      },
    });

    trams.push({ num: comanda.num, primera, darrera: doc.getNumberOfPages() });
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRIS_TEXT);
  for (const tram of trams) {
    const total = tram.darrera - tram.primera + 1;
    for (let pagina = tram.primera; pagina <= tram.darrera; pagina++) {
      doc.setPage(pagina);
      doc.text(textPdf(`dpagès · Comanda ${tram.num}`), MARGE, alt - 7);
      doc.text(`Pàgina ${pagina - tram.primera + 1} de ${total}`, ample - MARGE, alt - 7, {
        align: 'right',
      });
    }
  }

  const nomFitxer =
    comandes.length === 1
      ? `comanda-${comandes[0]!.num}`
      : `comandes-${new Date().toISOString().slice(0, 10)}`;
  doc.save(`${nomFitxer}.pdf`);
}

/** Unitats sense decimals quan són enteres (3, no 3,00). */
function formatUnitats(unitats: string): string {
  return Number.isInteger(Number(unitats)) ? String(Number(unitats)) : formatDecimal(unitats, 2);
}
