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
        waitingFrames={WAITERS.emoji}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => true}
        status={() => status("busy")}
        theme={theme}
        onNavigate={() => {}}
        openElsewhere={false}
        inActive={false}
        combined={false}
      />
    ));
    expect(frame).toContain(SPINNERS.arc[0]);
    expect(frame).toContain(`${SPINNERS.arc[0]} surfer`); // spinner keeps its cell: space after it
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
        openElsewhere={false}
        inActive={false}
        combined={false}
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
        openElsewhere={false}
        inActive={false}
        combined={false}
      />
    ));
    expect(frame).toContain(WAITERS.ellipsis[0]);
    expect(frame).toContain(`${WAITERS.ellipsis[0]} surfer`); // spinner keeps its cell: space after it
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
        openElsewhere={false}
        inActive={false}
        combined={false}
      />
    ));
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("✦");
    expect(frame).toContain("surfer");
  });

  test("has-status row shows the • dot when enabled", async () => {
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
        openElsewhere={true}
        inActive={false}
        combined={false}
      />
    ));
    expect(frame).toContain("•");
  });

  test("has-status dot is hidden by default", async () => {
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
        openElsewhere={false}
        inActive={false}
        combined={false}
      />
    ));
    expect(frame).not.toContain("•");
    expect(frame).toContain("surfer");
  });

  test("title column is stable whether or not a spinner shows", async () => {
    const busy = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        marker="●"
        waitingFrames={[]}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => true}
        status={() => status("busy")}
        theme={theme}
        onNavigate={() => {}}
        openElsewhere={false}
        inActive={false}
        combined={false}
      />
    ));
    const idle = await frameFor(() => (
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
        openElsewhere={false}
        inActive={false}
        combined={false}
      />
    ));
    expect(busy.indexOf("surfer")).toBe(idle.indexOf("surfer"));
  });
});

describe("SessionRow combined mode (ping preset)", () => {
  test("current row shows the marker, never the spinner", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={true}
        inActive={true}
        marker="◉"
        waitingFrames={WAITERS.bell}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => true}
        status={() => status("busy")}
        theme={theme}
        onNavigate={() => {}}
        openElsewhere={false}
        combined={true}
      />
    ));
    expect(frame).toContain("◉");
    expect(frame).not.toContain(SPINNERS.arc[0]);
    expect(frame).toContain("surfer");
  });

  test("non-current working row shows the spinner, not the marker", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        inActive={true}
        marker="◉"
        waitingFrames={WAITERS.bell}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => true}
        status={() => status("busy")}
        theme={theme}
        onNavigate={() => {}}
        openElsewhere={false}
        combined={true}
      />
    ));
    expect(frame).toContain(SPINNERS.arc[0]);
    expect(frame).not.toContain("◉");
    expect(frame).toContain("surfer");
  });

  test("non-current idle Active row shows the • dot", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        inActive={true}
        marker="◉"
        waitingFrames={[]}
        spinnerFrames={[]}
        waiting={() => false}
        working={() => false}
        status={() => undefined}
        theme={theme}
        onNavigate={() => {}}
        openElsewhere={false}
        combined={true}
      />
    ));
    expect(frame).toContain("•");
    expect(frame).toContain("surfer");
  });

  test("non-current idle Recent row shows no dot", async () => {
    const frame = await frameFor(() => (
      <SessionRow
        s={session}
        isCurrent={false}
        inActive={false}
        marker="◉"
        waitingFrames={[]}
        spinnerFrames={[]}
        waiting={() => false}
        working={() => false}
        status={() => undefined}
        theme={theme}
        onNavigate={() => {}}
        openElsewhere={false}
        combined={true}
      />
    ));
    expect(frame).not.toContain("•");
    expect(frame).toContain("surfer");
  });
});
