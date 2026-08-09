import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '../src/services/intent/assistant-client.js';

/**
 * The tolerance layer between an open model and the decision contract.
 *
 * Guided decoding makes this redundant; a prompt-described schema does not.
 * Open models routinely wrap the object in a fence or introduce it with a
 * sentence, and throwing away an otherwise correct decision over punctuation
 * would mean drafting everything — the feature failing quietly while appearing
 * to work.
 *
 * It must stay strict in one direction: anything that is not a JSON object
 * returns null rather than something the Zod pass might half-accept.
 */

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"intent":"ORDER"}')).toEqual({ intent: 'ORDER' });
  });

  it('reads an object wrapped in a markdown fence', () => {
    expect(extractJsonObject('```json\n{"intent":"ORDER"}\n```')).toEqual({ intent: 'ORDER' });
    expect(extractJsonObject('```\n{"intent":"ORDER"}\n```')).toEqual({ intent: 'ORDER' });
  });

  it('reads an object introduced by a sentence', () => {
    expect(extractJsonObject('Here is the decision:\n{"intent":"INQUIRY"}')).toEqual({
      intent: 'INQUIRY',
    });
  });

  it('reads an object with commentary on both sides', () => {
    expect(
      extractJsonObject('Sure! {"intent":"GREETING"} Let me know if you need anything else.'),
    ).toEqual({ intent: 'GREETING' });
  });

  it('keeps nested objects intact rather than stopping at the first brace', () => {
    const result = extractJsonObject(
      'Result: {"answer":{"canAnswer":true,"text":"GHS 80"},"order":{"isOrder":false}}',
    );

    expect(result).toEqual({
      answer: { canAnswer: true, text: 'GHS 80' },
      order: { isOrder: false },
    });
  });

  it('handles leading and trailing whitespace', () => {
    expect(extractJsonObject('\n\n  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it('returns null for prose with no object in it', () => {
    expect(extractJsonObject('I cannot help with that.')).toBeNull();
  });

  it('returns null for an empty response', () => {
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('   ')).toBeNull();
  });

  it('returns null for a truncated object rather than guessing at the rest', () => {
    expect(extractJsonObject('{"intent":"ORDER","answer":{"text":"half a sen')).toBeNull();
  });

  it('unwraps a decision the model wrapped in an array', () => {
    // Same spirit as unwrapping a fence: the decision is there, and the Zod
    // pass still has to accept it before anything acts on it.
    expect(extractJsonObject('[{"intent":"ORDER"}]')).toEqual({ intent: 'ORDER' });
  });

  it('returns null for an array of several objects, which is not a decision', () => {
    expect(extractJsonObject('[{"intent":"ORDER"},{"intent":"INQUIRY"}]')).toBeNull();
  });

  it('returns null for a bare scalar', () => {
    expect(extractJsonObject('"ORDER"')).toBeNull();
    expect(extractJsonObject('42')).toBeNull();
    expect(extractJsonObject('null')).toBeNull();
  });
});
