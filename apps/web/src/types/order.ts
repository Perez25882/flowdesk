import { type PaymentConfidence } from '@flowdesk/shared';

export type OrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'DISPATCHED'
  | 'FULFILLED'
  | 'CANCELLED';

export interface OrderItem {
  id: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  matched: boolean;
  matchConfidence: number | null;
}

export interface OrderCustomer {
  id: string;
  waNumber: string;
  name: string | null;
  outstandingBalance?: number;
  totalOrders?: number;
}

/** What the assistant captured in the chat after the order was confirmed. */
export interface OrderDelivery {
  recipientName: string | null;
  deliveryAddress: string | null;
  deliveryArea: string | null;
  /** Stored as 233XXXXXXXXX. Use `formatWaNumber` before showing it. */
  contactPhone: string | null;
  /** Null while the assistant is still asking. */
  deliveryCapturedAt: string | null;
}

/**
 * What left the shop.
 *
 * No proof URL on purpose: the bucket is private and the photo is served by an
 * authenticated endpoint, so the client asks for it rather than linking to it.
 */
export interface Shipment {
  orderId: string;
  courier: string | null;
  trackingNumber: string | null;
  notes: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  hasProof: boolean;
  proofUploadedAt: string | null;
}

export interface OrderStaff {
  id: string;
  name: string;
}

export interface OrderPayment {
  id: string;
  amount: number;
  method: string;
  confidence: PaymentConfidence;
  voidedAt: string | null;
}

export interface OrderStatusHistory {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  changedBy: string | null;
  note: string | null;
  createdAt: string;
}

export interface OrderWithRelations extends OrderDelivery {
  id: string;
  businessId: string;
  customerId: string;
  referenceNumber: string;
  rawMessage: string;
  isManual: boolean;
  status: OrderStatus;
  totalAmount: number;
  amountPaid: number;
  assignedStaffId: string | null;
  stockDeducted: boolean;
  confirmedAt: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  customer: OrderCustomer;
  assignedTo: OrderStaff | null;
  payments: OrderPayment[];
  statusHistory: OrderStatusHistory[];
}

export interface OrderStats {
  totalOrders: number;
  byStatus: Record<string, number>;
  totalRevenue: number;
  totalPaid: number;
  pendingAmount: number;
}

export interface CreateOrderInput {
  customerId?: string;
  customerPhone?: string;
  customerName?: string;
  rawMessage: string;
  items: Array<{
    productId?: string;
    description: string;
    quantity: number;
    unitPrice: number;
  }>;
  notes?: string;
}

export interface UpdateOrderStatusInput {
  status: OrderStatus;
  note?: string;
}

export interface AssignOrderInput {
  staffId: string;
}
