/**
 * XLSX parsing + template generation (server-side).
 *
 * Security (vibesec file-upload guidance):
 *   - Validate file size BEFORE parse (10 MB hard cap).
 *   - Validate MIME type AND magic bytes (XLSX files start with `PK\3\4`
 *     because XLSX = ZIP of XML).
 *   - Disable SheetJS features that load XML entities or VBA macros
 *     (cellFormula, cellHTML, bookVBA all false).
 *   - Never use the uploaded filename for any path; generate new UUIDs
 *     if needed. We don't persist the file at all — parse in memory.
 *
 * Parsing strategy: we anchor on category labels (Portuguese strings)
 * in column A. The template ships these labels; if the user messes with
 * them, we silently skip unrecognized rows rather than erroring out.
 */
import * as XLSX from 'xlsx';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * ZIP magic bytes (PK\3\4). XLSX is always a ZIP archive — any file that
 * doesn't start with these 4 bytes can't be a valid xlsx.
 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export class XlsxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxValidationError';
  }
}

export function validateBuffer(buf: Buffer): void {
  if (buf.length === 0) {
    throw new XlsxValidationError('Arquivo vazio');
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new XlsxValidationError('Arquivo maior que 10 MB');
  }
  if (buf.length < 4 || !buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new XlsxValidationError('Formato inválido — envie um arquivo .xlsx');
  }
}

/**
 * Labels we recognize in uploaded xlsx files. Both ASCII and accented
 * variants are present so users can paste from anywhere. The route layer
 * resolves these labels to PeriodCategory.id by matching against the
 * period's current label list.
 */
const KNOWN_LABELS = new Set<string>([
  'Receita de Vendas',
  'Deducoes e Impostos', 'Deduções e Impostos',
  'CMV / Logistica', 'CMV / Logística',
  'Outros Custos Diretos',
  'Equipamentos',
  'Provisao Manutencao', 'Provisão Manutenção',
  'Pessoal (Salarios CLT)', 'Pessoal (Salários CLT)',
  'Beneficios', 'Benefícios',
  'INSS / FGTS',
  'Pro-Labore', 'Pró-Labore',
  'Ferias / 13', 'Férias / 13°', 'Férias / 13',
  'Aluguel',
  'Marketing',
  'TI / Tecnologia',
  'Despesas Diversas',
  'Manutencao Predial', 'Manutenção Predial',
  'Exames / Saude', 'Exames / Saúde',
  'Despesas Financeiras',
  'Numero de Pedidos', 'Número de Pedidos', 'Nº de Pedidos',
  'Ticket Medio', 'Ticket Médio',
]);

const METAS_LABEL_TO_KEY: Record<string, keyof MetasFromXlsx> = {
  'Receita Anual': 'receitaAnual',
  'Lucro Liquido Anual': 'lucroAnual',
  'Lucro Líquido Anual': 'lucroAnual',
  'Margem Bruta (%)': 'margemBrutaPct',
  'Margem Operacional (%)': 'margemOpPct',
  'Margem Liquida (%)': 'margemLiqPct',
  'Margem Líquida (%)': 'margemLiqPct',
  'Ticket Medio': 'ticketMedio',
  'Ticket Médio': 'ticketMedio',
  'Pedidos/Mes': 'pedidosMes',
  'Pedidos/Mês': 'pedidosMes',
};

/**
 * Map of label string -> 12 monthly numbers. Routes resolve labels to
 * the period's PeriodCategory.id at upload time.
 */
export type EntriesByLabel = Record<string, number[]>;
export type MetasFromXlsx = {
  receitaAnual?: number | null;
  lucroAnual?: number | null;
  margemBrutaPct?: number | null;
  margemOpPct?: number | null;
  margemLiqPct?: number | null;
  ticketMedio?: number | null;
  pedidosMes?: number | null;
};

function numOrNull(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = parseFloat(v.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Parse a sheet of the shape:
 *   row 0..n: headers/title lines (ignored)
 *   some row: category label in column A, 12 values in B..M
 *   ...
 * Returns whatever rows we can read. Routes filter against the period's
 * actual category labels — if user renamed a category, the upload simply
 * skips the old-named row instead of clobbering.
 *
 * We optionally accept ANY non-empty label (not just KNOWN_LABELS) so a
 * user who renames "Pessoal" to "Equipe" can still upload and have the
 * row matched against their new label. Section-style header rows (no
 * numeric values) are filtered by checking that at least one cell B..M
 * is numeric.
 */
function parseEntriesSheet(ws: XLSX.WorkSheet): EntriesByLabel {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: 0,
    raw: true,
  });
  const out: EntriesByLabel = {};
  for (const row of aoa) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const label = typeof row[0] === 'string' ? row[0].trim() : '';
    if (!label) continue;
    // Skip section header rows (no numeric values in B..M) AND the
    // table header row ("Categoria | Jan | Fev | ..."). A row qualifies
    // as a real entries row if at least one of B..M parses to a finite
    // number — string values like month names ("Jan") don't count.
    let hasNumeric = false;
    const monthly: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const cell = row[i];
      monthly.push(numOrNull(cell));
      if (typeof cell === 'number' && Number.isFinite(cell)) hasNumeric = true;
    }
    // Always include if it's a known label (lets us preserve all-zero
    // built-in rows). Otherwise require at least one numeric value.
    if (KNOWN_LABELS.has(label) || hasNumeric) {
      out[label] = monthly;
    }
  }
  return out;
}

