export enum IntentType {
  ORDER = 'ORDER',
  PAYMENT = 'PAYMENT',
  INQUIRY = 'INQUIRY',
  STATUS_CHECK = 'STATUS_CHECK',
  COMPLAINT = 'COMPLAINT',
  GREETING = 'GREETING',
  OTHER = 'OTHER',
  UNCLASSIFIED = 'UNCLASSIFIED',
}

export enum ClassificationSource {
  RULE_ENGINE = 'RULE_ENGINE',
  HAIKU = 'HAIKU',
  MANUAL = 'MANUAL',
}

export interface IntentClassification {
  intent: IntentType;
  confidence: number;
  matchedPatterns: string[];
}

export interface ClassificationResult extends IntentClassification {
  source: ClassificationSource;
}
