export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PROCESSING' | 'FULFILLED' | 'CANCELLED';

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

export interface OrderStaff {
  id: string;
  name: string;
}

export interface OrderPayment {
  id: string;
  amount: number;
  method: string;
  verified: boolean;
}

export interface OrderStatusHistory {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  changedBy: string | null;
  note: string | null;
  createdAt: string;
}

export interface OrderWithRelations {
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
