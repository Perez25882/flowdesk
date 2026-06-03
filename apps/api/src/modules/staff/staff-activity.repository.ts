import { prisma } from '../../config/database.js';

export interface LogActivityInput {
  staffId: string;
  action: string;
  resourceId?: string;
  resourceType?: string;
  note?: string;
}

export async function logActivity(data: LogActivityInput): Promise<void> {
  await prisma.staffActivity.create({
    data: {
      staffId: data.staffId,
      action: data.action,
      resourceId: data.resourceId ?? null,
      resourceType: data.resourceType ?? null,
      note: data.note ?? null,
    },
  });
}
