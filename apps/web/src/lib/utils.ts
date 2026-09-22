import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === 'string' ? Number.parseFloat(amount) : amount;
  if (Number.isNaN(num)) return 'GHS 0.00';
  return new Intl.NumberFormat('en-GH', {
    style: 'currency',
    currency: 'GHS',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function timeAgo(date: string | Date): string {
  const now = new Date();
  const then = typeof date === 'string' ? new Date(date) : date;
  const diff = now.getTime() - then.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * A Ghanaian number in the shape people actually read.
 *
 * WhatsApp hands numbers over as bare digits in wire format, 233201847733 , 
 * and that string was being rendered straight into the UI wherever a customer
 * had not given their name yet, which is most new customers. Twelve
 * undifferentiated digits is not something an owner can match against the
 * number in their phone, or read aloud to a rider.
 *
 * Ghanaian numbers are written 0XX XXX XXXX locally and +233 XX XXX XXXX
 * internationally. Anything that is not a recognisable Ghana number is returned
 * untouched rather than forced into a shape it does not have, diaspora
 * customers are common and a mangled foreign number is worse than a raw one.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');

  // 233 + 9 national digits.
  if (digits.length === 12 && digits.startsWith('233')) {
    const national = digits.slice(3);
    return `+233 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
  }

  // Local form, 0 + 9 national digits.
  if (digits.length === 10 && digits.startsWith('0')) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }

  return raw;
}

/**
 * What to call a customer on screen.
 *
 * Their name once they have given one, otherwise their number in readable form.
 * Centralised because the fallback appeared in nine places and half of them
 * printed the raw digits.
 */
export function customerLabel(
  customer: { name?: string | null; waNumber?: string | null } | null | undefined,
  fallback = 'Unknown number',
): string {
  if (!customer) return fallback;
  if (isNameLike(customer.name)) return customer.name!.trim();
  return formatPhone(customer.waNumber) || fallback;
}

/**
 * Whether a WhatsApp profile name is usable as a name on screen.
 *
 * The name comes from the customer's own WhatsApp profile, and people set it to
 * whatever they like — including a single emoji. Rendering that produced a
 * customer called "😏", an order card headed by an emoji, and a greeting that
 * read "Hi 😏!". It looks like the product is broken even though the data is
 * exactly what WhatsApp sent.
 *
 * One letter or digit anywhere is enough to accept it: names in this market are
 * often short, and stripping decoration from around a real name would be worse
 * than keeping it. A string with neither is not a name, and the phone number is
 * the more useful thing to show.
 */
function isNameLike(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\p{L}|\p{N}/u.test(name);
}
