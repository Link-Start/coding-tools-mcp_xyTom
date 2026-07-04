import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { formatBatonBundle } from "../baton/protocol.js";
import { markTuiAttached, type PermissionApprovalRequest } from "../shared/approvals.js";
import type { ConductorEvent, PermissionRequestEvent, ToolCallEvent } from "../shared/types.js";
import {
  findSlashCommand,
  parseCloseCommand,
  parseNewCommand,
  parseSlashCommand,
  parseTunnelCommand,
  slashCommands,
  suggestSlashCommands,
  type ParsedSlashCommand,
  type SlashCommand,
} from "./commands/registry.js";
import {
  advanceOnboarding,
  loadOnboardingState,
  onboardingDefault,
  onboardingPrompt,
  type OnboardingState,
} from "./onboarding.js";
import { TuiSessionController } from "./session-controller.js";
import { loadTuiSnapshot, type TuiSessionSummary, type TuiSnapshot } from "./state.js";

type ViewMode = "events" | "detail" | "diff" | "baton" | "help" | "approvals" | "config" | "messages";
type StreamEvent = ToolCallEvent | PermissionRequestEvent;

interface StatusMessage {
  ts: string;
  text: string;
}

interface DisplayLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const HISTORY_LIMIT = 50;
const MESSAGE_LIMIT = 100;

