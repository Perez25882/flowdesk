import { NotFoundError } from '../../utils/errors.js';
import type { PaymentConfidence, PaymentDirection } from '@flowdesk/shared';
import type { UpdateCustomerInput, ListCustomersQueryInput } from './customers.schema.js';
import * as repository from './customers.repository.js';

export async function listCustomers(
  businessId: string,
  filters: ListCustomersQueryInput,
): Promise<repository.CustomerWithStats[]> {
  return repository.listCustomers(businessId, filters);
}

export async function getCustomerDetail(
  id: string,
  businessId: string,
): Promise<{
  customer: repository.CustomerWithStats;
  orders: Array<{
    id: string;
    referenceNumber: string;
    status: string;
    totalAmount: number;
    createdAt: Date;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    method: string;
    direction: PaymentDirection;
    confidence: PaymentConfidence;
    voidedAt: Date | null;
    createdAt: Date;
  }>;
}> {
  const result = await repository.getCustomerWithHistory(id, businessId);
  return {
    customer: result.customer,
    orders: result.orders.map((o) => ({ ...o, totalAmount: Number(o.totalAmount) })),
    payments: result.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
  };
}

export async function updateCustomer(
  id: string,
  businessId: string,
  data: UpdateCustomerInput,
): Promise<repository.CustomerWithStats> {
  const existing = await repository.findCustomerById(id, businessId);
  if (!existing) throw new NotFoundError('Customer not found');
  return repository.updateCustomer(id, businessId, data);
}

export async function upsertCustomerByPhone(
  businessId: string,
  waNumber: string,
  displayName: string | null,
): Promise<repository.CustomerWithStats> {
  return repository.upsertCustomerByPhone(businessId, waNumber, displayName);
}

export async function findCustomerByPhone(
  businessId: string,
  waNumber: string,
): Promise<repository.CustomerWithStats | null> {
  return repository.findCustomerByPhone(businessId, waNumber);
}
