import type { IntentClassification } from '@flowdesk/shared';

export interface AiClassifier {
  readonly name: string;
  classify(text: string): Promise<IntentClassification>;
}
