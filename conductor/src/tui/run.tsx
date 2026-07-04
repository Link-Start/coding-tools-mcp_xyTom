import React from "react";
import { render } from "ink";
import { TuiApp } from "./App.js";

export interface RunTuiOptions {
  requestedSessionId?: string;
  initialWorkspacePath?: string;
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const app = render(
    <TuiApp requestedSessionId={options.requestedSessionId} initialWorkspacePath={options.initialWorkspacePath} />,
  );
  await app.waitUntilExit();
}
