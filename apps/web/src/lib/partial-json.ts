/**
 * Reads JSON that may stop anywhere, as a streamed response does: open strings, arrays and objects are taken as
 * they stand, and a key or literal that has not finished arriving is left out. Malformed input ends the read
 * instead of throwing.
 */
export function parsePartialJson(text: string): unknown {
  let i = 0;
  const space = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };

  const string = () => {
    i++;
    let out = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const next = text[i + 1];
        if (next === undefined) break;
        if (next === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += ESCAPES[next] ?? next;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    i = text.length;
    return out;
  };

  const array = () => {
    i++;
    const out: unknown[] = [];
    for (;;) {
      space();
      if (i >= text.length) return out;
      if (text[i] === "]") {
        i++;
        return out;
      }
      const v = value();
      if (v !== undefined) out.push(v);
      space();
      if (text[i] === ",") i++;
    }
  };

  const object = () => {
    i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      space();
      if (i >= text.length) return out;
      if (text[i] === "}") {
        i++;
        return out;
      }
      if (text[i] !== '"') {
        i = text.length;
        return out;
      }
      const key = string();
      space();
      if (text[i] !== ":") return out;
      i++;
      const v = value();
      if (v !== undefined) out[key] = v;
      space();
      if (text[i] === ",") i++;
    }
  };

  function value(): unknown {
    space();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[\s,\]}]|$)/.exec(text.slice(i));
    if (literal && i + literal[0].length < text.length) {
      i += literal[0].length;
      return JSON.parse(literal[0]);
    }
    // not finished yet, or not JSON
    i = text.length;
    return undefined;
  }

  return value();
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
