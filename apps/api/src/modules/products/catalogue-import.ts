/**
 * Loading a catalogue from a spreadsheet.
 *
 * This is the difference between a shop trying Flowdesk and a shop using it. A
 * provisions store with 300 lines will not type them in one at a time, and the
 * assistant is worth nothing without a catalogue — so the import is not a
 * convenience feature, it is the gate everything else sits behind.
 *
 * Written by hand rather than with a CSV library for one reason: the files that
 * arrive here are exported from Excel on Windows, and what actually breaks is
 * never the RFC — it is a BOM, CRLF, a semicolon delimiter because the machine
 * is set to a European locale, and "GHS 1,200.00" in a price column. A parser we
 * own can be taught each of those, and each one is a real file somebody sent.
 */

/** Bounded so a 40MB paste cannot hold a request open. */
export const MAX_IMPORT_ROWS = 2000;

export interface ParsedRow {
  /** 1-based, counting the header, so it matches what the owner sees in Excel. */
  line: number;
  name: string;
  unit: string;
  price: number;
  stockQuantity: number;
  reorderThreshold: number;
  aliases: string[];
  sku: string | null;
}

export interface RowError {
  line: number;
  /** The row as it was written, so the owner can find it in their sheet. */
  raw: string;
  message: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];
  /** Columns found in the header, in order, after normalisation. */
  columns: string[];
  truncated: boolean;
}

/**
 * Column names we accept for each field.
 *
 * Generous because the file comes from wherever the shop already keeps its
 * list — a Shopify export, a stocktake sheet, something a nephew made. Asking
 * an owner to rename columns before their first import is asking them not to
 * import.
 */
const COLUMN_ALIASES: Record<keyof Omit<ParsedRow, 'line'>, string[]> = {
  name: ['name', 'product', 'product name', 'item', 'item name', 'description', 'title'],
  unit: ['unit', 'sold by', 'uom', 'measure', 'size'],
  price: ['price', 'unit price', 'selling price', 'amount', 'cost', 'rate'],
  stockQuantity: ['stock', 'quantity', 'qty', 'stock quantity', 'in stock', 'on hand', 'balance'],
  reorderThreshold: ['reorder', 'reorder level', 'reorder threshold', 'min', 'minimum', 'alert at'],
  aliases: ['aliases', 'other names', 'also called', 'alias', 'keywords', 'tags'],
  sku: ['sku', 'code', 'product code', 'item code', 'barcode'],
};

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Which delimiter the file actually uses.
 *
 * Excel writes semicolons wherever the machine's decimal separator is a comma,
 * which is most of continental Europe and turns up in Ghana often enough to
 * matter. Guessing wrong produces a single column named
 * "name;price;stock" and an import that fails for reasons nobody can see, so
 * the header line is counted rather than assumed.
 */
