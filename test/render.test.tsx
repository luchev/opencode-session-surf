import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { SessionStatus } from "@opencode-ai/sdk";
import { registerSpinner } from "opentui-spinner/solid";
import { SessionRow, SPINNERS, WAITERS } from "../index.tsx";

registerSpinner();

const session = {
  id: "ses_123",
  projectID: "p",
  directory: "/Users/z/opencode-session-surf",
  title: "surfer",
  time: { created: 0, updated: 0 },
};
const theme = {
  text: "white",
  textMuted: "gray",
  accent: "yellow",
  info: "cyan",
  primary: "blue",
  success: "green",
} as unknown as Parameters<typeof SessionRow>[0]["theme"];
const status = (type: string) => ({ type }) as unknown as SessionStatus;

async function frameFor(node: () => unknown): Promise<string> {
  const t = await testRender(node, { width: 60, height: 3 });
  await t.renderOnce();
  return t.captureCharFrame();
}

describe("SessionRow", () => {
  test("busy row shows the working spinner frame and title", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        marker="●"
        waitingFrames={WAITERS.flash}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => true}
        status={() => status("busy")}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).toContain(SPINNERS.arc[0]);
    expect(frame).toContain("surfer");
  });

  test("current row shows the configured marker glyph", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={true}
        marker="✦"
        waitingFrames={[]}
        spinnerFrames={[]}
        waiting={() => false}
        working={() => false}
        status={() => undefined}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).toContain("✦");
    expect(frame).toContain("surfer");
  });

  test("waiting row shows the waiting frame", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        marker="●"
        waitingFrames={WAITERS.ellipsis}
        spinnerFrames={SPINNERS.arc}
        waiting={() => true}
        working={() => false}
        status={() => undefined}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).toContain(WAITERS.ellipsis[0]);
  });

  test("idle row shows no marker or spinner, title only", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        marker="●"
        waitingFrames={[]}
        spinnerFrames={[]}
        waiting={() => false}
        working={() => false}
        status={() => undefined}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("✦");
    expect(frame).toContain("surfer");
  });

  test("has-status row shows the • dot", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        marker="●"
        waitingFrames={[]}
        spinnerFrames={[]}
        waiting={() => false}
        working={() => false}
        status={() => status("idle")}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).toContain("•");
  });
});
