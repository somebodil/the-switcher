const WHITESPACE = /\s+/g;
const HAS_WHITESPACE = /\s/;
/** What an emoji is made of is never among these: the letters and signs of ASCII, and the syllables of Korean */
const NO_EMOJI = /^[\u0020-\u007E\uAC00-\uD7A3]*$/;

// An emoji can be several characters: pictographs, skin tones and flag letters,
// glued together by joiners, keycap marks and variation selectors
const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\u20E3|\uFE0E|\uFE0F)+/gu;

/**
 * Makes a text comparable with a query: letters are lowercased and whitespace
 * is dropped, so that "alphabeta" finds "Alpha Beta".
 */
export function fold(text: string): string {
  const lower = text.toLowerCase();
  // Most names of files and folders have no space, and need no second pass
  return HAS_WHITESPACE.test(lower) ? lower.replace(WHITESPACE, "") : lower;
}

/**
 * Drops emoji. They say nothing about where a name belongs in an alphabetical
 * list, and a name like "📝 Memo" should still count as starting with "memo".
 */
export function stripEmoji(text: string): string {
  // The pattern of emoji is slow to run. Most texts are seen to have none at a glance.
  return NO_EMOJI.test(text) ? text : text.replace(EMOJI, "");
}
