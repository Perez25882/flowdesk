import { describe, expect, it } from 'vitest';
import {
  composeConfirmation,
  composeQuestion,
  displayPhone,
  isAffirmative,
  isComplete,
  nextMissingField,
  parseAnswer,
  parseContactPhone,
} from '../src/services/assistant/delivery-capture.js';

describe('parseContactPhone', () => {
  it('accepts the shapes people actually send', () => {
    const expected = '233244123456';
    for (const input of [
      '0244123456',
      '244123456',
      '233244123456',
      '+233244123456',
      '+233 24 412 3456',
      '233-244-123456',
      '(0244) 123 456',
    ]) {
      expect(parseContactPhone(input), input).toBe(expected);
    }
  });

  it('rejects a network prefix that does not exist', () => {
    // 0211 is not a Ghanaian mobile prefix. A rider dialling it wastes a trip,
    // which is worse than having no number at all.
    expect(parseContactPhone('0211123456')).toBeNull();
    expect(parseContactPhone('0991234567')).toBeNull();
  });

  it('rejects wrong lengths and non-numbers', () => {
    for (const input of ['', 'call me', '12', '0244']) {
      expect(parseContactPhone(input), input).toBeNull();
    }
  });

  it('keeps a diaspora number instead of forcing 233 onto it', () => {
    // Someone in London ordering for family in Accra is an ordinary Friday.
    expect(parseContactPhone('+44 7700 900123')).toBe('447700900123');
    expect(parseContactPhone('+1 415 555 0100')).toBe('14155550100');
  });
});

describe('parseAnswer', () => {
  it('strips the lead-ins people type without eating the answer', () => {
    expect(parseAnswer('recipientName', 'my name is Ama Boateng')).toBe('Ama Boateng');
    expect(parseAnswer('recipientName', "It's Kwame")).toBe('Kwame');
    expect(parseAnswer('recipientName', 'Please, my name is Yaa Owusu')).toBe('Yaa Owusu');
    expect(parseAnswer('deliveryAddress', 'the address is 12 Oxford St, Osu')).toBe('12 Oxford St, Osu');
    expect(parseAnswer('deliveryAddress', 'deliver to 4 Ring Road, Accra')).toBe('4 Ring Road, Accra');
  });

  it('keeps an answer that merely starts with a preamble-looking word', () => {
    // "The Blue House" is the address, not a lead-in. Losing "The" here would
    // be worse than leaving a stray "my name is" on a name.
    expect(parseAnswer('deliveryAddress', 'The Blue House, East Legon')).toBe('The Blue House, East Legon');
  });

  it('refuses an acknowledgement dressed up as an address', () => {
    for (const body of ['ok', 'yes', 'sure', 'send it', 'go ahead', '  ']) {
      expect(parseAnswer('deliveryAddress', body), body).toBeNull();
    }
  });

  it('refuses a name with no letters in it', () => {
    expect(parseAnswer('recipientName', '0244123456')).toBeNull();
    expect(parseAnswer('recipientName', '12345')).toBeNull();
  });

  it('refuses answers long enough to be a paragraph', () => {
    expect(parseAnswer('deliveryAddress', 'x'.repeat(200))).toBeNull();
    expect(parseAnswer('recipientName', 'y'.repeat(80))).toBeNull();
  });

  it('normalises a phone answer rather than storing what was typed', () => {
    expect(parseAnswer('contactPhone', 'my number is 024 412 3456')).toBe('233244123456');
    expect(parseAnswer('contactPhone', 'call 0211123456')).toBeNull();
  });

  it('collapses runaway whitespace', () => {
    expect(parseAnswer('deliveryAddress', '12   Oxford   St,\n\nOsu')).toBe('12 Oxford St, Osu');
  });
});

describe('nextMissingField', () => {
  const empty = { recipientName: null, deliveryAddress: null, contactPhone: null };

  it('asks in a fixed order so a retry resumes where it stopped', () => {
    expect(nextMissingField(empty)).toBe('recipientName');
    expect(nextMissingField({ ...empty, recipientName: 'Ama' })).toBe('deliveryAddress');
    expect(nextMissingField({ ...empty, recipientName: 'Ama', deliveryAddress: '12 Oxford St' })).toBe('contactPhone');
  });

  it('reports completion only when every field is filled', () => {
    expect(isComplete(empty)).toBe(false);
    const full = { recipientName: 'Ama', deliveryAddress: '12 Oxford St', contactPhone: '233244123456' };
    expect(nextMissingField(full)).toBeNull();
    expect(isComplete(full)).toBe(true);
  });

  it('treats an empty string as missing, not as answered', () => {
    expect(nextMissingField({ ...empty, recipientName: '' })).toBe('recipientName');
  });
});

describe('questions', () => {
  it('never asks for two things in one message', () => {
    for (const field of ['recipientName', 'deliveryAddress', 'contactPhone'] as const) {
      const q = composeQuestion(field, { profile: null });
      expect(q.match(/\?/g)?.length ?? 0, `${field}: ${q}`).toBe(1);
    }
  });

  it('names the delivery areas when the business has declared them', () => {
    const q = composeQuestion('deliveryAddress', {
      profile: { deliveryAreas: ['Osu', 'East Legon', 'Tema'] } as never,
    });
    expect(q).toContain('Osu');
    expect(q).toContain('Tema');
  });

  it('phrases a re-ask differently from the first ask', () => {
    for (const field of ['recipientName', 'deliveryAddress', 'contactPhone'] as const) {
      expect(composeQuestion(field, { profile: null, reasked: true }))
        .not.toBe(composeQuestion(field, { profile: null }));
    }
  });
});

describe('returning customers', () => {
  const known = {
    recipientName: 'Ama Boateng',
    deliveryAddress: '12 Oxford St, Osu',
    contactPhone: '233244123456',
  };

  it('offers everything back in one message', () => {
    const msg = composeConfirmation(known)!;
    expect(msg).toContain('Ama Boateng');
    expect(msg).toContain('12 Oxford St, Osu');
    expect(msg).toContain('024 412 3456');
  });

  it('does not offer a partial record back', () => {
    expect(composeConfirmation({ ...known, contactPhone: null })).toBeNull();
  });

  it('reads a yes, and does not read an address as one', () => {
    for (const yes of ['yes', 'Yes', 'YES', 'yh', 'ok', 'correct', 'same', "that's right"]) {
      expect(isAffirmative(yes), yes).toBe(true);
    }
    for (const no of ['no', '12 Oxford St', 'actually send it to Tema', 'yes but change the number']) {
      expect(isAffirmative(no), no).toBe(false);
    }
  });
});

describe('displayPhone', () => {
  it('turns storage format back into something readable', () => {
    expect(displayPhone('233244123456')).toBe('024 412 3456');
  });

  it('leaves anything unexpected alone rather than mangling it', () => {
    expect(displayPhone('+1 415 555 0100')).toBe('+1 415 555 0100');
  });
});
