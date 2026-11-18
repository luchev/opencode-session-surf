import { TextRenderable } from "@opentui/core";
import type { RenderContext, TextOptions } from "@opentui/core";
import { extend } from "@opentui/solid";

export type SpinnerShimOptions = Omit<TextOptions, "content"> & {
  frames: string[];
  interval: number;
  color?: TextOptions["fg"];
};

// Stand-in for the host's <spinner> element: the opencode TUI registers its own
// at runtime, but a bare test renderer has none. Renders the first frame.
export class SpinnerShim extends TextRenderable {
  constructor(ctx: RenderContext, options: SpinnerShimOptions) {
    super(ctx, { ...options, content: options.frames?.[0] ?? " ", fg: options.color });
  }

  set frames(value: string[]) {
    this.content = value[0] ?? " ";
  }

  set interval(_value: number) {}

  set color(value: TextOptions["fg"]) {
    this.fg = value;
  }
}

export function registerSpinnerShim(): void {
  extend({ spinner: SpinnerShim });
}
