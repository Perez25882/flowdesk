import type { BusinessPlan, StaffRole } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      businessId: string;
      plan: BusinessPlan;
      staffId?: string;
      role?: StaffRole;
    };
    business: {
      id: string;
      name: string;
      ownerName: string;
      phone: string | null;
      email: string | null;
      plan: BusinessPlan;
      trialEndsAt: Date | null;
      suspendedAt: Date | null;
      suspendReason: string | null;
      active: boolean;
      paystackSubCode: string | null;
      paystackCustomerId: string | null;
    };
  }
}
