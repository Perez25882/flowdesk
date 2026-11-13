import { z } from 'zod';
import { assistantFactSchema, assistantPriceOfferSchema } from './decision.js';
import { loadAssistantContext } from './context-builder.js';
import { hasPolicyOverride, ordinaryReply, renderVerifiedFact } from './commitment.js';
import { ConflictError } from '../../utils/errors.js';
import type { Prisma } from '@prisma/client';

const storedDraft = z.object({
  version: z.literal(1), state: z.literal('REVIEW'), effect: z.literal('reply'),
  fact: assistantFactSchema.optional(), offer: assistantPriceOfferSchema.nullish(),
});

export async function verifyAssistantDraft(input: {
  businessId: string; customerId: string; messageId: string; message: string; policy: unknown; text: string;
}): Promise<void> {
  const record = storedDraft.safeParse(input.policy);
  if (!record.success || hasPolicyOverride(input.message)) throw new ConflictError('This draft cannot be verified. Discard it and write a new reply.');
  const context = await loadAssistantContext({ ...input, includeUntrustedContext: false });
  if (!context || context.business.aiAssistMode === 'OFF') throw new ConflictError('Assistant draft evidence is no longer available.');
  const { fact, offer } = record.data;
  const verified = fact ? renderVerifiedFact({
    proposal: fact, offer: offer ?? null, message: input.message, evidence: context.evidence,
    products: context.products, profile: context.profile,
  }) : null;
  const text = fact ? verified?.text : ordinaryReply(input.message, input.text);
  if (!text || text !== input.text || verified?.link) throw new ConflictError('The draft evidence changed. Discard it and write a new reply.');
}

export function draftAudit(policy: Prisma.JsonValue | null): Prisma.JsonObject {
  return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
}
