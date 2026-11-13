/** Keep 64-bit integer tokens lossless while leaving JSON strings intact. */
export function parsePaystackJson(text: string): unknown {
  // Validate the original grammar before normalizing large integer tokens.
  JSON.parse(text);
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  return JSON.parse(text.replace(tokens, (token) => /^\d{16,}$/.test(token) ? JSON.stringify(token) : token));
}

export function transactionIdOf(value: unknown): string | null {
  const decimal = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof decimal !== 'string' || !/^[1-9]\d{0,19}$/.test(decimal)) return null;
  return BigInt(decimal) <= 18446744073709551615n ? decimal : null;
}

export function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function evidenceText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}
