import type { ListMessagesQueryInput, UpdateMessageIntentInput } from './messages.schema.js';
import * as repository from './messages.repository.js';

export async function listMessages(
  businessId: string,
  filters: ListMessagesQueryInput,
): Promise<repository.MessageWithCustomer[]> {
  return repository.listMessages(businessId, filters);
}

export async function updateMessageIntent(
  id: string,
  businessId: string,
  data: UpdateMessageIntentInput,
  correctedBy: string,
): Promise<repository.MessageWithCustomer> {
  return repository.updateMessageIntent(id, businessId, data, correctedBy);
}
