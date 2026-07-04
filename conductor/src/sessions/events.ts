import { EventEmitter } from "node:events";
import { JsonlEventLog } from "../shared/logging.js";
import type { ConductorEvent } from "../shared/types.js";

export type SessionEvent = ConductorEvent;

export interface SessionEventSink {
  readonly path?: string;
  append(event: SessionEvent): Promise<void>;
}

export class JsonlSessionEventSink implements SessionEventSink {
  constructor(private readonly log: JsonlEventLog) {}

  get path(): string {
    return this.log.path;
  }

  async append(event: SessionEvent): Promise<void> {
    await this.log.append(event);
  }
}

export class CompositeSessionEventSink implements SessionEventSink {
  constructor(private readonly sinks: SessionEventSink[]) {}

  get path(): string | undefined {
    return this.sinks.find((sink) => sink.path)?.path;
  }

  async append(event: SessionEvent): Promise<void> {
    for (const sink of this.sinks) await sink.append(event);
  }
}

export class SessionEventBus extends EventEmitter implements SessionEventSink {
  private readonly buffers = new Map<string, SessionEvent[]>();

  constructor(private readonly maxEvents = 2000) {
    super();
  }

  async append(event: SessionEvent): Promise<void> {
    const current = this.buffers.get(event.sessionId) ?? [];
    current.push(event);
    if (current.length > this.maxEvents) current.splice(0, current.length - this.maxEvents);
    this.buffers.set(event.sessionId, current);
    this.emit("event", event);
    this.emit(`event:${event.sessionId}`, event);
  }

  events(sessionId: string): SessionEvent[] {
    return [...(this.buffers.get(sessionId) ?? [])];
  }

  sessions(): string[] {
    return [...this.buffers.keys()];
  }
}
