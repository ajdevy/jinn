import { describe, expect, it } from "vitest";
import {
  buildAntigravityHeadlessArgs,
  parseAntigravityStreamLine,
} from "../antigravity-headless.js";

describe("parseAntigravityStreamLine", () => {
  it("captures the conversation id from init without settling", () => {
    expect(parseAntigravityStreamLine(JSON.stringify({
      event: "init",
      conversation_id: "conversation-0",
      init: {
        model: "example-model",
        cwd: "/workspace",
        tools: ["manage_task"],
        permission_mode: "always-proceed",
      },
    }))).toEqual({
      conversationId: "conversation-0",
      deltas: [],
      terminal: false,
    });
  });

  it("treats an explicit upstream ERROR result as terminal", () => {
    expect(parseAntigravityStreamLine(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-1",
        status: "ERROR",
        response: "",
        error: "There was a network issue connecting to the server.",
        duration_seconds: 2.5,
        num_turns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    }))).toEqual({
      conversationId: "conversation-1",
      deltas: [],
      terminal: true,
      error: "There was a network issue connecting to the server.",
    });
  });

  it("treats an explicit upstream SUCCESS result as terminal", () => {
    expect(parseAntigravityStreamLine(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-2",
        status: "SUCCESS",
        response: "finished\n",
        duration_seconds: 9.3,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          thinking_tokens: 1,
          cache_read_tokens: 3,
          total_tokens: 12,
        },
      },
    }))).toEqual({
      conversationId: "conversation-2",
      deltas: [{ type: "context", content: "10" }],
      terminal: true,
      result: "finished\n",
      contextTokens: 10,
    });
  });

  it("maps managed-task ACTIVE and DONE updates to one tool lifecycle", () => {
    const active = parseAntigravityStreamLine(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-3",
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "manage_task",
        tool_info: {
          name: "manage_task",
          parameters: { Action: "status", TaskId: "conversation-3/task-1" },
        },
      },
    }));
    const done = parseAntigravityStreamLine(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-3",
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "manage_task",
        duration_seconds: 0.01,
        tool_info: {
          name: "manage_task",
          parameters: { Action: "status" },
          output: "Task completed.",
        },
      },
    }));

    expect(active).toEqual({
      conversationId: "conversation-3",
      deltas: [{
        type: "tool_use",
        content: "Using manage_task",
        toolName: "manage_task",
        toolId: "3",
      }],
      terminal: false,
    });
    expect(done).toEqual({
      conversationId: "conversation-3",
      deltas: [{
        type: "tool_result",
        content: "manage_task done",
        toolName: "manage_task",
        toolId: "3",
      }],
      terminal: false,
    });
  });
});

describe("buildAntigravityHeadlessArgs", () => {
  it("builds print-mode stream-json args and strips unrelated engine flags", () => {
    expect(buildAntigravityHeadlessArgs({
      prompt: "ignored",
      cwd: "/workspace",
      model: "example-model",
      resumeSessionId: "conversation-4",
      cliFlags: ["--chrome", "--verbose"],
    })).toEqual([
      "--conversation", "conversation-4",
      "--model", "example-model",
      "--dangerously-skip-permissions",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "-p",
    ]);
  });
});
