import { describe, expect, it } from "vitest";
import { parseCloudflaredUrl } from "../src/tunnel/manager.js";

describe("TunnelManager", () => {
  it("parses trycloudflare URLs from cloudflared output", () => {
    expect(parseCloudflaredUrl("INFO https://example.trycloudflare.com is ready")).toBe(
      "https://example.trycloudflare.com",
    );
    expect(parseCloudflaredUrl("no tunnel yet")).toBeUndefined();
  });
});
