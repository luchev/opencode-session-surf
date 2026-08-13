/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { SessionStatus } from "@opencode-ai/sdk";
import { registerSpinner } from "opentui-spinner/solid";
import { PickerList, SessionRow, ChildRow, SPINNERS, WAITERS } from "../index.tsx";

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

describe("ChildRow", () => {
  const child = { id: "ses_child", parentID: "ses_123", title: "delegation", updated: 0 };
  test("working child shows its own spinner frame and title", async () => {
    const frame = await frameFor(() => (
      <ChildRow
        child={child}
        waitingFrames={[]}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => true}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).toContain(SPINNERS.arc[0]);
    expect(frame).toContain("delegation");
  });

  test("waiting child shows the waiting frame", async () => {
    const frame = await frameFor(() => (
      <ChildRow
        child={child}
        waitingFrames={WAITERS.pulse}
        spinnerFrames={SPINNERS.arc}
        waiting={() => true}
        working={() => false}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).toContain(WAITERS.pulse[0]);
    expect(frame).toContain("delegation");
  });

  test("idle child shows no spinner, just the title", async () => {
    const frame = await frameFor(() => (
      <ChildRow
        child={child}
        waitingFrames={WAITERS.pulse}
        spinnerFrames={SPINNERS.arc}
        waiting={() => false}
        working={() => false}
        theme={theme}
        onNavigate={() => {}}
      />
    ));
    expect(frame).not.toContain(SPINNERS.arc[0]);
    expect(frame).not.toContain(WAITERS.pulse[0]);
    expect(frame).toContain("delegation");
  });
});

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

const pickerTheme = {
  text: "white",
  textMuted: "gray",
  info: "cyan",
  primary: "blue",
  success: "green",
  error: "red",
  selectedListItemText: "black",
} as unknown as Parameters<typeof PickerList>[0]["theme"];

function makeSessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ses_${i}`,
    projectID: "p",
    directory: "/tmp/x",
    title: `row-${String(i).padStart(3, "0")}`,
    time: { created: 0, updated: 0 },
  }));
}

type PickerOpts = {
  width?: number;
  density?: "compact" | "comfortable";
  sessions?: ReturnType<typeof makeSessions>;
  viewport?: { width: number; height: number };
};

async function pickerFrame(index: number, height: number, total: number, opts: PickerOpts = {}): Promise<string> {
  const sessions = opts.sessions ?? makeSessions(total);
  const width = opts.width ?? 56;
  const t = await testRender(
    () => (
      <PickerList
        sessions={() => sessions}
        index={() => index}
        statuses={new Map()}
        height={() => height}
        width={width}
        density={opts.density ?? "compact"}
        theme={pickerTheme}
        onSelect={() => {}}
      />
    ),
    // the list box fills its parent (width "100%"), so the viewport width IS the
    // measured row width — keep it equal to `width` for deterministic truncation
    opts.viewport ?? { width, height: height + 2 },
  );
  await t.renderOnce();
  return t.captureCharFrame();
}

describe("PickerList autoscroll centering", () => {
  test("selection near the top: window stays at the top", async () => {
    const frame = await pickerFrame(2, 10, 100);
    expect(frame).toContain("row-000");
    expect(frame).toContain("row-002");
    expect(frame).not.toContain("row-050");
  });

  test("selection in the middle: window centers on the selection", async () => {
    const frame = await pickerFrame(50, 10, 100);
    // scrollTop = 45 -> rows 45..54 visible, 0 scrolled away
    expect(frame).toContain("row-050");
    expect(frame).not.toContain("row-000");
    expect(frame).not.toContain("row-099");
  });

  test("selection near the bottom: window pins to the bottom", async () => {
    const frame = await pickerFrame(99, 10, 100);
    expect(frame).toContain("row-099");
    expect(frame).not.toContain("row-000");
    expect(frame).not.toContain("row-050");
  });

  test("no scroll when everything fits", async () => {
    const frame = await pickerFrame(4, 10, 5);
    expect(frame).toContain("row-000");
    expect(frame).toContain("row-004");
  });
});

describe("PickerList density", () => {
  const longName = [
    {
      id: "ses_long",
      projectID: "p",
      directory: "/Users/z/.dotfiles",
      title: "OpenCode side panel and plugin enablement work session",
      time: { created: 0, updated: 0 },
    },
  ];

  test("compact keeps a two-space gap between a long name and the age", async () => {
    const frame = await pickerFrame(0, 3, 1, { sessions: longName, width: 40 });
    // name is ellipsized and separated from the meta by at least two spaces
    expect(frame).toContain("…");
    expect(frame).toMatch(/…\s{2,}\d/); // "…" then >=2 spaces then age digit
  });

  test("compact right-aligns the age/dir for a short name (space-between)", async () => {
    const shortName = [
      {
        id: "ses_s",
        projectID: "p",
        directory: "/tmp/proj",
        title: "hi",
        time: { created: 0, updated: 0 },
      },
    ];
    const frame = await pickerFrame(0, 3, 1, { sessions: shortName, width: 40 });
    const line = frame.split("\n").find((l) => l.includes("hi")) ?? "";
    // name at the far left, meta pushed to the far right -> a wide gap, not stuck
    expect(line).toMatch(/^hi\s{5,}/); // many spaces after the short name
    expect(line).toContain("/tmp/proj");
    // meta stays within the row width, not spilling past it
    expect(line.trimEnd().length).toBeLessThanOrEqual(40);
  });

  test("compact truncates an over-long name with an ellipsis", async () => {
    const frame = await pickerFrame(0, 3, 1, { sessions: longName, width: 40 });
    expect(frame).toContain("OpenCode");
    expect(frame).not.toContain("work session");
    expect(frame).toContain("…");
  });

  test("comfortable renders two lines: name on the first, age + dir on the second", async () => {
    const frame = await pickerFrame(0, 4, 1, {
      sessions: longName,
      density: "comfortable",
      width: 50,
    });
    const lines = frame.split("\n");
    const nameLine = lines.findIndex((l) => l.includes("OpenCode side"));
    expect(nameLine).toBeGreaterThanOrEqual(0);
    // the age/dir line sits directly below the name line
    const metaLine = lines[nameLine + 1];
    expect(metaLine).toContain("dotfiles");
    // the name line itself carries no directory
    expect(lines[nameLine]).not.toContain("dotfiles");
  });

  test("comfortable ellipsizes a name longer than the row", async () => {
    const frame = await pickerFrame(0, 4, 1, {
      sessions: longName,
      density: "comfortable",
      width: 20,
    });
    expect(frame).toContain("…");
    expect(frame).not.toContain("enablement");
    // nothing spills past the row width
    for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(20);
  });

  test("comfortable shows half as many sessions per line budget", async () => {
    // height 8 lines, 2 lines per row -> 4 sessions visible
    const frame = await pickerFrame(0, 8, 100, { density: "comfortable", viewport: { width: 60, height: 10 } });
    expect(frame).toContain("row-000");
    expect(frame).toContain("row-003");
    expect(frame).not.toContain("row-004");
  });

  test("dir never spills past the dialog when the width estimate is too large", async () => {
    // simulates the real app before measurement lands: passed width (200) far
    // exceeds the actual dialog width (viewport 30). Rows fill 100% so nothing
    // may render past column 30, in either density.
    for (const density of ["compact", "comfortable"] as const) {
      const frame = await pickerFrame(0, 6, 1, {
        sessions: longName,
        density,
        width: 200,
        viewport: { width: 30, height: 8 },
      });
      for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(30);
    }
  });
});
