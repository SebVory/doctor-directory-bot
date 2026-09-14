import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { type MessagesClient, runTurn } from "../src/doctor-agent.js";

/** Minimal stand-in for one API response. */
function reply(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return { id: "msg", type: "message", role: "assistant", model: "test", content, stop_reason: stop, usage: {} } as unknown as Anthropic.Message;
}

function scripted(responses: Anthropic.Message[]): MessagesClient {
  let index = 0;
  return {
    messages: {
      create: async () => {
        const next = responses[index];
        index += 1;
        if (next === undefined) throw new Error("scripted client ran out of responses");
        return next;
      },
    },
  };
}

/** Every piece of assistant text in a message list, flattened. */
function assistantText(messages: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      out.push(message.content.trim());
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") out.push(block.text.trim());
    }
  }
  return out.filter((t) => t.length > 0);
}

describe("runTurn history", () => {
  // An unrecognised tool keeps this test free of the SQLite snapshot; the loop
  // and history bookkeeping are identical whichever tool is named.
  const preamble = { type: "text", text: "Podívám se na to." } as Anthropic.ContentBlock;
  const toolUse = { type: "tool_use", id: "t1", name: "no_such_tool", input: {} } as Anthropic.ContentBlock;
  const final = { type: "text", text: "Mám tři doktory Dumitrescu." } as Anthropic.ContentBlock;

  it("records text emitted alongside a tool call exactly once", async () => {
    const result = await runTurn("Hledám doktora Dumitresku", [], {
      trace: false,
      client: scripted([reply([preamble, toolUse], "tool_use"), reply([final], "end_turn")]),
    });

    const texts = assistantText(result.messages);
    expect(texts.filter((t) => t === "Podívám se na to.")).toHaveLength(1);
    expect(texts.filter((t) => t === "Mám tři doktory Dumitrescu.")).toHaveLength(1);
  });

  it("keeps filler out of the answer and returns it as preamble", async () => {
    // The model sometimes opens in English before the tool call; the caller must
    // hear only the Czech answer, and the filler belongs to the search phase.
    const english = { type: "text", text: "I'll look her up right away." } as Anthropic.ContentBlock;
    const result = await runTurn("Hledám doktora Dumitresku", [], {
      trace: false,
      client: scripted([reply([english, toolUse], "tool_use"), reply([final], "end_turn")]),
    });

    expect(result.answer).toBe("Mám tři doktory Dumitrescu.");
    expect(result.preamble).toBe("I'll look her up right away.");
    expect(result.answer).not.toContain("I'll look");
  });

  it("keeps a two-turn conversation free of repeated assistant text", async () => {
    const first = await runTurn("Hledám doktora Dumitresku", [], {
      trace: false,
      client: scripted([reply([preamble, toolUse], "tool_use"), reply([final], "end_turn")]),
    });
    const second = await runTurn("A jaký má telefon?", first.messages, {
      trace: false,
      client: scripted([reply([{ type: "text", text: "Telefon je 555." } as Anthropic.ContentBlock], "end_turn")]),
    });

    const texts = assistantText(second.messages);
    expect(texts).toHaveLength(new Set(texts).size);
    expect(texts).toEqual(["Podívám se na to.", "Mám tři doktory Dumitrescu.", "Telefon je 555."]);
    expect(second.answer).toBe("Telefon je 555.");
    expect(second.preamble).toBe("");
  });

  it("appends the fallback line when the model returns no text", async () => {
    const result = await runTurn("…", [], {
      trace: false,
      client: scripted([reply([], "end_turn")]),
    });
    expect(assistantText(result.messages)).toHaveLength(1);
    expect(result.answer).toMatch(/Omlouvám se/);
  });
});

describe("tool failures", () => {
  it("answers with the fallback line instead of throwing when the snapshot is missing", async () => {
    const previous = process.env["DOCTORS_DB"];
    process.env["DOCTORS_DB"] = "/nonexistent/path/doctors.sqlite";
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const search = { type: "tool_use", id: "t1", name: "find_doctors", input: { surname: "Rusu" } } as Anthropic.ContentBlock;
      const result = await runTurn("Hledám doktorku Rusu", [], {
        trace: false,
        client: scripted([reply([search], "tool_use"), reply([], "end_turn")]),
      });
      expect(result.answer).toMatch(/Omlouvám se/);
      expect(result.toolCalls.map((c) => c.name)).toEqual(["find_doctors"]);
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env["DOCTORS_DB"];
      else process.env["DOCTORS_DB"] = previous;
    }
  });
});

describe("time to first token", () => {
  it("is null when nothing streamed", async () => {
    // The scripted client has no stream(), so runTurn falls back to create().
    const result = await runTurn("Dobrý den", [], {
      trace: false,
      client: scripted([reply([{ type: "text", text: "Dobrý den." } as Anthropic.ContentBlock], "end_turn")]),
    });
    expect(result.ttft_ms).toBeNull();
    expect(result.answer).toBe("Dobrý den.");
  });

  it("is reported from the streamed call once tool results are in hand", async () => {
    // Second call streams; the fake emits one text delta before finishing.
    const toolUse = { type: "tool_use", id: "t1", name: "no_such_tool", input: {} } as Anthropic.ContentBlock;
    const final = reply([{ type: "text", text: "Mám ji." } as Anthropic.ContentBlock], "end_turn");
    let index = 0;
    const streaming = {
      messages: {
        create: async () => reply([toolUse], "tool_use"),
        stream: (_p: Anthropic.MessageCreateParamsNonStreaming) => ({
          on: (_e: "text", listener: (d: string) => void) => {
            listener("Mám");
            return undefined;
          },
          finalMessage: async () => {
            index += 1;
            return final;
          },
        }),
      },
    };
    const result = await runTurn("Hledám doktorku Rusu", [], { trace: false, client: streaming });
    expect(result.ttft_ms).not.toBeNull();
    expect(result.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(index).toBe(1);
  });
});