function parseMetasSheet(ws: XLSX.WorkSheet): MetasFromXlsx {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
  });
  const out: MetasFromXlsx = {};
  for (const row of aoa) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const label = typeof row[0] === 'string' ? row[0].trim() : '';
    const key = METAS_LABEL_TO_KEY[label];
    if (!key) continue;
    const rawVal = row[1];
    if (rawVal === null || rawVal === undefined || rawVal === '') {
      out[key] = null;
    } else {
      out[key] = numOrNull(rawVal);
    }
  }
  return out;
}

export type ParsedWorkbook = {
  dreByLabel?: EntriesByLabel;
  fcByLabel?: EntriesByLabel;
  metas?: MetasFromXlsx;
};

/**
 * Parse an uploaded XLSX buffer. Call validateBuffer first.
 */
export function parseBuffer(buf: Buffer): ParsedWorkbook {
  // cellFormula/cellHTML/bookVBA disabled as defense against any
  // XXE-style or macro-based payloads. `raw: true` keeps numeric values
  // as numbers rather than formatted strings.
  const wb = XLSX.read(buf, {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    bookVBA: false,
    cellDates: false,
    dense: true,
  });

  const out: ParsedWorkbook = {};
  if (wb.Sheets['DRE']) out.dreByLabel = parseEntriesSheet(wb.Sheets['DRE']);
  if (wb.Sheets['FC']) out.fcByLabel = parseEntriesSheet(wb.Sheets['FC']);
  if (wb.Sheets['Metas']) out.metas = parseMetasSheet(wb.Sheets['Metas']);

  return out;
}

// ======================================================================
// Template generation
// ======================================================================

const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function makeDreRows(): unknown[][] {
  return [
    ['BusinessCalc — Template DRE'],
    ['Nao altere as etiquetas na coluna A. Preencha apenas os valores numericos.'],
    [],
    ['Categoria', ...MONTHS],
    ['RECEITA'],
    ['Receita de Vendas', ...zeros()],
    ['Deducoes e Impostos', ...zeros()],
    ['CUSTOS DIRETOS'],
    ['CMV / Logistica', ...zeros()],
    ['Outros Custos Diretos', ...zeros()],
    ['Equipamentos', ...zeros()],
    ['Provisao Manutencao', ...zeros()],
    ['DESPESAS OPERACIONAIS'],
    ['Pessoal (Salarios CLT)', ...zeros()],
    ['Beneficios', ...zeros()],
    ['INSS / FGTS', ...zeros()],
    ['Pro-Labore', ...zeros()],
    ['Ferias / 13', ...zeros()],
    ['Aluguel', ...zeros()],
    ['Marketing', ...zeros()],
    ['TI / Tecnologia', ...zeros()],
    ['Despesas Diversas', ...zeros()],
    ['Manutencao Predial', ...zeros()],
    ['Exames / Saude', ...zeros()],
    ['Despesas Financeiras', ...zeros()],
  ];
}

function makeFcRows(): unknown[][] {
  return [
    ['BusinessCalc — Template Fluxo de Caixa'],
    ['Nao altere as etiquetas na coluna A.'],
    [],
    ['Categoria', ...MONTHS],
    ['ENTRADAS'],
    ['Numero de Pedidos', ...zeros()],
    ['Ticket Medio', ...zeros()],
    ['Receita de Vendas', ...zeros()],
    ['SAIDAS'],
    ['CMV / Logistica', ...zeros()],
    ['Outros Custos Diretos', ...zeros()],
    ['Equipamentos', ...zeros()],
    ['Provisao Manutencao', ...zeros()],
    ['Pessoal (Salarios CLT)', ...zeros()],
    ['Beneficios', ...zeros()],
    ['INSS / FGTS', ...zeros()],
    ['Pro-Labore', ...zeros()],
    ['Ferias / 13', ...zeros()],
    ['Aluguel', ...zeros()],
    ['Marketing', ...zeros()],
    ['TI / Tecnologia', ...zeros()],
    ['Despesas Diversas', ...zeros()],
    ['Manutencao Predial', ...zeros()],
    ['Exames / Saude', ...zeros()],
    ['Despesas Financeiras', ...zeros()],
  ];
}

function makeMetasRows(): unknown[][] {
  return [
    ['BusinessCalc — Metas Anuais'],
    ['Defina suas metas. Os valores em % como numero puro (ex: 30 para 30%).'],
    [],
    ['Meta', 'Valor'],
    ['Receita Anual', 0],
    ['Lucro Liquido Anual', 0],
    ['Margem Bruta (%)', 0],
    ['Margem Operacional (%)', 0],
    ['Margem Liquida (%)', 0],
    ['Ticket Medio', 0],
    ['Pedidos/Mes', 0],
  ];
}

function zeros(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

/**
 * Generate the template as a Buffer (XLSX binary).
 */
export function buildTemplateBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(makeDreRows()), 'DRE');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(makeFcRows()), 'FC');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(makeMetasRows()), 'Metas');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
