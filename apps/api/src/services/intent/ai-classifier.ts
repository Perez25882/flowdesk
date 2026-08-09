import type { IntentClassification } from '@flowdesk/shared';

export interface AiClassifier {
  readonly name: string;
  /**
   * @param businessId Scopes the result cache. Classification depends on the
   * business's own catalogue and reply templates, so one shop's reading of an
   * ambiguous phrase must not decide another shop's auto-reply.
   */
  classify(text: string, businessId: string): Promise<IntentClassification>;
}
