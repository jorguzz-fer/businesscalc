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
import type { CategoryKey } from '../schemas/entry.schema.js';

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
 * Labels exactly as they appear in the generated template. These ARE the
 * Portuguese display strings (not the internal category keys) — we map
 * each one to a CategoryKey during parse.
 *
 * Keeping this as a separate mapping (vs. reusing DRE_LABELS from
 * public/app.html) means we can evolve display strings without breaking
 * the parser.
 */
const LABEL_TO_KEY: Record<string, CategoryKey> = {
  'Receita de Vendas': 'receita',
  'Deducoes e Impostos': 'deducoes',
  'Deduções e Impostos': 'deducoes', // tolerate accented variant
  'CMV / Logistica': 'cmv',
  'CMV / Logística': 'cmv',
  'Outros Custos Diretos': 'outrosCustos',
  Equipamentos: 'equipamentos',
  'Provisao Manutencao': 'provisao',
  'Provisão Manutenção': 'provisao',
  'Pessoal (Salarios CLT)': 'pessoal',
  'Pessoal (Salários CLT)': 'pessoal',
  Beneficios: 'beneficios',
  Benefícios: 'beneficios',
  'INSS / FGTS': 'inss',
  'Pro-Labore': 'proLabore',
  'Pró-Labore': 'proLabore',
  'Ferias / 13': 'ferias',
  'Férias / 13°': 'ferias',
  'Férias / 13': 'ferias',
  Aluguel: 'aluguel',
  Marketing: 'marketing',
  'TI / Tecnologia': 'ti',
  'Despesas Diversas': 'diversas',
  'Manutencao Predial': 'manutPredial',
  'Manutenção Predial': 'manutPredial',
  'Exames / Saude': 'exames',
  'Exames / Saúde': 'exames',
  'Despesas Financeiras': 'despFin',
  'Numero de Pedidos': 'pedidos',
  'Número de Pedidos': 'pedidos',
  'Ticket Medio': 'ticketMedio',
  'Ticket Médio': 'ticketMedio',
};

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

export type EntriesFromXlsx = Partial<Record<CategoryKey, number[]>>;
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
 * Returns whatever categories it found; unrecognized rows are skipped.
 */
function parseEntriesSheet(ws: XLSX.WorkSheet): EntriesFromXlsx {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: 0,
    raw: true,
  });
  const out: EntriesFromXlsx = {};
  for (const row of aoa) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const label = typeof row[0] === 'string' ? row[0].trim() : '';
    if (!label) continue;
    const key = LABEL_TO_KEY[label];
    if (!key) continue;
    const monthly: number[] = [];
    for (let i = 1; i <= 12; i++) {
      monthly.push(numOrNull(row[i]));
    }
    out[key] = monthly;
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
  dre?: EntriesFromXlsx;
  fc?: EntriesFromXlsx;
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
  if (wb.Sheets['DRE']) out.dre = parseEntriesSheet(wb.Sheets['DRE']);
  if (wb.Sheets['FC']) out.fc = parseEntriesSheet(wb.Sheets['FC']);
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
