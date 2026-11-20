const WHITESPACE = /\s+/g;

// An emoji can be several characters: pictographs, skin tones and flag letters,
// glued together by joiners, keycap marks and variation selectors
const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\u20E3|\uFE0E|\uFE0F)+/gu;

/**
 * Makes a text comparable with a query: letters are lowercased and whitespace
 * is dropped, so that "alphabeta" finds "Alpha Beta".
 */
export function fold(text: string): string {
  return text.toLowerCase().replace(WHITESPACE, "");
}

/**
 * Drops emoji. They say nothing about where a name belongs in an alphabetical
 * list, and a name like "📝 Memo" should still count as starting with "memo".
 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI, "");
}

/** True if the folded text starts with the folded word, emoji aside. */
export function startsWith(text: string, word: string): boolean {
  return text.startsWith(word) || stripEmoji(text).startsWith(word);
}
