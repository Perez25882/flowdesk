import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  parseCatalogueCsv,
  parseNumber,
  splitAliases,
  splitCsvLine,
  MAX_IMPORT_ROWS,
} from '../src/modules/products/catalogue-import.js';

/**
 * Reading the files shops actually send.
 *
 * Every case below is a real shape an Excel export produces, not an RFC edge
 * case. The parser exists rather than a library precisely because these are
 * what break, and each one costs a shop their whole catalogue if unhandled.
 */

describe('detectDelimiter', () => {
  it('reads a comma file', () => {
    expect(detectDelimiter('name,price,stock')).toBe(',');
  });

  it('reads the semicolons Excel writes on a European locale', () => {
    // Guessing comma here yields one column called "name;price;stock" and an
    // import that fails for a reason the owner cannot see.
    expect(detectDelimiter('name;price;stock')).toBe(';');
  });

  it('reads a tab-separated paste', () => {
    expect(detectDelimiter('name\tprice\tstock')).toBe('\t');
  });
});

describe('splitCsvLine', () => {
  it('keeps a quoted comma inside its field', () => {
    expect(splitCsvLine('"Rice, 5kg",bag,80', ',')).toEqual(['Rice, 5kg', 'bag', '80']);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(splitCsvLine('"6"" pipe",each,12', ',')).toEqual(['6" pipe', 'each', '12']);
  });

  it('keeps empty trailing fields', () => {
    expect(splitCsvLine('Rice,bag,80,,', ',')).toEqual(['Rice', 'bag', '80', '', '']);
  });
});

describe('parseNumber', () => {
  it('reads money however a person wrote it', () => {
    expect(parseNumber('80')).toBe(80);
    expect(parseNumber('80.50')).toBe(80.5);
    expect(parseNumber('GHS 1,200.00')).toBe(1200);
    expect(parseNumber('₵80')).toBe(80);
    expect(parseNumber(' 80 cedis ')).toBe(80);
  });

  it('returns null rather than zero for something unreadable', () => {
    // A price that quietly became 0 is a product given away.
    expect(parseNumber('ask')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
  });
});

describe('splitAliases', () => {
  it('splits on every separator a real file uses', () => {
    expect(splitAliases('coke, cola; soda | fizzy/pop')).toEqual([
      'coke',
      'cola',
      'soda',
      'fizzy',
      'pop',
    ]);
  });

  it('drops duplicates and empties', () => {
    expect(splitAliases('coke,,coke, cola')).toEqual(['coke', 'cola']);
  });

  it('returns nothing for an empty cell', () => {
    expect(splitAliases('')).toEqual([]);
    expect(splitAliases('   ')).toEqual([]);
  });
});

describe('parseCatalogueCsv', () => {
  it('reads a straightforward file', () => {
    const result = parseCatalogueCsv(
      'name,unit,price,stock,reorder,aliases\nRice 5kg,bag,80,40,8,"small rice"\n',
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      line: 2,
      name: 'Rice 5kg',
      unit: 'bag',
      price: 80,
      stockQuantity: 40,
      reorderThreshold: 8,
      aliases: ['small rice'],
    });
  });

  it('survives a Windows export: BOM, CRLF and semicolons at once', () => {
    const result = parseCatalogueCsv('﻿name;price\r\nRice 5kg;80\r\n');
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.name).toBe('Rice 5kg');
    expect(result.rows[0]?.price).toBe(80);
  });

  it('accepts the column names other systems use', () => {
    const result = parseCatalogueCsv('Product Name,Selling Price,Qty\nCoke,5,120\n');
    expect(result.rows[0]).toMatchObject({ name: 'Coke', price: 5, stockQuantity: 120 });
  });

  it('defaults the unit rather than leaving it blank', () => {
    // An empty unit produces "GHS 80 per" in a message to a customer.
    const result = parseCatalogueCsv('name,price\nRice,80\n');
    expect(result.rows[0]?.unit).toBe('each');
  });

  it('imports the good rows and reports only the bad one', () => {
    const result = parseCatalogueCsv(
      'name,price\nRice,80\nBad Row,ask me\nCoke,5\n',
    );
    expect(result.rows.map((r) => r.name)).toEqual(['Rice', 'Coke']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(3);
    expect(result.errors[0]?.message).toContain('price');
  });

  it('refuses a duplicate product rather than creating two of it', () => {
    const result = parseCatalogueCsv('name,price\nRice,80\nrice,90\n');
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('more than once');
  });

  it('rejects a negative price', () => {
    const result = parseCatalogueCsv('name,price\nRice,-80\n');
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]?.message).toContain('negative');
  });

  it('explains itself when the header has no price column', () => {
    const result = parseCatalogueCsv('product,colour\nRice,white\n');
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]?.message).toContain('price');
    // The owner is told what WAS found, so they can see their own header.
    expect(result.errors[0]?.message).toContain('colour');
  });

  it('handles an empty file without throwing', () => {
    expect(parseCatalogueCsv('')).toEqual({
      rows: [],
      errors: [],
      columns: [],
      truncated: false,
    });
  });

  it('stops at the row cap and says so', () => {
    const lines = ['name,price'];
    for (let i = 0; i < MAX_IMPORT_ROWS + 5; i += 1) lines.push(`Product ${i},10`);
    const result = parseCatalogueCsv(lines.join('\n'));

    expect(result.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.errors.at(-1)?.message).toContain('Split the file');
  });
});
