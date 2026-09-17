/** Escapes text destined for Telegram's HTML parse mode. */
export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function truncate(input: string, max = 80): string {
  const value = String(input ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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
