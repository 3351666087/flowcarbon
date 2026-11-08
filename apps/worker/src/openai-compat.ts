import Anthropic from "@anthropic-ai/sdk";

/**
 * A stand-in for the part of the Anthropic client the worker uses (`client.beta.messages.stream`), backed by an
 * OpenAI-compatible chat-completions endpoint. It exists so the AI features keep working through a relay that only
 * speaks that format (AI_PROVIDER=openai-compatible). Same contract as the SDK stream: `on("text", (delta, snapshot))`,
 * `finalMessage()` resolving to a message with one text block, `usage`, `stop_reason` and `model`, and `abort()`.
 *
 * Mapped: system blocks and user messages to chat messages, `max_tokens`, `output_config.format` (a strict JSON schema)
 * to `response_format`, `output_config.effort` to `reasoning_effort`. Dropped, because the endpoint has no equivalent:
 * Anthropic betas, server-side fallbacks and cache_control. HTTP errors are raised as the SDK's own error classes, so
 * the callers' retry rules (rate limits and 5xx retry, other 4xx do not) apply unchanged.
 */

type TextListener = (delta: string, snapshot: string) => void;

interface StreamParams {
  model: string;
  max_tokens: number;
  system?: string | { type: "text"; text: string }[];
  messages: { role: "user" | "assistant"; content: string | { type: string; text?: string }[] }[];
  output_config?: { effort?: string; format?: { type: string; schema?: unknown } };
}

const EFFORT: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const textOf = (c: StreamParams["messages"][number]["content"]) =>
  typeof c === "string" ? c : c.map((b) => b.text ?? "").join("");

export interface OpenAICompatOptions {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

class CompatStream {
  private listeners: TextListener[] = [];
  private controller = new AbortController();
  private done: Promise<Anthropic.Beta.Messages.BetaMessage>;

  constructor(opts: OpenAICompatOptions, params: StreamParams, requestTimeoutMs?: number) {
    this.done = this.run(opts, params, requestTimeoutMs);
    // an unawaited rejection would crash the worker; callers see it through finalMessage()
    this.done.catch(() => {});
  }

  on(event: "text", f: TextListener) {
    if (event === "text") this.listeners.push(f);
    return this;
  }

  abort() {
    this.controller.abort();
  }

  finalMessage() {
    return this.done;
  }

  private async run(opts: OpenAICompatOptions, p: StreamParams, requestTimeoutMs?: number) {
    const system = typeof p.system === "string" ? p.system : (p.system ?? []).map((b) => b.text).join("\n\n");
    const format = p.output_config?.format;
    const body: Record<string, unknown> = {
      model: p.model,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: p.max_tokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...p.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
      ],
      ...(p.output_config?.effort ? { reasoning_effort: EFFORT[p.output_config.effort] ?? "medium" } : {}),
      ...(format?.type === "json_schema" && format.schema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "output", strict: true, schema: format.schema },
            },
          }
        : {}),
    };
    const tries = (opts.maxRetries ?? 2) + 1;
    let res: Response | undefined;
    for (let attempt = 1; ; attempt++) {
      const timer = setTimeout(() => this.controller.abort(), requestTimeoutMs ?? opts.timeoutMs ?? 120_000);
      try {
        res = await fetch(`${opts.baseURL.replace(/\/+$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: this.controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (this.controller.signal.aborted) throw new Anthropic.APIUserAbortError();
        if (attempt >= tries) throw new Anthropic.APIConnectionError({ message: String(err) });
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      clearTimeout(timer);
      if (res.ok) break;
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= tries) {
        let error: unknown = text;
        try {
          error = JSON.parse(text);
        } catch {}
        throw Anthropic.APIError.generate(res.status, error as object, text.slice(0, 300), res.headers);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    if (!res?.body) throw new Anthropic.APIConnectionError({ message: "empty response body" });

    let snapshot = "";
    let model = p.model;
    let finish: string | null = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: {
          model?: string;
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.usage)
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
          };
        for (const c of chunk.choices ?? []) {
          if (c.finish_reason) finish = c.finish_reason;
          const delta = c.delta?.content;
          if (delta) {
            snapshot += delta;
            for (const f of this.listeners) f(delta, snapshot);
          }
        }
      }
    }
    const stop_reason =
      finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn";
    return {
      id: `compat_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: snapshot, citations: null }],
      stop_reason,
      stop_sequence: null,
      usage,
    } as unknown as Anthropic.Beta.Messages.BetaMessage;
  }
}

/** Shaped like `Pick<Anthropic, "beta">` as far as the worker's calls go. */
export function openAICompatClient(opts: OpenAICompatOptions): Anthropic {
  const client = {
    beta: {
      messages: {
        stream: (params: StreamParams, reqOpts?: { timeout?: number }) =>
          new CompatStream(opts, params, reqOpts?.timeout),
      },
    },
  };
  return client as unknown as Anthropic;
}