export function detectDelimiter(headerLine: string): ',' | ';' | '\t' {
  const counts = {
    ',': (headerLine.match(/,/g) ?? []).length,
    ';': (headerLine.match(/;/g) ?? []).length,
    '\t': (headerLine.match(/\t/g) ?? []).length,
  };

  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

/**
 * Splits one CSV line, honouring quotes.
 *
 * A product called `Rice, 5kg` is written `"Rice, 5kg"` and splitting on commas
 * alone turns it into two broken rows. Doubled quotes inside a quoted field
 * (`""`) are one literal quote, which is what every spreadsheet emits.
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Reads a money or quantity value the way a person wrote it.
 *
 * "GHS 1,200.00", "1200", "₵80" and "80.00" are all the same number to a shop
 * owner, and rejecting three of those four would make the import look broken
 * when the file is fine. Returns null for anything genuinely unreadable, which
 * the caller reports against the row rather than silently treating as zero —
 * a price that quietly became 0 is a product given away.
 */
export function parseNumber(value: string): number | null {
  const cleaned = value
    .replace(/[₵$£€]/g, '')
    .replace(/ghs|ghc|cedis?/gi, '')
    .replace(/,/g, '')
    .trim();

  if (cleaned.length === 0) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turns a spreadsheet into rows we would be willing to insert.
 *
 * Every row is judged on its own. A file with one bad price imports the other
 * 299 lines and reports the one — the alternative, refusing the whole file,
 * means an owner fixing one typo at a time and re-uploading, which is how an
 * import gets abandoned at the second attempt.
 */
export function parseCatalogueCsv(text: string): ParseResult {
  const withoutBom = text.replace(/^\uFEFF/, '');
  const lines = withoutBom.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: [], columns: [], truncated: false };
  }

  const delimiter = detectDelimiter(lines[0]!);
  const header = splitCsvLine(lines[0]!, delimiter).map(normalizeHeader);

  const indexOf = (field: keyof typeof COLUMN_ALIASES): number =>
    header.findIndex((column) => COLUMN_ALIASES[field].includes(column));

  const nameIndex = indexOf('name');
  const priceIndex = indexOf('price');

  if (nameIndex === -1 || priceIndex === -1) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          raw: lines[0]!,
          message:
            'The first row has to name the columns, and must include a product name and a price. Found: ' +
            (header.join(', ') || '(nothing)'),
        },
      ],
      columns: header,
      truncated: false,
    };
  }

  const unitIndex = indexOf('unit');
  const stockIndex = indexOf('stockQuantity');
  const reorderIndex = indexOf('reorderThreshold');
  const aliasIndex = indexOf('aliases');
  const skuIndex = indexOf('sku');

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  const seenNames = new Set<string>();
  const body = lines.slice(1);
  const truncated = body.length > MAX_IMPORT_ROWS;

  for (const [offset, line] of body.slice(0, MAX_IMPORT_ROWS).entries()) {
    const lineNumber = offset + 2;
    const fields = splitCsvLine(line, delimiter);
    const cell = (index: number): string => (index === -1 ? '' : (fields[index] ?? ''));

    const name = cell(nameIndex);
    if (name.length === 0) {
      errors.push({ line: lineNumber, raw: line, message: 'No product name in this row.' });
      continue;
    }
    if (name.length > 200) {
      errors.push({ line: lineNumber, raw: line, message: 'That product name is too long.' });
      continue;
    }

    // Two rows for one product would create two catalogue entries that the
    // matcher then has to choose between on every message — worse than
    // refusing the duplicate here, where the owner can see it.
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      errors.push({
        line: lineNumber,
        raw: line,
        message: `"${name}" appears more than once in this file.`,
      });
      continue;
    }

    const price = parseNumber(cell(priceIndex));
    if (price === null) {
      errors.push({
        line: lineNumber,
        raw: line,
        message: `Could not read a price from "${cell(priceIndex)}".`,
      });
      continue;
    }
    if (price < 0) {
      errors.push({ line: lineNumber, raw: line, message: 'A price cannot be negative.' });
      continue;
    }

    const stock = stockIndex === -1 ? 0 : (parseNumber(cell(stockIndex)) ?? 0);
    const reorder = reorderIndex === -1 ? 0 : (parseNumber(cell(reorderIndex)) ?? 0);

    seenNames.add(nameKey);
    rows.push({
      line: lineNumber,
      name,
      // "each" rather than blank: the unit is printed in replies, and an empty
      // one produces "GHS 80 per" in a message to a customer.
      unit: cell(unitIndex) || 'each',
      price,
      stockQuantity: Math.max(stock, 0),
      reorderThreshold: Math.max(reorder, 0),
      aliases: splitAliases(cell(aliasIndex)),
      sku: cell(skuIndex) || null,
    });
  }

  if (truncated) {
    errors.push({
      line: MAX_IMPORT_ROWS + 2,
      raw: '',
      message: `Only the first ${MAX_IMPORT_ROWS} rows were read. Split the file and import the rest.`,
    });
  }

  return { rows, errors, columns: header, truncated };
}

/**
 * Other names for the product, however the owner separated them.
 *
 * Commas, semicolons, pipes and slashes all appear in real files, and a list
 * that failed to split is one long useless alias rather than five good ones —
 * which silently costs the shop every message that would have matched.
 */
export function splitAliases(value: string): string[] {
  if (!value.trim()) return [];

  return [
    ...new Set(
      value
        .split(/[,;|/]/)
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0 && alias.length <= 80),
    ),
  ].slice(0, 20);
}

/** The header row of the template the dashboard offers to download. */
export const IMPORT_TEMPLATE_CSV = [
  'name,unit,price,stock,reorder,aliases,sku',
  'Rice 5kg,bag,80,40,8,"small rice, 5kg rice",RICE-5',
  'Coca-Cola 33cl,bottle,5,120,24,"coke, cola",COKE-33',
].join('\n');
