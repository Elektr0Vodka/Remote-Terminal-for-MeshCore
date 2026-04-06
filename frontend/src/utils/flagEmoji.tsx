/**
 * Flag emoji rendering utilities.
 *
 * Windows' Segoe UI Emoji font does not render regional-indicator pairs
 * (flag emojis like 🇳🇱) — they appear as two-letter ISO codes instead.
 * We work around this by replacing flag sequences with inline <img> tags
 * pointing to the Twemoji SVG CDN, which renders correctly on all platforms.
 */
import type { ReactNode } from 'react';

/** Matches a single flag emoji: exactly two consecutive regional indicator symbols. */
const FLAG_SINGLE_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;

/** Matches all flag emoji sequences within a string (global, for splitting). */
const FLAG_IN_TEXT_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/**
 * Returns the Twemoji SVG CDN URL for a given emoji string.
 * e.g. 🇳🇱 → https://cdn.jsdelivr.net/npm/twemoji@14.0.2/assets/svg/1f1f3-1f1f1.svg
 */
function twemojiUrl(emoji: string): string {
  const codepoints = [...emoji]
    .map((c) => c.codePointAt(0)!.toString(16))
    .join('-');
  return `https://cdn.jsdelivr.net/npm/twemoji@14.0.2/assets/svg/${codepoints}.svg`;
}

/** Returns true if the string is exactly one flag emoji (two regional indicators). */
export function isFlagEmoji(s: string): boolean {
  return FLAG_SINGLE_RE.test(s);
}

interface FlagEmojiProps {
  /** The flag emoji string, e.g. "🇳🇱". */
  flag: string;
  /** Optional CSS class applied to the <img>. */
  className?: string;
  /**
   * Size override. Defaults to "1em" so the flag scales with surrounding text.
   * Pass a pixel number or any valid CSS dimension string.
   */
  size?: number | string;
}

/**
 * Renders a single flag emoji as an inline Twemoji SVG image.
 * Falls back to plain text if the string isn't a valid flag emoji pair,
 * so this is safe to call unconditionally.
 */
export function FlagEmoji({ flag, className, size = '1em' }: FlagEmojiProps) {
  if (!FLAG_SINGLE_RE.test(flag)) return <>{flag}</>;
  const dim = typeof size === 'number' ? `${size}px` : size;
  return (
    <img
      src={twemojiUrl(flag)}
      alt={flag}
      aria-label={flag}
      className={className}
      style={{
        display: 'inline',
        width: dim,
        height: dim,
        verticalAlign: '-0.1em',
        flexShrink: 0,
      }}
      draggable={false}
    />
  );
}

interface TextWithFlagsProps {
  /** Text that may contain flag emoji sequences. */
  text: string;
  /** Optional CSS class applied to the wrapping <span> (only added when flags are present). */
  className?: string;
  /**
   * Size override passed through to each <FlagEmoji>. Defaults to "1em".
   */
  flagSize?: number | string;
}

/**
 * Renders a text string, replacing any flag emoji sequences with inline
 * Twemoji images so they display correctly on Windows.
 *
 * When there are no flags the text is returned as a plain string fragment
 * (no wrapping element), so it drops into existing layout without change.
 */
export function TextWithFlags({ text, className, flagSize }: TextWithFlagsProps): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  FLAG_IN_TEXT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = FLAG_IN_TEXT_RE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <FlagEmoji key={`flag-${match.index}`} flag={match[0]} size={flagSize} />
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  // No flags found — return plain string to avoid an unnecessary wrapper element
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];

  return (
    <span className={className} style={{ display: 'contents' }}>
      {parts}
    </span>
  );
}
