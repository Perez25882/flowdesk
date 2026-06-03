import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

import crypto from 'node:crypto';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

interface PaystackCustomer {
  email: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
}

interface PaystackPlan {
  name: string;
  amount: number;
  interval: string;
  description?: string;
}

interface PaystackSubscription {
  customer: string;
  plan: string;
  start_date?: string;
}

interface PaystackInitTransaction {
  email: string;
  amount: number;
  plan?: string;
  callback_url?: string;
  metadata?: Record<string, unknown>;
}

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data?: T;
}

async function paystackRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<PaystackResponse<T>> {
  const url = `${PAYSTACK_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, body: errorBody, endpoint }, 'Paystack API error');
    throw new Error(`Paystack API error: ${response.status} - ${errorBody}`);
  }

  return (await response.json()) as PaystackResponse<T>;
}

export async function createPaystackCustomer(data: PaystackCustomer): Promise<string> {
  const result = await paystackRequest<{ id: number; customer_code: string }>('/customer', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!result.status || !result.data) {
    throw new Error(`Failed to create Paystack customer: ${result.message}`);
  }

  return String(result.data.id);
}

export async function createPaystackPlan(data: PaystackPlan): Promise<string> {
  const result = await paystackRequest<{ id: number; plan_code: string }>('/plan', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!result.status || !result.data) {
    throw new Error(`Failed to create Paystack plan: ${result.message}`);
  }

  return String(result.data.plan_code);
}

export async function createPaystackSubscription(data: PaystackSubscription): Promise<string> {
  const result = await paystackRequest<{ id: number; subscription_code: string; email_token: string }>(
    '/subscription',
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );

  if (!result.status || !result.data) {
    throw new Error(`Failed to create Paystack subscription: ${result.message}`);
  }

  return result.data.subscription_code;
}

export async function initializeTransaction(data: PaystackInitTransaction): Promise<{
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}> {
  const result = await paystackRequest<{
    authorization_url: string;
    access_code: string;
    reference: string;
  }>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!result.status || !result.data) {
    throw new Error(`Failed to initialize transaction: ${result.message}`);
  }

  return {
    authorizationUrl: result.data.authorization_url,
    accessCode: result.data.access_code,
    reference: result.data.reference,
  };
}

export async function verifyTransaction(reference: string): Promise<{
  status: string;
  amount: number;
  paidAt: string | null;
  channel: string;
  metadata: Record<string, unknown> | null;
}> {
  const result = await paystackRequest<{
    status: string;
    amount: number;
    paid_at: string | null;
    channel: string;
    metadata: Record<string, unknown> | null;
  }>(`/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
  });

  if (!result.status || !result.data) {
    throw new Error(`Failed to verify transaction: ${result.message}`);
  }

  return {
    status: result.data.status,
    amount: result.data.amount,
    paidAt: result.data.paid_at,
    channel: result.data.channel,
    metadata: result.data.metadata,
  };
}

export function verifyWebhookSignature(body: string, signature: string): boolean {
  const hash = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest('hex');
  return hash === signature;
}

export async function fetchPaystackSubscription(subscriptionCode: string): Promise<{
  status: string;
  nextPaymentDate: string | null;
}> {
  const result = await paystackRequest<{
    status: string;
    next_payment_date: string | null;
  }>(`/subscription/${encodeURIComponent(subscriptionCode)}`, {
    method: 'GET',
  });

  if (!result.status || !result.data) {
    throw new Error(`Failed to fetch subscription: ${result.message}`);
  }

  return {
    status: result.data.status,
    nextPaymentDate: result.data.next_payment_date,
  };
}
