import type { ClassificationResult, IntentClassification } from '@flowdesk/shared';
import { ClassificationSource } from '@flowdesk/shared';
import { env } from '../../config/env.js';
import { classifyIntent } from './rule-engine.js';
import { ClaudeHaikuClassifier } from './haiku-classifier.js';
import { NvidiaClassifier } from './nvidia-classifier.js';
import type { AiClassifier } from './ai-classifier.js';

const HAIKU_CONFIDENCE_THRESHOLD = env.HAIKU_CONFIDENCE_THRESHOLD;
const HAIKU_FALLBACK_ENABLED = env.HAIKU_FALLBACK_ENABLED;

const aiClassifier: AiClassifier =
  env.AI_PROVIDER === 'nvidia' ? new NvidiaClassifier() : new ClaudeHaikuClassifier();

function toClassificationResult(
  classification: IntentClassification,
  source: ClassificationSource,
): ClassificationResult {
  return {
    intent: classification.intent,
    confidence: classification.confidence,
    matchedPatterns: classification.matchedPatterns,
    source,
  };
}

export interface ClassifyOptions {
  /**
   * The business's own product names and aliases.
   *
   * Lets a message that names a real product be recognised as an order even
   * without an ordering phrase — "5 malta" is an order at a shop that sells
   * Malta, and noise anywhere else.
   */
  catalogTerms?: string[];
}

export async function classifyMessage(
  text: string,
  businessId: string,
  options: ClassifyOptions = {},
): Promise<ClassificationResult> {
  const ruleResult = classifyIntent(text, options.catalogTerms ?? []);

  if (!HAIKU_FALLBACK_ENABLED) {
    return toClassificationResult(ruleResult, ClassificationSource.RULE_ENGINE);
  }

  if (ruleResult.confidence >= HAIKU_CONFIDENCE_THRESHOLD) {
    return toClassificationResult(ruleResult, ClassificationSource.RULE_ENGINE);
  }

  const aiResult = await aiClassifier.classify(text, businessId);

  if (aiResult.intent === ruleResult.intent) {
    const mergedConfidence = Math.max(ruleResult.confidence, aiResult.confidence);
    return toClassificationResult(
      {
        ...ruleResult,
        confidence: mergedConfidence,
      },
      ClassificationSource.HAIKU,
    );
  }

  if (aiResult.confidence > ruleResult.confidence) {
    return toClassificationResult(aiResult, ClassificationSource.HAIKU);
  }

  return toClassificationResult(ruleResult, ClassificationSource.RULE_ENGINE);
}
