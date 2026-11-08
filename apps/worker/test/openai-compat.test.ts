import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAICompatClient } from "../src/openai-compat";

const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        // split one event across two reads, as a real network does
        const text = `${chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("")}data: [DONE]\n\n`;
        c.enqueue(enc.encode(text.slice(0, 37)));
        c.enqueue(enc.encode(text.slice(37)));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const params = {
  model: "gpt-6.1-sol",
  max_tokens: 500,
  system: [{ type: "text" as const, text: "be brief" }],
  messages: [{ role: "user" as const, content: "hello" }],
  output_config: {
    effort: "xhigh",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("openAICompatClient", () => {
  it("streams text snapshots and maps the request and the final message", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { model: "gpt-6.1-sol", choices: [{ delta: { content: '{"a":' } }] },
        { choices: [{ delta: { content: '"ok"}' }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = openAICompatClient({ baseURL: "https://relay.example/", apiKey: "k" });
    const stream = client.beta.messages.stream(params as never);
    const snaps: string[] = [];
    stream.on("text", (_d, s) => snaps.push(s));
    const msg = await stream.finalMessage();

    expect(snaps).toEqual(['{"a":', '{"a":"ok"}']);
    expect(msg.content).toEqual([{ type: "text", text: '{"a":"ok"}', citations: null }]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.model).toBe("gpt-6.1-sol");
    expect(msg.usage).toEqual({ input_tokens: 12, output_tokens: 5 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.reasoning_effort).toBe("high");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", strict: true, schema: params.output_config.format.schema },
    });
  });

  it("reports a length stop as max_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([{ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }])),
    );
    const msg = await openAICompatClient({ baseURL: "https://r", apiKey: "k" })
      .beta.messages.stream(params as never)
      .finalMessage();
    expect(msg.stop_reason).toBe("max_tokens");
  });

  it("raises the SDK's error classes, retrying only rate limits and 5xx", async () => {
    const bad = vi.fn(async () => new Response('{"error":{"message":"no"}}', { status: 400 }));
    vi.stubGlobal("fetch", bad);
    await expect(
      openAICompatClient({ baseURL: "https://r", apiKey: "k" })
        .beta.messages.stream(params as never)
        .finalMessage(),
    ).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(bad).toHaveBeenCalledTimes(1);

    const busy = vi.fn(async () => new Response("busy", { status: 429 }));
    vi.stubGlobal("fetch", busy);
    await expect(
      openAICompatClient({ baseURL: "https://r", apiKey: "k", maxRetries: 1 })
        .beta.messages.stream(params as never)
        .finalMessage(),
    ).rejects.toBeInstanceOf(Anthropic.RateLimitError);
    expect(busy).toHaveBeenCalledTimes(2);
  });
});
