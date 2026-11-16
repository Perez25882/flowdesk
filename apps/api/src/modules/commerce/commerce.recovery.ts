export type CommerceRecoveryPoint = 'before-verification' | 'after-verification' | 'before-settlement-commit' |
  'after-settlement-commit' | 'before-preparation' | 'after-preparation-write' | 'after-workflow-commit' |
  'before-reminder-handoff' | 'after-outbound-intent';

export type CommerceRecoveryProbe = (point: CommerceRecoveryPoint) => Promise<void>;
