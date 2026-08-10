export const SHARED_PACKAGE_VERSION = '0.1.0';

export { IntentType, ClassificationSource, type IntentClassification, type ClassificationResult } from './intent.js';

export { MIN_PASSWORD_LENGTH } from './auth.js';

export {
  ASSISTANT_CONTRACT_VERSION,
  ASSISTANT_LANGUAGES,
  ASSISTANT_SENTIMENTS,
  ASSISTANT_ACTIONS,
  ESCALATION_REASONS,
  CLARIFICATION_FIELDS,
  type AssistantLanguage,
  type AssistantSentiment,
  type AssistantEvidenceRef,
  type AssistantProductMention,
  type AssistantDecision,
  type AssistantAction,
  type EscalationReason,
  type ClarificationField,
} from './assistant.js';

export {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  DAYS_OF_WEEK,
  DAY_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PRICING_STANCES,
  PRICING_STANCE_LABELS,
  PROFILE_QUESTIONS,
  AI_ASSIST_MODES,
  AI_ASSIST_MODE_LABELS,
  isProfileEmpty,
  countAnsweredQuestions,
  hasGroundableFacts,
  type BusinessType,
  type DayOfWeek,
  type PaymentMethod,
  type PricingStance,
  type TimeOfDay,
  type OpeningHours,
  type BusinessProfile,
  type ProfileQuestion,
  type AiAssistMode,
} from './business-profile.js';

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

export {
  PAYMENT_CONFIDENCES,
  PAYMENT_CONFIDENCE_RANK,
  PAYMENT_CONFIDENCE_LABELS,
  PAYMENT_DIRECTIONS,
  isAttested,
  netAttested,
  type PaymentConfidence,
  type PaymentDirection,
  type AttestablePayment,
} from './payment-integrity.js';
