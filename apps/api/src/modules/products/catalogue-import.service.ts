import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { PlanLimitError, ValidationError } from '../../utils/errors.js';
import { checkProductLimit } from '../../services/plan/plan.service.js';
import * as repository from './products.repository.js';
import { parseCatalogueCsv, type ParsedRow, type RowError } from './catalogue-import.js';

/**
 * The two halves of an import: look, then commit.
 *
 * Separate calls on purpose. A catalogue is the thing the assistant answers
 * from, so an import that silently created 300 slightly-wrong products would
 * poison every reply afterwards, and undoing it means deleting 300 rows by
 * hand. The preview is what makes this safe to try.
 */

export interface ImportPreview {
  /** Rows that would be created or updated, in file order. */
  rows: Array<ParsedRow & { existingProductId: string | null }>;
  errors: RowError[];
  summary: {
    toCreate: number;
    toUpdate: number;
    failed: number;
    /** Plan headroom, so the owner is told before rather than after. */
    allowed: number | null;
    wouldExceedPlan: boolean;
  };
}

export async function previewImport(businessId: string, csv: string): Promise<ImportPreview> {
  const parsed = parseCatalogueCsv(csv);

  if (parsed.rows.length === 0 && parsed.errors.length > 0) {
    // A header that could not be read is a file-level problem, not a row one.
    return {
      rows: [],
      errors: parsed.errors,
      summary: { toCreate: 0, toUpdate: 0, failed: parsed.errors.length, allowed: null, wouldExceedPlan: false },
    };
  }

  const existing = await findExistingByName(
    businessId,
    parsed.rows.map((row) => row.name),
  );

  const rows = parsed.rows.map((row) => ({
    ...row,
    existingProductId: existing.get(row.name.toLowerCase()) ?? null,
  }));

  const toCreate = rows.filter((row) => row.existingProductId === null).length;
  const current = await repository.countProducts(businessId);
  const limit = await checkProductLimit(businessId, current);

  return {
    rows,
    errors: parsed.errors,
    summary: {
      toCreate,
      toUpdate: rows.length - toCreate,
      failed: parsed.errors.length,
      allowed: limit.limit ?? null,
      // Only new products count against the limit; updating 200 existing rows
      // costs nothing, and telling an owner otherwise would sell them an
      // upgrade they do not need.
      wouldExceedPlan: limit.limit !== null && current + toCreate > limit.limit,
    },
  };
}

export interface ImportResult {
  created: number;
  updated: number;
  failed: RowError[];
}

/**
 * Writes the import.
 *
 * Matched to existing products by name, case-insensitively, so re-importing an
 * updated price list is an update rather than a second copy of the catalogue —
 * which is what an owner expects and what every one of them will eventually do.
 *
 * Rows are written one at a time, not in a single transaction. A 300-row
 * transaction that fails on row 280 rolls back 279 good products and reports
 * nothing useful; writing individually means a bad row costs that row and the
 * owner is told which one.
 */
export async function commitImport(
  businessId: string,
  csv: string,
  options: { updateExisting: boolean },
): Promise<ImportResult> {
  const parsed = parseCatalogueCsv(csv);

  if (parsed.rows.length === 0) {
    throw new ValidationError(
      parsed.errors[0]?.message ?? 'There were no products to import in that file.',
    );
  }

  const existing = await findExistingByName(
    businessId,
    parsed.rows.map((row) => row.name),
  );

  const newRows = parsed.rows.filter((row) => !existing.has(row.name.toLowerCase()));
  const current = await repository.countProducts(businessId);
  const limit = await checkProductLimit(businessId, current);

  // Refused up front rather than part-way. Importing to the cap and stopping
  // would leave a half-loaded catalogue, which is worse than none: the
  // assistant would confidently say a product does not exist because its row
  // was row 201.
  if (limit.limit !== null && current + newRows.length > limit.limit) {
    throw new PlanLimitError(
      `Your plan allows ${limit.limit} products and this file would take you to ${
        current + newRows.length
      }. Upgrade, or remove some rows.`,
    );
  }

  const failed: RowError[] = [...parsed.errors];
  let created = 0;
  let updated = 0;

  for (const row of parsed.rows) {
    const existingId = existing.get(row.name.toLowerCase()) ?? null;

    try {
      if (existingId) {
        if (!options.updateExisting) continue;
        await repository.updateProduct(existingId, businessId, {
          unit: row.unit,
          price: row.price,
          stockQuantity: row.stockQuantity,
          reorderThreshold: row.reorderThreshold,
          ...(row.aliases.length > 0 ? { aliases: row.aliases } : {}),
          ...(row.sku ? { sku: row.sku } : {}),
        });
        updated += 1;
      } else {
        await repository.createProduct(
          {
            name: row.name,
            unit: row.unit,
            price: row.price,
            stockQuantity: row.stockQuantity,
            reorderThreshold: row.reorderThreshold,
            aliases: row.aliases,
            ...(row.sku ? { sku: row.sku } : {}),
          },
          businessId,
        );
        created += 1;
      }
    } catch (error: unknown) {
      // The likeliest cause is a duplicate SKU, which is a real constraint and
      // the owner's to resolve. Reported against the line so they can find it.
      failed.push({
        line: row.line,
        raw: row.name,
        message:
          error instanceof Error && /unique/i.test(error.message)
            ? `"${row.name}" has a product code already used by another product.`
            : `"${row.name}" could not be saved.`,
      });
    }
  }

  logger.info({ businessId, created, updated, failed: failed.length }, 'Catalogue import finished');

  return { created, updated, failed };
}

/**
 * Existing products, keyed by lowercase name.
 *
 * One query for the whole file. Checking each row separately would be 300 round
 * trips inside a request an owner is watching a spinner for.
 */
async function findExistingByName(
  businessId: string,
  names: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (names.length === 0) return found;

  const products = await prisma.product.findMany({
    where: {
      businessId,
      deletedAt: null,
      // `mode: 'insensitive'` is not available on `in`, so the comparison is
      // done in memory against a fetched set. A tenant's catalogue is bounded
      // by the plan limit, so this is a few hundred rows at worst.
      OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
    },
    select: { id: true, name: true },
  });

  for (const product of products) {
    found.set(product.name.toLowerCase(), product.id);
  }

  return found;
}
