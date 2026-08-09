export const SHARED_PACKAGE_VERSION = '0.1.0';

export { IntentType, ClassificationSource, type IntentClassification, type ClassificationResult } from './intent.js';

export { MIN_PASSWORD_LENGTH } from './auth.js';

export {
  ROLE_CAPABILITIES,
  hasCapability,
  isAssignmentScoped,
  type Capability,
  type StaffRole,
} from './roles.js';

export {
  SSE_EVENT_TYPES,
  SSE_CONNECTED_EVENT,
  type SSEEventType,
  type SSEEvent,
  type SSEEventPayloadMap,
  type OrderCreatedPayload,
  type OrderUpdatedPayload,
  type MessageFlaggedPayload,
  type StockAlertPayload,
  type PaymentConfirmedPayload,
} from './sse.js';
