/** Escapes text destined for Telegram's HTML parse mode. */
export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Cuts a string to `max` characters without splitting one in half.
 *
 * `String.prototype.slice` counts UTF-16 units, so cutting through an emoji
 * leaves half of a surrogate pair behind. Telegram rejects any request
 * containing one with "strings must be encoded in UTF-8" — which stopped
 * invite links being created for members whose names contained an emoji.
 */
export function sliceCharacters(input: string, max: number): string {
  const characters = Array.from(String(input ?? ''));
  return characters.length <= max ? characters.join('') : characters.slice(0, max).join('');
}

/** Removes any half-character left behind by slicing done elsewhere. */
export function stripLoneSurrogates(input: string): string {
  return String(input ?? '').replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

export function truncate(input: string, max = 80): string {
  const value = String(input ?? '');
  return Array.from(value).length <= max ? value : `${sliceCharacters(value, max - 1)}…`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isValidEmail(input: string): boolean {
  return EMAIL_RE.test(input.trim());
}

/** A best-effort display name for a Telegram user. */
export function displayName(user: { firstName?: string | null; lastName?: string | null; username?: string | null; telegramId?: number }): string {
  const parts = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (parts) return parts;
  if (user.username) return `@${user.username}`;
  return `User ${user.telegramId ?? ''}`.trim();
}

/** Splits long text into Telegram-safe chunks (4096 char limit). */
export function chunkMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
