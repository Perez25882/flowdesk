import { describe, expect, it } from 'vitest';
import { IntentType } from '@flowdesk/shared';
import { classifyIntent } from './rule-engine.js';

describe('classifyIntent', () => {
  describe('ORDER intent', () => {
    it('classifies "I want 3 bags of rice" as ORDER', () => {
      const result = classifyIntent('I want 3 bags of rice');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
      expect(result.matchedPatterns.length).toBeGreaterThan(0);
    });

    it('classifies "Please I need the rice abeg" as ORDER', () => {
      const result = classifyIntent('Please I need the rice abeg');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.5);
    });

    it('classifies "Can I get 2 cartons of Malta" as ORDER', () => {
      const result = classifyIntent('Can I get 2 cartons of Malta');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });

    it('classifies Twi "Mepɛ rice bags 3" as ORDER', () => {
      const result = classifyIntent('Mepɛ rice bags 3');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.9);
    });

    it('classifies Pidgin "Abeg make I get 2 cartons Malta" as ORDER', () => {
      const result = classifyIntent('Abeg make I get 2 cartons Malta');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });

    it('classifies "Send me one dozen eggs" as ORDER', () => {
      const result = classifyIntent('Send me one dozen eggs');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });
  });

  describe('PAYMENT intent', () => {
    it('classifies "I\'ve paid already, check your momo" as PAYMENT', () => {
      const result = classifyIntent("I've paid already, check your momo");
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "I sent the money, here is the receipt" as PAYMENT', () => {
      const result = classifyIntent('I sent the money, here is the receipt');
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "Payment done, please confirm" as PAYMENT', () => {
      const result = classifyIntent('Payment done, please confirm');
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(0.55);
    });

    it('classifies Pidgin "I don pay, check your MTN momo" as PAYMENT', () => {
      const result = classifyIntent('I don pay, check your MTN momo');
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "Bank alert received, money transferred" as PAYMENT', () => {
      const result = classifyIntent('Bank alert received, money transferred');
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "Here is the screenshot as proof" as PAYMENT', () => {
      const result = classifyIntent('Here is the screenshot as proof');
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(0.6);
    });
  });

  describe('INQUIRY intent', () => {
    it('classifies "How much is a bag of rice?" as INQUIRY', () => {
      const result = classifyIntent('How much is a bag of rice?');
      expect(result.intent).toBe(IntentType.INQUIRY);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "Do you have Malta in stock?" as INQUIRY', () => {
      const result = classifyIntent('Do you have Malta in stock?');
      expect(result.intent).toBe(IntentType.INQUIRY);
      expect(result.confidence).toBe(0.55);
    });

    it('classifies "What is the price of your rice?" as INQUIRY', () => {
      const result = classifyIntent('What is the price of your rice?');
      expect(result.intent).toBe(IntentType.INQUIRY);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "Are you open on Sundays?" as INQUIRY', () => {
      const result = classifyIntent('Are you open on Sundays?');
      expect(result.intent).toBe(IntentType.INQUIRY);
      expect(result.confidence).toBe(0.55);
    });

    it('classifies "Tell me about your products" as INQUIRY', () => {
      const result = classifyIntent('Tell me about your products');
      expect(result.intent).toBe(IntentType.INQUIRY);
      expect(result.confidence).toBe(0.55);
    });

    it('classifies abbreviation "Hw mch for 2 bags" as INQUIRY', () => {
      const result = classifyIntent('Hw mch for 2 bags');
      expect(result.intent).toBe(IntentType.INQUIRY);
      expect(result.confidence).toBe(0.55);
    });
  });

  describe('STATUS_CHECK intent', () => {
    it('classifies "My order FD-12345 hasn\'t arrived" as STATUS_CHECK', () => {
      const result = classifyIntent("My order FD-12345 hasn't arrived");
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "When will my order be delivered?" as STATUS_CHECK', () => {
      const result = classifyIntent('When will my order be delivered?');
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "Where is my package?" as STATUS_CHECK', () => {
      const result = classifyIntent('Where is my package?');
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "Still waiting for my order" as STATUS_CHECK', () => {
      const result = classifyIntent('Still waiting for my order');
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "Has my order been shipped?" as STATUS_CHECK', () => {
      const result = classifyIntent('Has my order been shipped?');
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies Pidgin "How far my order?" as STATUS_CHECK', () => {
      const result = classifyIntent('How far my order?');
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.6);
    });
  });

  describe('COMPLAINT intent', () => {
    it('classifies "Wrong item received, I ordered rice not beans" as COMPLAINT', () => {
      const result = classifyIntent('Wrong item received, I ordered rice not beans');
      expect(result.intent).toBe(IntentType.COMPLAINT);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "I didn\'t receive my order" as COMPLAINT', () => {
      const result = classifyIntent("I didn't receive my order");
      expect(result.intent).toBe(IntentType.COMPLAINT);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "The product is damaged and spoiled" as COMPLAINT', () => {
      const result = classifyIntent('The product is damaged and spoiled');
      expect(result.intent).toBe(IntentType.COMPLAINT);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "Bad quality, I want a refund" as COMPLAINT', () => {
      const result = classifyIntent('Bad quality, I want a refund');
      expect(result.intent).toBe(IntentType.COMPLAINT);
      expect(result.confidence).toBe(1.0);
    });

    it('classifies "This is not what I ordered" as COMPLAINT', () => {
      const result = classifyIntent('This is not what I ordered');
      expect(result.intent).toBe(IntentType.COMPLAINT);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "Incomplete delivery, missing items" as COMPLAINT', () => {
      const result = classifyIntent('Incomplete delivery, missing items');
      expect(result.intent).toBe(IntentType.COMPLAINT);
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('GREETING intent', () => {
    it('classifies "Hi there" as GREETING', () => {
      const result = classifyIntent('Hi there');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });

    it('classifies "Hello, good morning" as GREETING', () => {
      const result = classifyIntent('Hello, good morning');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });

    it('classifies "Hey, do you have rice?" as GREETING', () => {
      const result = classifyIntent('Hey, do you have rice?');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });

    it('classifies "Good afternoon" as GREETING', () => {
      const result = classifyIntent('Good afternoon');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });

    it('classifies Twi "Maakye, do you have malta?" as GREETING', () => {
      const result = classifyIntent('Maakye, do you have malta?');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });

    it('classifies "Good evening, I want to order" as GREETING', () => {
      const result = classifyIntent('Good evening, I want to order');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });
  });

  describe('Pidgin and Twi messages', () => {
    it('classifies "Abeg give me 5 bags of rice" as ORDER', () => {
      const result = classifyIntent('Abeg give me 5 bags of rice');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });

    it('classifies "Mesrɛ, mepɛ sɛ me nya no" as ORDER', () => {
      const result = classifyIntent('Mesrɛ, mepɛ sɛ me nya no');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.6);
    });

    it('classifies "I don pay already" as PAYMENT', () => {
      const result = classifyIntent('I don pay already');
      expect(result.intent).toBe(IntentType.PAYMENT);
      expect(result.confidence).toBe(0.55);
    });

    it('classifies "ɛte sɛn, I need some items" as GREETING', () => {
      const result = classifyIntent('ɛte sɛn, I need some items');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.7);
    });
  });

  describe('ambiguous messages (lower confidence)', () => {
    it('applies penalty when ORDER and STATUS_CHECK are close', () => {
      const result = classifyIntent('I want my order');
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.45);
    });

    it('applies penalty when PAYMENT and STATUS_CHECK are close', () => {
      const result = classifyIntent("I've paid but where is my order?");
      expect(result.intent).toBe(IntentType.STATUS_CHECK);
      expect(result.confidence).toBe(0.45);
    });

    it('applies penalty when GREETING and COMPLAINT are close', () => {
      const result = classifyIntent('Hello, I need a refund');
      expect(result.intent).toBe(IntentType.GREETING);
      expect(result.confidence).toBe(0.55);
    });
  });

  describe('short or gibberish messages', () => {
    it('classifies "ok" as UNCLASSIFIED', () => {
      const result = classifyIntent('ok');
      expect(result.intent).toBe(IntentType.UNCLASSIFIED);
      expect(result.confidence).toBe(0);
      expect(result.matchedPatterns).toEqual([]);
    });

    it('classifies "..." as UNCLASSIFIED', () => {
      const result = classifyIntent('...');
      expect(result.intent).toBe(IntentType.UNCLASSIFIED);
      expect(result.confidence).toBe(0);
    });

    it('classifies "???" as UNCLASSIFIED', () => {
      const result = classifyIntent('???');
      expect(result.intent).toBe(IntentType.UNCLASSIFIED);
      expect(result.confidence).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('classifies empty string as UNCLASSIFIED', () => {
      const result = classifyIntent('');
      expect(result.intent).toBe(IntentType.UNCLASSIFIED);
      expect(result.confidence).toBe(0);
    });

    it('classifies whitespace-only string as UNCLASSIFIED', () => {
      const result = classifyIntent('   ');
      expect(result.intent).toBe(IntentType.UNCLASSIFIED);
      expect(result.confidence).toBe(0);
    });

    it('expands abbreviation "pls send 3 bags" correctly', () => {
      const result = classifyIntent('pls send 3 bags');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });

    it('handles number variations like "x3" for quantity', () => {
      const result = classifyIntent('I want x3 bags');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });

    it('handles "×3" multiplication symbol for quantity', () => {
      const result = classifyIntent('I want ×3 bags');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });

    it('classifies "3bags" without space as ORDER', () => {
      const result = classifyIntent('I need 3bags');
      expect(result.intent).toBe(IntentType.ORDER);
      expect(result.confidence).toBe(0.8);
    });
  });
});
