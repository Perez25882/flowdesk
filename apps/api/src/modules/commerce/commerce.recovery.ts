export type CommerceRecoveryPoint = 'before-verification' | 'after-verification' | 'before-settlement-commit' |
  'after-settlement-commit' | 'before-preparation' | 'after-preparation-write' | 'after-workflow-commit' |
  'before-reminder-handoff' | 'after-outbound-intent' |
  'before-service-reservation-commit' | 'before-service-confirmation-commit' | 'before-service-notice-commit';

export type CommerceRecoveryProbe = (point: CommerceRecoveryPoint) => Promise<void>;
