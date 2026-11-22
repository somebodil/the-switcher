/** What a handle does while it is dragged with the mouse or a finger. */
export interface DragActions<T> {
  /** Called when the drag starts. What it returns is given to `move`. */
  start: () => T;
  /**
   * Called whenever the pointer moves.
   *
   * @param dx how far the pointer went to the right since the drag started
   * @param dy how far the pointer went down since the drag started
   */
  move: (from: T, dx: number, dy: number, evt: PointerEvent) => void;
  /** Called when the mouse button or the finger is let go */
  end: () => void;
  /** Called on a double click, to go back to what the handle was at first */
  reset: () => void;
}

/**
 * Makes an element a handle that is dragged with the main mouse button or a
 * finger. For a finger the element needs `touch-action: none` in its style, or
 * the app takes the drag for itself to scroll.
 */
export function makeDraggable<T>(el: HTMLElement, actions: DragActions<T>): void {
  // The input that is typed in keeps the focus when a handle is pressed
  el.addEventListener("mousedown", (evt) => evt.preventDefault());

  el.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) {
      return;
    }
    down.preventDefault();
    // The handle goes on getting the pointer when it is moved off the handle
    el.setPointerCapture(down.pointerId);
    el.addClass("is-dragged");
    const from = actions.start();

    const move = (evt: PointerEvent): void => {
      actions.move(from, evt.clientX - down.clientX, evt.clientY - down.clientY, evt);
    };
    const stop = (evt: PointerEvent): void => {
      // Where the pointer is let go is where the drag ends, and no move may
      // have told of that place. A drag that the app takes away has no such place.
      if (evt.type === "pointerup") {
        move(evt);
      }
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
      el.removeClass("is-dragged");
      actions.end();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
  });

  el.addEventListener("dblclick", (evt) => {
    evt.preventDefault();
    actions.reset();
  });
}
