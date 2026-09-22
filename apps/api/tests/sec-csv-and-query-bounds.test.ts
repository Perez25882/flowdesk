import { describe, expect, it } from 'vitest';
import { reportToCsv } from '../src/modules/dashboard/reports.service.js';
import { InsightsQuerySchema } from '../src/modules/settings/settings.schema.js';

/**
 * Two small gaps on the way out of the system.
 *
 * The CSV one is the classic: quoting protects the COLUMNS — a product name
 * containing a comma does not shift every field after it — but it does nothing
 * about a name that begins `=`, `+`, `-` or `@`, which Excel and Sheets read as
 * a formula. Product names reach this file from the catalogue importer and from
 * the WhatsApp assistant, so they are not something the owner necessarily
 * typed, and the person who opens the export is often not the person who runs
 * the shop.
 *
 * The query one is smaller: `GET /insights` was the only new route parsing its
 * query by hand, and `Math.min(limit, 90)` bounds only the top — a negative
 * limit reached Prisma as a negative `take`.
 */

function report(topProducts: { name: string; quantity: number; value: number }[]) {
  return {
    from: '2026-09-01',
    to: '2026-09-18',
    revenue: 100,
    orders: 2,
    ordersCompleted: 2,
    ordersCancelled: 0,
    averageOrderValue: 50,
    outstanding: 0,
    series: [],
    topProducts,
  } as never;
}

describe('reportToCsv', () => {
  it('neutralises a product name a spreadsheet would run as a formula', () => {
    const csv = reportToCsv(report([{ name: '=1+1', quantity: 1, value: 10 }]));

    // The cell must not START with the character that triggers evaluation.
    expect(csv).not.toContain('"=1+1"');
    expect(csv).toContain('1+1');
  });

  it('neutralises every prefix a spreadsheet treats as a formula', () => {
    for (const name of ['=cmd', '+cmd', '-cmd', '@cmd']) {
      const csv = reportToCsv(report([{ name, quantity: 1, value: 10 }]));

      expect(csv).not.toContain(`"${name}"`);
    }
  });

  it('still protects the columns', () => {
    // The original guarantee has to survive the new one: a comma must not shift
    // the columns, and an internal quote must still be doubled.
    const csv = reportToCsv(report([{ name: 'Rice, 5kg "premium"', quantity: 1, value: 10 }]));

    expect(csv).toContain('"Rice, 5kg ""premium"""');
  });

  it('leaves an ordinary product name readable', () => {
    const csv = reportToCsv(report([{ name: 'Rice 5kg', quantity: 2, value: 100 }]));

    expect(csv).toContain('"Rice 5kg",2,100.00');
  });
});

describe('InsightsQuerySchema', () => {
  it('defaults to a fortnight when no limit is given', () => {
    expect(InsightsQuerySchema.parse({}).limit).toBe(14);
  });

  it('refuses a negative limit, which reached Prisma as a negative take', () => {
    expect(() => InsightsQuerySchema.parse({ limit: '-999999' })).toThrow();
  });

  it('refuses a limit past the ninety days the table holds', () => {
    expect(() => InsightsQuerySchema.parse({ limit: '5000' })).toThrow();
  });

  it('refuses something that is not a number at all', () => {
    expect(() => InsightsQuerySchema.parse({ limit: 'abc' })).toThrow();
  });

  it('accepts a limit inside the window', () => {
    expect(InsightsQuerySchema.parse({ limit: '30' }).limit).toBe(30);
  });
});
