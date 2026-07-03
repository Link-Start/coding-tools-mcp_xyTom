import React from "react";
import { render } from "ink";
import { TuiApp } from "./App.js";

export async function runTui(sessionId?: string): Promise<void> {
  const app = render(<TuiApp requestedSessionId={sessionId} />);
  await app.waitUntilExit();
}
