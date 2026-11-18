// The opencode TUI registers a <spinner frames interval color> element at
// runtime; this declares it for the type checker. test/spinner-shim.ts stands in
// for it under `bun test`.
import type { SpinnerShim } from "./test/spinner-shim.ts";

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    spinner: typeof SpinnerShim;
  }
}
