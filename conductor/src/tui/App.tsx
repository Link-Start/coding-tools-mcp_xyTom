import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { formatBatonBundle } from "../baton/protocol.js";
import { markTuiAttached, respondToApproval } from "../shared/approvals.js";
import type { ToolCallEvent } from "../shared/types.js";
import { loadTuiSnapshot, type TuiSnapshot } from "./state.js";

type ViewMode = "events" | "detail" | "diff" | "baton";

export function TuiApp({ requestedSessionId }: { requestedSessionId?: string }): React.ReactElement {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<TuiSnapshot>({ events: [], toolCalls: [], checkpoints: [], pendingApprovals: [] });
  const [selected, setSelected] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("events");
  const visibleCalls = useMemo(() => [...snapshot.toolCalls].reverse().slice(0, 12), [snapshot.toolCalls]);
  const selectedCall = visibleCalls[Math.min(selected, Math.max(visibleCalls.length - 1, 0))];
  const latestCheckpoint = snapshot.checkpoints.at(-1);
  const pendingApproval = snapshot.pendingApprovals[0];

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const next = await loadTuiSnapshot(requestedSessionId);
      if (!cancelled) setSnapshot(next);
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [requestedSessionId]);

  useEffect(() => {
    if (!snapshot.sessionId) return undefined;
    void markTuiAttached(snapshot.sessionId);
    const interval = setInterval(() => void markTuiAttached(snapshot.sessionId ?? ""), 1000);
    return () => {
      clearInterval(interval);
    };
  }, [snapshot.sessionId]);

  useInput((input, key) => {
    if (input === "q") exit();
    if (pendingApproval && snapshot.sessionId && (input === "y" || input === "n")) {
      void respondToApproval(snapshot.sessionId, pendingApproval.id, input === "y");
      return;
    }
    if (input === "d") setViewMode((mode) => (mode === "diff" ? "events" : "diff"));
    if (input === "b") setViewMode((mode) => (mode === "baton" ? "events" : "baton"));
    if (key.return) setViewMode((mode) => (mode === "detail" ? "events" : "detail"));
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelected((value) => Math.min(Math.max(visibleCalls.length - 1, 0), value + 1));
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header snapshot={snapshot} />
      {pendingApproval ? <ApprovalPanel request={pendingApproval} /> : null}
      {viewMode === "diff" ? (
        <DiffView checkpoint={latestCheckpoint} />
      ) : viewMode === "baton" ? (
        <BatonView snapshot={snapshot} />
      ) : viewMode === "detail" ? (
        <DetailView event={selectedCall} />
      ) : (
        <ToolStream calls={visibleCalls} selected={selected} />
      )}
      <Footer viewMode={viewMode} />
    </Box>
  );
}

function Header({ snapshot }: { snapshot: TuiSnapshot }): React.ReactElement {
  const workspace = snapshot.workspace?.activePath ?? snapshot.session?.workspacePath ?? "no session log found";
  const mode = snapshot.workspace?.mode ?? snapshot.session?.defaultMode ?? "unknown";
  const backend = snapshot.session?.backendStatus.connected ? "connected" : snapshot.session ? "disconnected" : "unknown";
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Coding Tools Conductor</Text>
      <Text>session: {snapshot.sessionId ?? "waiting"}</Text>
      <Text>workspace: {truncate(workspace, 96)}</Text>
      <Text>
        mode: {mode}  backend: {backend}  calls: {snapshot.toolCalls.length}
      </Text>
    </Box>
  );
}

function ApprovalPanel({ request }: { request: { argsSummary: string } }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>Permission request pending</Text>
      <Text>{truncate(request.argsSummary, 140)}</Text>
      <Text>press y to forward, n to deny</Text>
    </Box>
  );
}

function ToolStream({ calls, selected }: { calls: ToolCallEvent[]; selected: number }): React.ReactElement {
  if (!calls.length) {
    return <Box marginTop={1}><Text dimColor>No tool calls recorded yet.</Text></Box>;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {calls.map((call, index) => (
        <Text key={`${call.ts}-${call.tool}-${String(index)}`} color={call.error ? "red" : index === selected ? "cyan" : undefined}>
          {index === selected ? ">" : " "} {timeOf(call.ts)} {call.tool} {truncate(call.argsSummary, 72)} {call.durationMs}ms {call.error ? "x" : "ok"}
        </Text>
      ))}
    </Box>
  );
}

function DetailView({ event }: { event?: ToolCallEvent }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Tool Detail</Text>
      <Text>{event ? JSON.stringify(event, null, 2) : "No tool call selected."}</Text>
    </Box>
  );
}

function DiffView({ checkpoint }: { checkpoint: TuiSnapshot["checkpoints"][number] | undefined }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Recent show_changes</Text>
      {checkpoint ? (
        <>
          <Text>{checkpoint.statSummary}</Text>
          <Text>{checkpoint.diff?.trimEnd() || "No diff body recorded for the latest checkpoint."}</Text>
        </>
      ) : (
        <Text dimColor>No review checkpoint recorded yet.</Text>
      )}
    </Box>
  );
}

function BatonView({ snapshot }: { snapshot: TuiSnapshot }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Baton</Text>
      <Text>{snapshot.baton ? formatBatonBundle(snapshot.baton).trimEnd() : "No baton workspace found for this session."}</Text>
    </Box>
  );
}

function Footer({ viewMode }: { viewMode: ViewMode }): React.ReactElement {
  return (
    <Box marginTop={1} borderStyle="single" paddingX={1}>
      <Text>view: {viewMode}  up/down select  enter detail  d diff  b baton  q quit</Text>
    </Box>
  );
}

function timeOf(ts: string): string {
  return ts.slice(11, 19);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
