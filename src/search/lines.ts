/**
 * Returns a line of a text, without its line break.
 *
 * @param start where the line starts
 * @param lineBreak where the "\n" after the line is, or -1 for the last line
 */
export function lineOf(text: string, start: number, lineBreak: number): string {
  let end = lineBreak === -1 ? text.length : lineBreak;
  if (end > start && text[end - 1] === "\r") {
    end--;
  }
  return text.slice(start, end);
}

/**
 * Calls an action with each line of a text, without its line break, and with
 * where the line starts. The action returns false to stop there.
 *
 * As in Vim, a line break ends a line and does not start one: "a\n" is one
 * line, and "a\n\n" is "a" and an empty line. An empty text is one empty line.
 */
export function forEachLine(text: string, action: (start: number, line: string) => boolean | undefined): void {
  let start = 0;
  for (;;) {
    const lineBreak = text.indexOf("\n", start);
    if (
      action(start, lineOf(text, start, lineBreak)) === false ||
      lineBreak === -1 ||
      lineBreak === text.length - 1
    ) {
      return;
    }
    start = lineBreak + 1;
  }
}

/** The line break that a text has: "\r\n" if its first line ends with one, "\n" otherwise. */
export function lineBreakOf(text: string): string {
  const lineBreak = text.indexOf("\n");
  return lineBreak > 0 && text[lineBreak - 1] === "\r" ? "\r\n" : "\n";
}
