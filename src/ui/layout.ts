/**
 * The size that a dialog was given with the mouse. What is left out is as the
 * dialog comes: as wide and as high as its style sheet says.
 */
export interface Layout {
  /** Width of the dialog in pixels */
  width?: number;
  /** Height of the dialog in pixels */
  height?: number;
  /** How much of the height the results take, from 0 to 1. The preview under them takes the rest. */
  split?: number;
}

export const MIN_WIDTH = 360;
export const MIN_HEIGHT = 240;
export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.85;
/** The least height in pixels of the results and of the preview, while both fit */
export const MIN_PANE = 80;

function clamp(value: number, min: number, max: number): number {
  // A window that is smaller than the least size still gets the least size
  return Math.max(min, Math.min(value, max));
}

/** Reads a layout that was saved. What is not a sensible number is left out. */
export function readLayout(saved: unknown): Layout {
  const layout: Layout = {};
  if (typeof saved !== "object" || saved === null) {
    return layout;
  }
  const { width, height, split } = saved as Record<string, unknown>;
  if (typeof width === "number" && Number.isFinite(width)) {
    layout.width = Math.max(MIN_WIDTH, Math.round(width));
  }
  if (typeof height === "number" && Number.isFinite(height)) {
    layout.height = Math.max(MIN_HEIGHT, Math.round(height));
  }
  if (typeof split === "number" && Number.isFinite(split)) {
    layout.split = clamp(split, MIN_SPLIT, MAX_SPLIT);
  }
  return layout;
}

/**
 * Works out the width of a dialog while one of its sides is dragged.
 *
 * @param dx how far the pointer went to the right since the drag started
 * @param side the side that is dragged
 * @param centered true if the dialog stays in the middle. Then the other side
 *   moves as far the other way, and the dragged side stays under the pointer.
 */
export function dragWidth(
  startWidth: number,
  dx: number,
  side: "left" | "right",
  centered: boolean,
  maxWidth: number,
): number {
  const outward = side === "right" ? dx : -dx;
  const width = startWidth + (centered ? 2 : 1) * outward;
  return Math.round(clamp(width, MIN_WIDTH, maxWidth));
}

/**
 * Works out the height of a dialog while its lower side is dragged.
 *
 * @param dy how far the pointer went down since the drag started
 */
export function dragHeight(
  startHeight: number,
  dy: number,
  maxHeight: number,
): number {
  return Math.round(clamp(startHeight + dy, MIN_HEIGHT, maxHeight));
}

/**
 * Works out how much of the height the results take while the line between
 * them and the preview is dragged. In a low dialog a share of the height is
 * too little to read, so neither of them gets less than `MIN_PANE` either.
 *
 * @param y where the pointer is
 * @param top where the results start
 * @param height the height of the results and the preview together
 */
export function dragSplit(y: number, top: number, height: number): number {
  if (height < 2 * MIN_PANE) {
    // Too low for both to get their least height. They share what there is.
    return 0.5;
  }
  const least = Math.max(MIN_SPLIT, MIN_PANE / height);
  const most = Math.min(MAX_SPLIT, 1 - MIN_PANE / height);
  const split = clamp((y - top) / height, least, most);
  return Math.round(split * 1000) / 1000;
}
