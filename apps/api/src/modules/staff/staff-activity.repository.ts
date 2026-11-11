import { prisma } from '../../config/database.js';
import type { Prisma } from '@prisma/client';

export type LogActivityInput = ({ staffId: string; businessId?: string } | { staffId: string | null; businessId: string }) & {
  action: string;
  resourceId?: string;
  resourceType?: string;
  note?: string;
};

export async function logActivity(data: LogActivityInput, tx: Prisma.TransactionClient = prisma): Promise<void> {
  await tx.staffActivity.create({
    data: {
      staffId: data.staffId,
      businessId: data.businessId ?? null,
      action: data.action,
      resourceId: data.resourceId ?? null,
      resourceType: data.resourceType ?? null,
      note: data.note ?? null,
    },
  });
}
