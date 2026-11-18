/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { MoveDialog } from "../tui.tsx";

type Command = { id: string; bind?: string; palette?: boolean; run: () => unknown };
type Layer = { mode?: string; priority?: number; commands: Command[] };

const themeLeaf = { base: "c", muted: "c", selected: "c" };
const baseTheme = {
  text: { base: "c", muted: "c", feedback: { info: themeLeaf, success: themeLeaf, error: themeLeaf }, action: { primary: themeLeaf } },
  hue: { accent: { 200: "c" } },
  background: { action: { primary: themeLeaf } },
};
const theme = { ...baseTheme, surface: () => baseTheme };

function fakeContext(extra: Record<string, unknown> = {}) {
  const slots: { append?: string; render: (input: { sessionID: string }) => JSX.Element }[] = [];
  const layers: Array<() => Layer> = [];
  const toasts: { variant?: string; message: string }[] = [];
  const navigations: unknown[] = [];
  const calls: string[] = [];
  const ctx = {
    options: {},
    theme,
    client: { session: { list: async () => ({ data: [], cursor: { next: null } }) } },
    data: {
      on: () => () => {},
      session: { status: () => "idle", permission: { list: () => undefined }, form: { list: () => undefined }, get: () => undefined },
    },
    keymap: { layer: (factory: () => Layer) => layers.push(factory), shortcuts: () => [] },
    ui: {
      slot: (claim: (typeof slots)[number]) => slots.push(claim),
      toast: { show: (t: { variant?: string; message: string }) => toasts.push(t) },
      router: { navigate: (d: unknown) => navigations.push(d), current: () => ({ type: "home" }) },
      dialog: { clear: () => calls.push("clear"), show: () => {}, set: () => {} },
    },
    ...extra,
  };
  return { ctx: ctx as never, slots, layers, toasts, navigations, calls };
}

describe("plugin setup", () => {
  test("is a v2 plugin definition", () => {
    expect(plugin.id).toBe("opencode-session-surf");
    expect(typeof plugin.setup).toBe("function");
  });

  test("claims the sidebar slot and registers the four global commands", async () => {
    const { ctx, slots, layers } = fakeContext();
    const cleanup = (await plugin.setup(ctx)) as () => void;
    expect(slots.map((s) => s.append)).toEqual(["sidebar.content"]);
    expect(layers).toHaveLength(1);
    const layer = layers[0]();
    expect(layer.priority).toBe(10);
    expect(layer.commands.map((c) => [c.id, c.bind])).toEqual([
      ["session_surf.picker.open", "ctrl+o"],
      ["session_surf.next", "<leader>j"],
      ["session_surf.previous", "<leader>k"],
      ["session_surf.chdir", "<leader>d"],
    ]);
    expect(layer.commands.every((c) => c.palette === true)).toBe(true);
    cleanup();
  });

  test("the cleanup removes this process's status file", async () => {
    const { ctx } = fakeContext();
    const dir = join(tmpdir(), "opencode-session-surf-status");
    const cleanup = (await plugin.setup(ctx)) as () => void;
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(dir)).toContain(`${process.pid}.json`);
    cleanup();
    expect(readdirSync(dir)).not.toContain(`${process.pid}.json`);
  });
});

describe("MoveDialog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setup(session: { move: (input: unknown) => Promise<void> } & Record<string, unknown>) {
    const real = mkdtempSync(join(tmpdir(), "surf-move-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    dirs.push(real, link);
    const fake = fakeContext({ client: { session } });
    const state = {
      roots: () => [{ id: "ses_1", projectID: "p", directory: link, title: "t", time: { created: 0, updated: 0 } }],
      refresh: async () => {},
    };
    const t = await testRender(() => <MoveDialog ctx={fake.ctx} state={state as never} id="ses_1" />, { width: 60, height: 12 });
    await t.renderOnce();
    const layer = fake.layers[0]();
    const confirm = layer.commands.find((c) => c.id === "session_surf.chdir.confirm")!;
    return { fake, real, confirm, layer };
  }

  test("the dialog layer is modal and binds tab, return and escape", async () => {
    const { layer } = await setup({ move: async () => {} });
    expect(layer.mode).toBe("modal");
    expect(layer.commands.map((c) => c.bind)).toEqual(["tab", "return", "escape"]);
  });

  test("confirm moves the session once, to the canonical path, without forking or deleting", async () => {
    const moves: unknown[] = [];
    const session = {
      move: async (input: unknown) => void moves.push(input),
      fork: async () => {
        throw new Error("fork must not be called");
      },
      remove: async () => {
        throw new Error("remove must not be called");
      },
    };
    const { fake, real, confirm } = await setup(session);
    confirm.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(moves).toEqual([{ sessionID: "ses_1", directory: realpathSync(real) }]);
    expect(fake.toasts.at(-1)?.variant).toBe("info");
    expect(fake.navigations).toEqual([{ type: "session", sessionID: "ses_1" }]);
  });

  test("a rejected move shows an error toast and leaves the dialog open", async () => {
    const { fake, confirm } = await setup({
      move: async () => {
        throw new Error("session is busy");
      },
    });
    confirm.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.toasts.at(-1)).toEqual({ variant: "error", message: "Move failed: session is busy" });
    expect(fake.calls).not.toContain("clear");
  });
});
