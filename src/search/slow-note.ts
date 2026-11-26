import { forEachLine } from "./lines.ts";
import type { Matcher } from "./matcher.ts";

/**
 * At most how many lines are tried before the clock is looked at. Looking
 * takes time as well, about as long as trying a short line, so while lines go
 * fast the clock is looked at less often.
 */
const MAX_LINES_PER_LOOK = 64;

/**
 * Tries a regular expression on every line of a note, as a replacement goes
 * through the matches, and stops once the lines took longer than the limit.
 *
 * @param clock the time in milliseconds. It is looked at after some of the
 *   lines, as often as they let it be, and once more at the end.
 * @param onLook called with the time whenever the clock is looked at between the lines
 * @returns true if the lines took longer than limit milliseconds
 */
export function takesTooLong(
  text: string,
  matcher: Pick<Matcher, "tryAll">,
  limit: number,
  clock: () => number,
  onLook?: (now: number) => void,
): boolean {
  const start = clock();
  let isSlow = false;
  let lookedAt = start;
  let linesPerLook = 1;
  let linesToLook = 1;
  forEachLine(text, (_start, line) => {
    matcher.tryAll(line);
    if (--linesToLook > 0) {
      return true;
    }
    const now = clock();
    onLook?.(now);
    linesPerLook = now - lookedAt < 1 ? Math.min(linesPerLook * 2, MAX_LINES_PER_LOOK) : 1;
    linesToLook = linesPerLook;
    lookedAt = now;
    isSlow = now - start > limit;
    return !isSlow;
  });
  // The lines after the last look count as well
  return isSlow || clock() - start > limit;
}