export function TuiApp({
  requestedSessionId,
  initialWorkspacePath,
}: {
  requestedSessionId?: string;
  initialWorkspacePath?: string;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const controller = useRef<TuiSessionController | undefined>(undefined);
  if (!controller.current) controller.current = new TuiSessionController();
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => emptySnapshot(initialWorkspacePath));
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(requestedSessionId);
  const [viewMode, setViewMode] = useState<ViewMode>("events");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<StatusMessage[]>(() => [
    { ts: new Date().toISOString(), text: "Ready. Type /help for commands." },
  ]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const historyDraft = useRef("");
  const [onboarding, setOnboarding] = useState<OnboardingState | undefined>();
  const [onboardingChoice, setOnboardingChoice] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [configText, setConfigText] = useState("No profile loaded.");
  const [tunnelMessage, setTunnelMessage] = useState(() => controller.current?.tunnelStatus().message ?? "tunnel:off");
  const [follow, setFollow] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [viewScroll, setViewScroll] = useState(0);
  const [approvalCursor, setApprovalCursor] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  const quitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const terminalRows = stdout?.rows ?? 24;
  const streamHeight = Math.max(6, terminalRows - 12);
  const panelHeight = Math.max(8, terminalRows - 10);

  const allStreamEvents = useMemo(() => [...snapshot.events].filter(isStreamEvent).reverse(), [snapshot.events]);
  const selectedIndex = useMemo(() => {
    if (follow || !selectedKey) return 0;
    const found = allStreamEvents.findIndex((event) => eventKey(event) === selectedKey);
    return found === -1 ? Math.min(0, allStreamEvents.length - 1) : found;
  }, [follow, selectedKey, allStreamEvents]);
  const selectedEvent = allStreamEvents[Math.max(0, Math.min(selectedIndex, allStreamEvents.length - 1))];
  const latestCheckpoint = snapshot.checkpoints.at(-1);
  const approvalQueue = useMemo(() => {
    const seen = new Set<string>();
    const queue: PermissionApprovalRequest[] = [];
    for (const approval of [...snapshot.pendingApprovals, ...snapshot.allPendingApprovals]) {
      if (seen.has(approval.id)) continue;
      seen.add(approval.id);
      queue.push(approval);
    }
    return queue;
  }, [snapshot.pendingApprovals, snapshot.allPendingApprovals]);
  const approvalVisible = approvalQueue.length > 0 && !onboarding;
  const activeApproval = approvalQueue[Math.min(approvalCursor, Math.max(approvalQueue.length - 1, 0))];
  const suggestions = useMemo(() => suggestSlashCommands(input), [input]);
  const activeSummary = snapshot.sessions.find((session) => session.sessionId === snapshot.sessionId);
  const message = messages.at(-1)?.text ?? "";

  const pushMessage = (text: string): void => {
    setMessages((items) => [...items, { ts: new Date().toISOString(), text }].slice(-MESSAGE_LIMIT));
  };

  useEffect(() => {
    if (requestedSessionId) return undefined;
    let cancelled = false;
    void loadOnboardingState(initialWorkspacePath).then((state) => {
      if (cancelled) return;
      setOnboarding(state);
      if (state) pushMessage("No profile found for this repo. Complete onboarding, then run /new.");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSessionId, initialWorkspacePath]);

  useEffect(() => {
    const current = controller.current;
    return () => {
      void current?.closeClients();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = controller.current?.onEvent(() => {
      setRefreshNonce((value) => value + 1);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const next = await loadTuiSnapshot({ requestedSessionId: activeSessionId, initialWorkspacePath });
      if (cancelled) return;
      setSnapshot(next);
      if (!activeSessionId && next.sessionId) setActiveSessionId(next.sessionId);
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeSessionId, initialWorkspacePath, refreshNonce]);

  useEffect(() => {
    if (!snapshot.sessionId) return undefined;
    void markTuiAttached(snapshot.sessionId);
    const interval = setInterval(() => void markTuiAttached(snapshot.sessionId ?? ""), 1000);
    return () => {
      clearInterval(interval);
    };
  }, [snapshot.sessionId]);

  useEffect(() => {
    if (!busy) return undefined;
    const interval = setInterval(() => setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length), 150);
    return () => {
      clearInterval(interval);
    };
  }, [busy]);

  useEffect(() => {
    setApprovalCursor((cursor) => Math.min(cursor, Math.max(approvalQueue.length - 1, 0)));
  }, [approvalQueue.length]);

  useEffect(() => {
    setViewScroll(0);
  }, [viewMode]);

  useEffect(() => {
    return () => {
      if (quitTimer.current) clearTimeout(quitTimer.current);
    };
  }, []);

  const armQuit = (): void => {
    if (quitArmed) {
      exit();
      return;
    }
    setQuitArmed(true);
    pushMessage(busy ? "A command is still running. Press q again to force quit." : "Press q again to quit.");
    if (quitTimer.current) clearTimeout(quitTimer.current);
    quitTimer.current = setTimeout(() => setQuitArmed(false), 2000);
  };

  const switchToSession = (sessionId: string): void => {
    setActiveSessionId(sessionId);
    setViewMode("events");
    setFollow(true);
    setSelectedKey(undefined);
  };

  const switchByOffset = (offset: number): void => {
    if (!snapshot.sessions.length) return;
    const currentIndex = Math.max(
      0,
      snapshot.sessions.findIndex((session) => session.sessionId === snapshot.sessionId),
    );
    const next = snapshot.sessions[(currentIndex + offset + snapshot.sessions.length) % snapshot.sessions.length];
    if (next) switchToSession(next.sessionId);
  };

  const moveSelection = (offset: number): void => {
    if (!allStreamEvents.length) return;
    const nextIndex = Math.max(0, Math.min(allStreamEvents.length - 1, selectedIndex + offset));
    const nextEvent = allStreamEvents[nextIndex];
    if (!nextEvent) return;
    setSelectedKey(eventKey(nextEvent));
    setFollow(false);
  };

  const resumeFollow = (): void => {
    setFollow(true);
    setSelectedKey(undefined);
  };

  const respondToApproval = (approved: boolean): void => {
    if (!activeApproval) return;
    void controller.current?.respondToApproval(activeApproval.sessionId, activeApproval.id, approved);
    pushMessage(`${approved ? "Approved" : "Denied"} ${activeApproval.id} (${activeApproval.sessionId}).`);
    setRefreshNonce((value) => value + 1);
  };

  const navigateHistory = (direction: -1 | 1): void => {
    if (!history.length) return;
    if (historyIndex === undefined) {
      if (direction === 1) return;
      historyDraft.current = input;
      const index = history.length - 1;
      setHistoryIndex(index);
      setInput(history[index] ?? "");
      return;
    }
    const next = historyIndex + direction;
    if (next < 0) return;
    if (next >= history.length) {
      setHistoryIndex(undefined);
      setInput(historyDraft.current);
      return;
    }
    setHistoryIndex(next);
    setInput(history[next] ?? "");
  };

  const completeCommand = (): void => {
    if (!input.startsWith("/") || !suggestions.length) return;
    const first = suggestions[0];
    if (!first) return;
    const parsed = parseSlashCommand(input);
    if (parsed && parsed.name === first.name && parsed.args.length) return;
    setInput(`/${first.name} `);
  };

  const handleInputChange = (value: string): void => {
    setHistoryIndex(undefined);
    setInput(value);
  };

  const submitInput = (value: string): void => {
    setHistoryIndex(undefined);
    if (onboarding) {
      void submitOnboarding(value);
      return;
    }
    void runCommand(value);
  };

  const onboardingOptions = onboarding ? optionsForStep(onboarding) : [];

  const submitOnboarding = async (value: string): Promise<void> => {
    if (!onboarding || busy) return;
    const typed = value.trim();
    const option = onboardingOptions[Math.min(onboardingChoice, Math.max(onboardingOptions.length - 1, 0))];
    if (!typed && option && option.requiresInput) {
      pushMessage(option.hint ?? "Type a value and press Enter.");
      return;
    }
    const answer = typed || option?.value || "";
    setInput("");
    setBusy(true);
    try {
      const next = await advanceOnboarding(onboarding, answer);
      setOnboardingChoice(0);
      if (next.complete) {
        setOnboarding(undefined);
        pushMessage(`Profile written for ${next.repoPath}. Run /new to open a workspace session.`);
      } else {
        setOnboarding(next);
        pushMessage(`${onboardingPrompt(next)} [${onboardingDefault(next)}]`);
      }
    } catch (error) {
      pushMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    setInput("");
    if (!trimmed) return;
    if (busy) {
      pushMessage("A TUI command is already running.");
      return;
    }
    setHistory((items) => {
      const next = items.filter((item) => item !== trimmed);
      return [...next, trimmed].slice(-HISTORY_LIMIT);
    });

    let parsed: ParsedSlashCommand | undefined;
    try {
      parsed = parseSlashCommand(trimmed);
    } catch (error) {
      pushMessage(errorMessage(error));
      return;
    }
    if (!parsed) {
      pushMessage("Only slash commands are supported in this TUI milestone.");
      return;
    }

    const command = findSlashCommand(parsed.name);
    if (!command) {
      pushMessage(`Unknown command ${parsed.raw}. Type /help to see available commands.`);
      return;
    }
    if (command.stage === "planned") {
      pushMessage(`${command.usage} is not wired into the TUI yet. ${command.description}`);
      return;
    }

    switch (command.name) {
      case "help":
        setViewMode("help");
        pushMessage("Showing TUI commands.");
        break;
      case "switch":
        runSwitchCommand(parsed.args);
        break;
      case "new":
        await runNewCommand(parsed.args);
        break;
      case "close":
        await runCloseCommand(parsed.args);
        break;
      case "merge":
        await runMergeCommand();
        break;
      case "tunnel":
        await runTunnelCommand(parsed.args);
        break;
      case "config":
        await runConfigCommand(parsed.args);
        break;
      case "diff":
        setViewMode("diff");
        pushMessage("Showing the latest recorded review checkpoint.");
        break;
      case "approvals":
        setViewMode("approvals");
        pushMessage("Showing pending approvals across attached sessions.");
        break;
      case "baton":
        setViewMode("baton");
        pushMessage("Showing baton state for the active session.");
        break;
      case "messages":
        setViewMode("messages");
        pushMessage("Showing recent status messages.");
        break;
      case "quit":
        exit();
        break;
      default:
        pushMessage(`${command.usage} is registered but not wired yet.`);
    }
  };

  const runNewCommand = async (args: string[]): Promise<void> => {
    setBusy(true);
    try {
      const parsedNew = parseNewCommand(args);
      const path = parsedNew.path ?? initialWorkspacePath;
      pushMessage(parsedNew.resume ? `Resuming ${parsedNew.resume}...` : "Opening workspace session...");
      const current = controller.current;
      if (!current) throw new Error("TUI session controller is not ready.");
      const result = await current.create({ path, mode: parsedNew.mode, resume: parsedNew.resume });
      setActiveSessionId(result.sessionId);
      setViewMode("events");
      pushMessage(result.message);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      pushMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runCloseCommand = async (args: string[]): Promise<void> => {
    if (!snapshot.sessionId) {
      pushMessage("No active session to close.");
      return;
    }
    setBusy(true);
    try {
      const parsedClose = parseCloseCommand(args);
      const current = controller.current;
      if (!current) throw new Error("TUI session controller is not ready.");
      const result = await current.close(snapshot.sessionId, { force: parsedClose.force });
      pushMessage(result.message);
      if (result.closed) setActiveSessionId(undefined);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      pushMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runMergeCommand = async (): Promise<void> => {
    if (!snapshot.sessionId) {
      pushMessage("No active session to merge.");
      return;
    }
    setBusy(true);
    try {
      const current = controller.current;
      if (!current) throw new Error("TUI session controller is not ready.");
      const result = await current.merge(snapshot.sessionId);
      pushMessage(result.message);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      pushMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runTunnelCommand = async (args: string[]): Promise<void> => {
    setBusy(true);
    try {
      const parsedTunnel = parseTunnelCommand(args);
      const current = controller.current;
      if (!current) throw new Error("TUI session controller is not ready.");
      if (parsedTunnel.action === "start") {
        const result = await current.startTunnel();
        setTunnelMessage(result.state.message);
        pushMessage(result.message);
      } else if (parsedTunnel.action === "stop") {
        const result = await current.stopTunnel();
        setTunnelMessage(result.state.message);
        pushMessage(result.message);
      } else {
        const state = current.tunnelStatus();
        setTunnelMessage(state.message);
        pushMessage(state.publicUrl ? `Tunnel: ${state.publicUrl}` : state.message);
      }
    } catch (error) {
      pushMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runConfigCommand = async (args: string[]): Promise<void> => {
    setBusy(true);
    try {
      const current = controller.current;
      if (!current) throw new Error("TUI session controller is not ready.");
      const result = await current.configure(initialWorkspacePath, args);
      setConfigText(result.text);
      setViewMode("config");
      pushMessage(result.changed ? "Profile updated." : "Showing profile.");
    } catch (error) {
      pushMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const runSwitchCommand = (args: string[]): void => {
    if (!snapshot.sessions.length) {
      pushMessage("No attached sessions found yet.");
      return;
    }
    const target = args[0];
    if (!target) {
      switchByOffset(1);
      return;
    }
    const numeric = Number.parseInt(target, 10);
    const session = Number.isInteger(numeric)
      ? snapshot.sessions[numeric - 1]
      : snapshot.sessions.find((item) => item.sessionId.includes(target) || item.label.includes(target));
    if (!session) {
      pushMessage(`No session matched ${target}.`);
      return;
    }
    switchToSession(session.sessionId);
  };

  useInput((inputChar, key) => {
    if (onboarding) {
      if (key.upArrow && !input) {
        setOnboardingChoice((choice) => Math.max(0, choice - 1));
        return;
      }
      if (key.downArrow && !input) {
        setOnboardingChoice((choice) => Math.min(Math.max(onboardingOptions.length - 1, 0), choice + 1));
        return;
      }
      if (key.return && !input) {
        void submitOnboarding("");
        return;
      }
      return;
    }
    if (approvalVisible) {
      if (inputChar === "y") {
        respondToApproval(true);
        return;
      }
      if (inputChar === "n") {
        respondToApproval(false);
        return;
      }
      if (key.leftArrow) {
        setApprovalCursor((cursor) => Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setApprovalCursor((cursor) => Math.min(approvalQueue.length - 1, cursor + 1));
        return;
      }
      return;
    }
    if (key.ctrl && /^[1-9]$/.test(inputChar)) {
      const next = snapshot.sessions[Number(inputChar) - 1];
      if (next) switchToSession(next.sessionId);
      return;
    }
    if (key.tab) {
      if (input.startsWith("/")) completeCommand();
      else if (!input) switchByOffset(1);
      return;
    }
    if (key.escape) {
      if (input) {
        setInput("");
        setHistoryIndex(undefined);
      } else if (viewMode !== "events") {
        setViewMode("events");
      } else if (!follow) {
        resumeFollow();
      }
      return;
    }
    if (key.upArrow) {
      navigateHistory(-1);
      return;
    }
    if (key.downArrow) {
      navigateHistory(1);
      return;
    }
    if (input) return;
    if (inputChar === "q") {
      armQuit();
      return;
    }
    if (inputChar === "?") {
      setViewMode("help");
      return;
    }
    if (inputChar === "d") {
      setViewMode((mode) => (mode === "diff" ? "events" : "diff"));
      return;
    }
    if (inputChar === "b") {
      setViewMode((mode) => (mode === "baton" ? "events" : "baton"));
      return;
    }
    if (viewMode === "events") {
      if (inputChar === "f") {
        resumeFollow();
        return;
      }
      if (inputChar === "k") {
        moveSelection(-1);
        return;
      }
      if (inputChar === "j") {
        moveSelection(1);
        return;
      }
      if (key.pageUp) {
        moveSelection(-streamHeight);
        return;
      }
      if (key.pageDown) {
        moveSelection(streamHeight);
        return;
      }
      if (key.return) {
        if (selectedEvent) setViewMode("detail");
        return;
      }
      return;
    }
    if (inputChar === "k" || key.pageUp) {
      setViewScroll((scroll) => Math.max(0, scroll - (key.pageUp ? panelHeight : 1)));
      return;
    }
    if (inputChar === "j" || key.pageDown) {
      setViewScroll((scroll) => scroll + (key.pageDown ? panelHeight : 1));
      return;
    }
    if (key.return && viewMode === "detail") {
      setViewMode("events");
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Tabs sessions={snapshot.sessions} activeSessionId={snapshot.sessionId} />
      {onboarding ? (
        <OnboardingView state={onboarding} options={onboardingOptions} choice={onboardingChoice} />
      ) : approvalVisible && activeApproval ? (
        <ApprovalModal approval={activeApproval} index={approvalCursor} total={approvalQueue.length} />
      ) : viewMode === "diff" ? (
        <ScrollPanel title="Recent Changes" lines={diffLines(latestCheckpoint)} scroll={viewScroll} height={panelHeight} />
      ) : viewMode === "baton" ? (
        <ScrollPanel title="Baton" lines={batonLines(snapshot)} scroll={viewScroll} height={panelHeight} />
      ) : viewMode === "detail" ? (
        <ScrollPanel title="Event Detail" lines={detailLines(selectedEvent)} scroll={viewScroll} height={panelHeight} />
      ) : viewMode === "help" ? (
        <ScrollPanel title="Commands" lines={helpLines()} scroll={viewScroll} height={panelHeight} />
      ) : viewMode === "approvals" ? (
        <ScrollPanel title="Pending Approvals" lines={approvalLines(approvalQueue)} scroll={viewScroll} height={panelHeight} />
      ) : viewMode === "config" ? (
        <ScrollPanel title="Profile" lines={textLines(configText)} scroll={viewScroll} height={panelHeight} />
      ) : viewMode === "messages" ? (
        <ScrollPanel title="Status Messages" lines={messageLines(messages)} scroll={viewScroll} height={panelHeight} />
      ) : (
        <EventStream
          events={allStreamEvents}
          selectedIndex={selectedIndex}
          height={streamHeight}
          follow={follow}
        />
      )}
      {onboarding || approvalVisible ? null : <CommandSuggestions input={input} suggestions={suggestions} />}
      <InputBar
        value={input}
        onChange={handleInputChange}
        onSubmit={submitInput}
        placeholder={onboarding ? onboardingDefault(onboarding) : "/"}
        focus={!approvalVisible}
      />
      <StatusBar
        snapshot={snapshot}
        activeSummary={activeSummary}
        tunnelMessage={tunnelMessage}
        message={busy ? `${SPINNER_FRAMES[spinnerFrame] ?? "|"} Working... ${message}` : message}
        hints={keyHints({ onboarding: Boolean(onboarding), approval: approvalVisible, viewMode, follow })}
      />
    </Box>
  );
}

interface OnboardingOption {
  label: string;
  value: string;
  requiresInput?: boolean;
  hint?: string;
}

function optionsForStep(state: OnboardingState): OnboardingOption[] {
  if (state.step === "backend") {
    return [
      { label: "stdio (default)", value: "stdio" },
      { label: "docker", value: "docker" },
      {
        label: "http(s) URL...",
        value: "",
        requiresInput: true,
        hint: "Type the remote MCP HTTP URL, for example http://127.0.0.1:8765/mcp, then press Enter.",
      },
    ];
  }
  if (state.step === "workspace") {
    return [
      { label: "worktree (default) - isolated git worktree per session", value: "worktree" },
      { label: "direct - edit the repo in place", value: "direct" },
    ];
  }
  return [
    { label: "safe (default) - ask before risky operations", value: "safe" },
    { label: "trusted - skip approval prompts", value: "trusted" },
  ];
}

function Tabs({ sessions, activeSessionId }: { sessions: TuiSessionSummary[]; activeSessionId?: string }): React.ReactElement {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold>ctc </Text>
      {sessions.length ? (
        sessions.slice(0, 9).map((session, index) => {
          const active = session.sessionId === activeSessionId;
          return (
            <React.Fragment key={session.sessionId}>
              <Text color={active ? "cyan" : undefined} bold={active}>
                [{index + 1}:{truncate(session.label, 18)}
                {session.mode === "worktree" ? " wt" : ""}
              </Text>
              {session.pendingApprovalCount ? (
                <Text color="yellow" bold>
                  {" "}({session.pendingApprovalCount} pending)
                </Text>
              ) : null}
              <Text color={active ? "cyan" : undefined} bold={active}>
                :{session.owner === "tui" ? "tui" : "attached"}]{" "}
              </Text>
            </React.Fragment>
          );
        })
      ) : (
        <Text dimColor>[no attached sessions]</Text>
      )}
    </Box>
  );
}

function EventStream({
  events,
  selectedIndex,
  height,
  follow,
}: {
  events: StreamEvent[];
  selectedIndex: number;
  height: number;
  follow: boolean;
}): React.ReactElement {
  if (!events.length) {
    return (
      <Box flexDirection="column" marginTop={1} minHeight={height}>
        <Text dimColor>No attached session events yet.</Text>
        <Text dimColor>Start with /new, /help, or connect a model client through ctc start for v1 attachment.</Text>
      </Box>
    );
  }
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(height / 2), events.length - height));
  const visible = events.slice(start, start + height);
  return (
    <Box flexDirection="column" marginTop={1} minHeight={height}>
      <Text dimColor>
        {follow ? "following latest" : "selection paused (f to follow)"} - {start + 1}-{start + visible.length} of {events.length}
      </Text>
      {visible.map((event, offset) => {
        const index = start + offset;
        return (
          <Text key={eventKey(event)} color={eventColor(event, index === selectedIndex)}>
            {index === selectedIndex ? ">" : " "} {formatStreamEvent(event)}
          </Text>
        );
      })}
    </Box>
  );
}

function ApprovalModal({
  approval,
  index,
  total,
}: {
  approval: PermissionApprovalRequest;
  index: number;
  total: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        Permission request {index + 1} of {total}
      </Text>
      <Text>
        session: <Text bold>{approval.sessionId}</Text>  requested: {timeOf(approval.createdAt)}
      </Text>
      <Text bold>Full arguments:</Text>
      <Text wrap="wrap">{approval.argsSummary}</Text>
      <Text color="yellow">y approve  n deny{total > 1 ? "  left/right switch request" : ""}</Text>
    </Box>
  );
}

function OnboardingView({
  state,
  options,
  choice,
}: {
  state: OnboardingState;
  options: OnboardingOption[];
  choice: number;
}): React.ReactElement {
  const steps: OnboardingState["step"][] = ["backend", "workspace", "permissions"];
  const stepNumber = steps.indexOf(state.step) + 1;
  return (
    <Box flexDirection="column" marginTop={1} minHeight={10}>
      <Text bold>Repo Onboarding</Text>
      <Text>Profile: {state.repoPath}</Text>
      <Text>
        Step {String(stepNumber)}/3: {onboardingPrompt(state)}
      </Text>
      {options.map((option, index) => (
        <Text key={option.label} color={index === choice ? "cyan" : undefined} bold={index === choice}>
          {index === choice ? ">" : " "} {option.label}
        </Text>
      ))}
      <Text dimColor>Up/Down to choose, Enter to accept. Or type a value and press Enter.</Text>
    </Box>
  );
}

function ScrollPanel({
  title,
  lines,
  scroll,
  height,
}: {
  title: string;
  lines: DisplayLine[];
  scroll: number;
  height: number;
}): React.ReactElement {
  const bodyHeight = Math.max(1, height - 2);
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const start = Math.min(scroll, maxScroll);
  const visible = lines.slice(start, start + bodyHeight);
  return (
    <Box flexDirection="column" marginTop={1} minHeight={height}>
      <Text bold>
        {title}
        {lines.length > bodyHeight ? (
          <Text dimColor>
            {"  "}({start + 1}-{start + visible.length} of {lines.length}, j/k scroll)
          </Text>
        ) : null}
      </Text>
      {visible.length ? (
        visible.map((line, index) => (
          <Text key={`${String(start + index)}-${line.text.slice(0, 24)}`} color={line.color} dimColor={line.dim} bold={line.bold}>
            {line.text || " "}
          </Text>
        ))
      ) : (
        <Text dimColor>Nothing to show.</Text>
      )}
    </Box>
  );
}

function diffLines(checkpoint: TuiSnapshot["checkpoints"][number] | undefined): DisplayLine[] {
  if (!checkpoint) return [{ text: "No review checkpoint recorded yet.", dim: true }];
  const lines: DisplayLine[] = [{ text: checkpoint.statSummary, bold: true }];
  const body = checkpoint.diff?.trimEnd();
  if (!body) {
    lines.push({ text: "No diff body recorded for the latest checkpoint.", dim: true });
    return lines;
  }
  for (const raw of body.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) lines.push({ text: raw, bold: true });
    else if (raw.startsWith("@@")) lines.push({ text: raw, color: "cyan" });
    else if (raw.startsWith("+")) lines.push({ text: raw, color: "green" });
    else if (raw.startsWith("-")) lines.push({ text: raw, color: "red" });
    else if (raw.startsWith("diff ")) lines.push({ text: raw, bold: true, color: "yellow" });
    else lines.push({ text: raw });
  }
  return lines;
}

function detailLines(event: StreamEvent | undefined): DisplayLine[] {
  if (!event) return [{ text: "No event selected.", dim: true }];
  const lines: DisplayLine[] = [
    { text: `type:      ${event.type}` },
    { text: `time:      ${event.ts}` },
  ];
  if (event.type === "tool_call") {
    lines.push({ text: `tool:      ${event.tool}` });
    lines.push({ text: `duration:  ${String(event.durationMs)}ms` });
    lines.push({ text: `status:    ${event.error ? "error" : "ok"}`, color: event.error ? "red" : "green" });
  } else {
    lines.push({ text: `state:     ${event.state}`, color: event.state === "pending" ? "yellow" : undefined });
  }
  lines.push({ text: "arguments:", bold: true });
  for (const chunk of wrapText(event.argsSummary, 100)) lines.push({ text: `  ${chunk}` });
  if (event.type === "tool_call" && event.error) {
    lines.push({ text: "error:", bold: true, color: "red" });
    for (const chunk of wrapText(String(event.error), 100)) lines.push({ text: `  ${chunk}`, color: "red" });
  }
  return lines;
}

function batonLines(snapshot: TuiSnapshot): DisplayLine[] {
  if (!snapshot.baton) return [{ text: "No baton workspace found for this session.", dim: true }];
  return formatBatonBundle(snapshot.baton)
    .trimEnd()
    .split("\n")
    .map((text) => ({ text }));
}

function approvalLines(approvals: PermissionApprovalRequest[]): DisplayLine[] {
  if (!approvals.length) return [{ text: "No pending approvals.", dim: true }];
  return approvals.map((approval) => ({
    text: `${timeOf(approval.createdAt)} ${approval.sessionId} ${approval.argsSummary}`,
    color: "yellow",
  }));
}

function messageLines(messages: StatusMessage[]): DisplayLine[] {
  if (!messages.length) return [{ text: "No messages yet.", dim: true }];
  return [...messages].reverse().map((item) => ({ text: `${timeOf(item.ts)} ${item.text}` }));
}

function textLines(text: string): DisplayLine[] {
  return text.split("\n").map((line) => ({ text: line }));
}

function helpLines(): DisplayLine[] {
  const available = slashCommands.filter((command) => command.stage === "available");
  const planned = slashCommands.filter((command) => command.stage === "planned");
  const lines: DisplayLine[] = available.map((command) => ({
    text: `${pad(command.usage, 40)} ${command.description}`,
  }));
  lines.push({ text: "Planned", bold: true });
  for (const command of planned) lines.push({ text: `${pad(command.usage, 40)} ${command.description}`, dim: true });
  lines.push({ text: "" });
  lines.push({ text: "Keys", bold: true });
  lines.push({ text: "  j/k or PgUp/PgDn   select event (pauses follow) / scroll views" });
  lines.push({ text: "  f                  resume following latest events" });
  lines.push({ text: "  Enter              open detail for the selected event" });
  lines.push({ text: "  Up/Down            command history" });
  lines.push({ text: "  Tab                complete slash command, or next session tab when empty" });
  lines.push({ text: "  Ctrl+1..9          jump to session tab" });
  lines.push({ text: "  y/n                answer the pending approval (modal only)" });
  lines.push({ text: "  Esc                clear input / back to events / resume follow" });
  lines.push({ text: "  q q                quit (press twice)" });
  return lines;
}

function keyHints({
  onboarding,
  approval,
  viewMode,
  follow,
}: {
  onboarding: boolean;
  approval: boolean;
  viewMode: ViewMode;
  follow: boolean;
}): string {
  if (onboarding) return "Up/Down choose  Enter accept  or type a value";
  if (approval) return "y approve  n deny  left/right queue";
  if (viewMode === "events") {
    return `j/k select  Enter detail  ${follow ? "" : "f follow  "}d diff  b baton  Tab session  Up history  ? help  qq quit`;
  }
  return "j/k scroll  Esc back  ? help  qq quit";
}

function CommandSuggestions({ input, suggestions }: { input: string; suggestions: SlashCommand[] }): React.ReactElement | null {
  if (!input.startsWith("/") || !suggestions.length) return null;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
      {suggestions.map((command, index) => (
        <Text key={command.name} color={command.stage === "planned" ? "gray" : index === 0 ? "cyan" : undefined}>
          {index === 0 ? "Tab> " : "     "}
          {pad(command.usage, 40)} {command.description}
        </Text>
      ))}
    </Box>
  );
}

function InputBar({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  focus: boolean;
}): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text>{"> "}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} focus={focus} />
    </Box>
  );
}

function StatusBar({
  snapshot,
  activeSummary,
  tunnelMessage,
  message,
  hints,
}: {
  snapshot: TuiSnapshot;
  activeSummary?: TuiSessionSummary;
  tunnelMessage: string;
  message: string;
  hints: string;
}): React.ReactElement {
  const workspace = snapshot.workspace?.activePath ?? snapshot.session?.workspacePath ?? snapshot.initialWorkspacePath ?? "no workspace";
  const mode = snapshot.workspace?.mode ?? snapshot.session?.defaultMode ?? "attached";
  const backend = snapshot.session?.backendStatus.connected ? "ok" : snapshot.session ? "disconnected" : "idle";
  const client = activeSummary?.owner === "tui" ? "tui-owned" : snapshot.sessionId ? "attached-v1" : "idle";
  return (
    <Box marginTop={1} borderStyle="single" paddingX={1} flexDirection="column">
      <Text>
        {mode} | backend:{backend} | client:{client} | {tunnelMessage} | {truncate(workspace, 64)}
      </Text>
      <Text dimColor>{message}</Text>
      <Text dimColor>{hints}</Text>
    </Box>
  );
}

function formatStreamEvent(event: StreamEvent): string {
  if (event.type === "permission_request") {
    return `${timeOf(event.ts)} approval ${event.state} ${truncate(event.argsSummary, 82)}`;
  }
  return `${timeOf(event.ts)} ${event.tool} ${truncate(event.argsSummary, 62)} ${String(event.durationMs)}ms ${event.error ? "x" : "ok"}`;
}

function eventColor(event: StreamEvent, selected: boolean): string | undefined {
  if (selected) return "cyan";
  if (event.type === "permission_request") return event.state === "pending" ? "yellow" : undefined;
  return event.error ? "red" : undefined;
}

function eventKey(event: StreamEvent): string {
  const tag = event.type === "tool_call" ? event.tool : event.state;
  return `${event.ts}|${event.type}|${tag}|${event.argsSummary.slice(0, 48)}`;
}

function isStreamEvent(event: ConductorEvent): event is StreamEvent {
  return event.type === "tool_call" || event.type === "permission_request";
}

function emptySnapshot(initialWorkspacePath?: string): TuiSnapshot {
  return {
    initialWorkspacePath,
    sessions: [],
    events: [],
    toolCalls: [],
    checkpoints: [],
    pendingApprovals: [],
    allPendingApprovals: [],
  };
}

function wrapText(value: string, width: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += width) chunks.push(value.slice(index, index + width));
  return chunks;
}

function timeOf(ts: string): string {
  return ts.slice(11, 19);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
