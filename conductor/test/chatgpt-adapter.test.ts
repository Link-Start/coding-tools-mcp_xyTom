import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  chatGptWidgetMimeType,
  decorateToolsForChatGpt,
  isChatGptAdapterEnabled,
  listChatGptWidgetResources,
  readChatGptWidgetResource,
} from "../src/adapters/chatgpt/widgets.js";

describe("ChatGPT adapter", () => {
  it("is disabled unless the profile opts in", () => {
    expect(isChatGptAdapterEnabled(undefined)).toBe(false);
    expect(isChatGptAdapterEnabled([])).toBe(false);
    expect(isChatGptAdapterEnabled(["chatgpt"])).toBe(true);
  });

  it("adds Apps SDK metadata only to high-value conductor tools", () => {
    const tools: Tool[] = [tool("show_changes"), tool("open_workspace"), tool("baton_update_status"), tool("server_info")];
    const decorated = decorateToolsForChatGpt(tools);

    expect(decorated.find((item) => item.name === "show_changes")?._meta?.["openai/outputTemplate"]).toBe(
      "ui://ctc/show_changes.html",
    );
    expect(decorated.find((item) => item.name === "open_workspace")?._meta?.["openai/outputTemplate"]).toBe(
      "ui://ctc/open_workspace.html",
    );
    expect(decorated.find((item) => item.name === "baton_update_status")?._meta?.["openai/outputTemplate"]).toBe(
      "ui://ctc/baton_status.html",
    );
    expect(decorated.find((item) => item.name === "show_changes")?.outputSchema).toMatchObject({ type: "object" });
    expect(decorated.find((item) => item.name === "server_info")?._meta).toBeUndefined();
  });

  it("serves self-contained widget resources", () => {
    const resources = listChatGptWidgetResources();
    expect(resources).toHaveLength(3);
    expect(resources.map((resource) => resource.uri)).toContain("ui://ctc/show_changes.html");

    const resource = readChatGptWidgetResource("ui://ctc/show_changes.html");
    const content = resource.contents[0];
    expect(content?.mimeType).toBe(chatGptWidgetMimeType);
    expect(content).toMatchObject({ uri: "ui://ctc/show_changes.html" });
    expect(content && "text" in content ? content.text : "").toContain("Review checkpoint");
    expect(content?._meta?.["openai/widgetDescription"]).toContain("review checkpoint");
  });
});

function tool(name: string): Tool {
  return { name, inputSchema: { type: "object", properties: {} } };
}
