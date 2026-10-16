// Builds the README animation (docs/media/flowcarbon-{en,zh}.svg): a 20-second loop told on a simulated tower.
// Pure SVG + CSS keyframes, so it plays inside GitHub's <img> rendering (no script, no external assets).
//   node scripts/hero/build-hero.mjs
import { writeFile } from "node:fs/promises";
import { STRINGS } from "./strings.mjs";

const T = 20; // loop length in seconds
const W = 1280;
const H = 720;

const C = {
  bg0: "#060a13",
  bg1: "#0b1424",
  card: "#0e1829",
  cardLine: "#1d2b42",
  text: "#e8edf4",
  muted: "#8d9aae",
  dim: "#5b6a80",
  teal: "#3cd6c3",
  tealDeep: "#0d7068",
  cyan: "#5fd0ff",
  amber: "#f4a63b",
  amberSoft: "#3a2a12",
  warm: "#ffd27a",
  window: "#121d31",
  windowLine: "#1c2a43",
};

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const pct = (t) => `${+((Math.min(Math.max(t, 0), T) / T) * 100).toFixed(3)}%`;

/** Collects keyframes and the classes that use them. */
class Motion {
  css = [];
  n = 0;
  /** frames: [time in s, declarations][] */
  cls(frames, { ease = "ease-in-out" } = {}) {
    const name = `k${this.n++}`;
    const seen = new Set();
    const body = frames
      .filter(([t]) => {
        const key = pct(t);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(([t, d]) => `${pct(t)}{${d}}`)
      .join("");
    this.css.push(`@keyframes ${name}{${body}}.${name}{animation:${name} ${T}s ${ease} infinite}`);
    return `a ${name}`;
  }
  /** Visible in [a, b) with fades; `from`/`to` are transforms used while hidden. */
  show(a, b, { f = 0.4, from = "", to = "" } = {}) {
    const hiddenIn = `opacity:0;${from ? `transform:${from}` : ""}`;
    const hiddenOut = `opacity:0;${to ? `transform:${to}` : ""}`;
    const shown = `opacity:1;${from || to ? "transform:translate(0,0)" : ""}`;
    const frames = [];
    if (a > 0) frames.push([0, hiddenIn], [a, hiddenIn]);
    frames.push([Math.max(a + f, 0), shown], [b - f, shown], [b, hiddenOut], [T, hiddenOut]);
    return this.cls(frames);
  }
}

// scene windows (seconds)
const S = {
  intro: [0.2, 2.7],
  sense: [2.6, 6.2],
  detect: [6.1, 9.7],
  explain: [9.6, 13.2],
  save: [13.1, 16.7],
  report: [16.6, 19.6],
};
const STEP_START = [2.6, 6.1, 9.6, 13.1, 16.6];

// tower geometry
const TX = 150;
const TW = 300;
const FY = 190;
const FSTEP = 34;
const FH = 28;
const FLOORS = Array.from({ length: 12 }, (_, i) => 16 - i); // F16 … F5, top to bottom
const fy = (i) => FY + i * FSTEP;
const BUSY = 12; // the floor that booked overtime
const LIGHTS_LEFT_ON = 16;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(L) {
  const m = new Motion();
  const out = [];
  const add = (s) => out.push(s);
  const mono = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`;

  // ---------- backdrop ----------
  add(`<rect width="${W}" height="${H}" rx="22" fill="url(#bg)"/>`);
  add(`<ellipse cx="${TX + TW / 2}" cy="420" rx="330" ry="300" fill="url(#halo)"/>`);
  add(`<ellipse cx="980" cy="360" rx="380" ry="300" fill="url(#halo2)"/>`);
  // grid
  add(`<g opacity="0.07" stroke="${C.muted}" stroke-width="1">`);
  for (let x = 40; x < W; x += 40) add(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
  for (let y = 40; y < H; y += 40) add(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  add(`</g>`);
  // stars
  const r = rng(7);
  add(`<g fill="#cfe3ff">`);
  for (let i = 0; i < 46; i++) {
    const x = Math.round(r() * W);
    const y = Math.round(r() * 300);
    const d = (r() * 4).toFixed(2);
    const dur = (2.5 + r() * 3).toFixed(2);
    add(
      `<circle class="tw" cx="${x}" cy="${y}" r="${(0.6 + r() * 1.1).toFixed(2)}" style="animation-delay:-${d}s;animation-duration:${dur}s"/>`,
    );
  }
  add(`</g>`);
  // skyline behind the tower
  const sky = [
    [40, 360, 70],
    [96, 300, 46],
    [470, 330, 64],
    [540, 400, 58],
    [600, 470, 30],
  ];
  add(`<g fill="#0a1322" stroke="#122038">`);
  for (const [x, y, w] of sky) add(`<rect x="${x}" y="${y}" width="${w}" height="${602 - y}" rx="3"/>`);
  add(`</g>`);
  add(`<g fill="#1a2740">`);
  for (const [x, y, w] of sky)
    for (let yy = y + 14; yy < 590; yy += 22)
      for (let xx = x + 8; xx < x + w - 8; xx += 14)
        if (r() > 0.72) add(`<rect x="${xx}" y="${yy}" width="6" height="8" rx="1"/>`);
  add(`</g>`);
  add(`<rect x="24" y="602" width="${W - 48}" height="2" fill="${C.cardLine}"/>`);

  // ---------- header ----------
  add(`<g class="${m.show(0, T, { f: 0.5 })}">`);
  add(`<rect x="56" y="44" width="40" height="40" rx="11" fill="url(#logo)"/>`);
  add(
    `<g transform="translate(76 64)" fill="none" stroke="#04201d" stroke-width="2.2" stroke-linejoin="round"><path d="M0 -10 L11 -4.5 L0 1 L-11 -4.5 Z"/><path d="M-11 0.5 L0 6 L11 0.5"/><path d="M-11 5.5 L0 11 L11 5.5"/></g>`,
  );
  add(
    `<text x="110" y="73" font-size="28" font-weight="700" fill="${C.text}" letter-spacing="-0.5">FlowCarbon</text>`,
  );
  add(`<text x="110" y="96" font-size="14" fill="${C.muted}">${esc(L.tagline)}</text>`);
  add(`</g>`);
  const badgeW = L.lang === "en" ? 132 : 84;
  add(
    `<g transform="translate(${W - 56 - badgeW} 50)"><rect width="${badgeW}" height="28" rx="14" fill="${C.amberSoft}" stroke="#5a3d16"/>`,
  );
  add(
    `<text x="${badgeW / 2}" y="19" text-anchor="middle" font-size="12" font-weight="700" letter-spacing="${L.lang === "en" ? 1.5 : 2}" fill="${C.amber}">${esc(L.badge)}</text></g>`,
  );

  // clock pill
  const clockW = L.lang === "en" ? 262 : 228;
  add(`<g class="${m.show(1.2, T - 0.4)}" transform="translate(56 118)">`);
  add(`<rect width="${clockW}" height="30" rx="15" fill="${C.card}" stroke="${C.cardLine}"/>`);
  add(
    `<circle cx="17" cy="15" r="7" fill="none" stroke="${C.teal}" stroke-width="1.8"/><path d="M17 11 V15 L20 17" stroke="${C.teal}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  );
  add(`<text x="32" y="20" font-size="13.5" fill="${C.text}">${esc(L.clock)}</text></g>`);

  // ---------- tower ----------
  add(`<g>`);
  // roof and antenna
  add(
    `<rect x="${TX + 30}" y="${FY - 24}" width="${TW - 60}" height="22" rx="4" fill="#0d1729" stroke="${C.cardLine}"/>`,
  );
  add(
    `<line x1="${TX + TW - 60}" y1="${FY - 24}" x2="${TX + TW - 60}" y2="${FY - 52}" stroke="${C.cardLine}" stroke-width="2"/>`,
  );
  add(
    `<circle class="blink" cx="${TX + TW - 60}" cy="${FY - 54}" r="3.2" fill="#ff5a5a" filter="url(#glow)"/>`,
  );
  add(
    `<rect x="${TX - 6}" y="${FY - 4}" width="${TW + 12}" height="${12 * FSTEP + 2}" rx="8" fill="#0b1424" stroke="${C.cardLine}"/>`,
  );

  FLOORS.forEach((label, i) => {
    const y = fy(i);
    const appear = m.show(0.15 + (11 - i) * 0.07, T - 0.3, { f: 0.35, from: "translate(0,6px)" });
    add(`<g class="${appear}">`);
    add(
      `<rect x="${TX}" y="${y}" width="${TW}" height="${FH}" rx="5" fill="#0f1a2c" stroke="${C.windowLine}"/>`,
    );
    add(
      `<text x="${TX - 16}" y="${y + 19}" text-anchor="end" font-size="13" font-weight="600" fill="${C.dim}" font-family='${mono}'>F${label}</text>`,
    );
    // cooling: a cool band and moving air; empty floors switch off one by one when the strategy is applied
    const off = label === BUSY ? T - 0.4 : 13.6 + (11 - i) * 0.13;
    add(`<g class="${m.show(1.9 + (11 - i) * 0.05, off, { f: 0.45 })}">`);
    add(`<rect x="${TX + 1}" y="${y + 1}" width="${TW - 2}" height="${FH - 2}" rx="4" fill="url(#cool)"/>`);
    add(
      `<line class="air" x1="${TX + 8}" y1="${y + 3}" x2="${TX + TW - 8}" y2="${y + 3}" stroke="${C.cyan}" stroke-width="1.6" stroke-dasharray="7 11" opacity="0.75"/>`,
    );
    add(`</g>`);
    // windows
    for (let w = 0; w < 8; w++)
      add(
        `<rect x="${TX + 12 + w * 36}" y="${y + 6}" width="24" height="13" rx="2.5" fill="${C.window}" stroke="${C.windowLine}"/>`,
      );
    // lights
    if (label === BUSY || label === LIGHTS_LEFT_ON) {
      const until = label === BUSY ? T - 0.4 : 14.9;
      add(`<g class="${m.show(1.4, until, { f: 0.5 })}" filter="url(#glowSoft)">`);
      for (let w = 0; w < 8; w++)
        add(
          `<rect x="${TX + 12 + w * 36}" y="${y + 6}" width="24" height="13" rx="2.5" fill="${C.warm}" opacity="${label === BUSY ? 0.92 : 0.75}"/>`,
        );
      add(`</g>`);
    }
    // people on the floor that booked overtime
    if (label === BUSY) {
      add(`<g class="${m.show(2.6, T - 0.4)}">`);
      for (let p = 0; p < 8; p++)
        add(
          `<circle class="bob" style="animation-delay:-${(p * 0.37).toFixed(2)}s" cx="${TX + 24 + p * 36}" cy="${y + 23.5}" r="3" fill="#7ff5e4" filter="url(#glow)"/>`,
        );
      add(`</g>`);
    }
    // waste flag on floors cooled for nobody
    if (label !== BUSY) {
      add(`<g class="${m.show(6.5 + (11 - i) * 0.05, 13.5, { f: 0.3 })}">`);
      add(
        `<rect class="pulse" x="${TX - 3}" y="${y - 3}" width="${TW + 6}" height="${FH + 6}" rx="7" fill="none" stroke="${C.amber}" stroke-width="1.6" stroke-dasharray="5 4"/>`,
      );
      add(`</g>`);
    }
    // headcount column
    const busy = label === BUSY;
    // appears as the door-counter scan passes the floor
    const scanAt = 3.0 + 2.6 * (((11 - i) * FSTEP + FH / 2) / (11 * FSTEP + FH));
    add(`<g class="${m.show(scanAt, 13.4, { f: 0.2 })}">`);
    add(
      `<text x="${TX + TW + 18}" y="${y + 19}" font-size="15" font-weight="700" font-family='${mono}' fill="${busy ? C.teal : C.dim}">${busy ? 8 : 0}</text>`,
    );
    add(`</g>`);
    add(`</g>`);
  });
  // the door-counter scan
  add(
    `<g class="${m.cls([
      [0, "opacity:0;transform:translate(0,0)"],
      [2.8, "opacity:0;transform:translate(0,0)"],
      [3.0, "opacity:1;transform:translate(0,0)"],
      [5.6, `opacity:1;transform:translate(0,${-(11 * FSTEP + FH)}px)`],
      [5.9, `opacity:0;transform:translate(0,${-(11 * FSTEP + FH)}px)`],
      [T, `opacity:0;transform:translate(0,${-(11 * FSTEP + FH)}px)`],
    ])}">`,
  );
  add(
    `<rect x="${TX - 10}" y="${fy(11) + FH}" width="${TW + 20}" height="3" rx="1.5" fill="${C.teal}" filter="url(#glow)"/>`,
  );
  add(`<rect x="${TX - 10}" y="${fy(11) + FH - 26}" width="${TW + 20}" height="26" fill="url(#beam)"/>`);
  add(`</g>`);
  add(`</g>`);

  // ---------- narrative panel ----------
  const PX = 660;
  const kicker = (t, y = 200) =>
    `<text x="${PX}" y="${y}" font-size="14" font-weight="700" letter-spacing="${L.lang === "en" ? 3 : 1.5}" fill="${C.teal}">${esc(t)}</text>`;
  const title = (lines, y = 246, size = 34) =>
    lines
      .map(
        (l, k) =>
          `<text x="${PX}" y="${y + k * (size + 10)}" font-size="${size}" font-weight="700" fill="${C.text}" letter-spacing="${L.lang === "en" ? -0.6 : 0}">${esc(l)}</text>`,
      )
      .join("");

  // scene 0 — the problem
  add(
    `<g class="${m.show(S.intro[0], S.intro[1], { from: "translate(14px,0)", to: "translate(-14px,0)" })}">`,
  );
  add(title(L.s0.title, 268, 36));
  add(`<text x="${PX}" y="${268 + 2 * 46 + 12}" font-size="19" fill="${C.muted}">${esc(L.s0.sub)}</text>`);
  add(`</g>`);

  // scene 1 — sense
  add(`<g class="${m.show(...S.sense, { from: "translate(14px,0)", to: "translate(-14px,0)" })}">`);
  add(kicker(L.s1.kicker));
  add(title(L.s1.title));
  const icons = [
    `<path d="M-7 6 V-6 H7 V6" fill="none" stroke="${C.teal}" stroke-width="2"/><circle cx="0" cy="-1" r="2.5" fill="${C.teal}"/>`,
    `<rect x="-8" y="-6" width="16" height="12" rx="2" fill="none" stroke="${C.teal}" stroke-width="2"/><path d="M-4 0 H4" stroke="${C.teal}" stroke-width="2"/>`,
    `<path d="M2 -8 L-5 1 H1 L-2 8 L6 -2 H0 Z" fill="${C.teal}"/>`,
  ];
  L.s1.items.forEach((it, k) => {
    const y = 350 + k * 46;
    add(`<g class="${m.show(3.1 + k * 0.35, S.sense[1], { f: 0.35, from: "translate(10px,0)" })}">`);
    add(
      `<rect x="${PX}" y="${y - 22}" width="34" height="34" rx="9" fill="${C.card}" stroke="${C.cardLine}"/>`,
    );
    add(`<g transform="translate(${PX + 17} ${y - 5})">${icons[k]}</g>`);
    add(`<text x="${PX + 50}" y="${y + 1}" font-size="19" fill="${C.text}">${esc(it)}</text>`);
    add(`</g>`);
  });
  {
    const y = 506;
    const mw = L.lang === "en" ? 104 : 64;
    const ew = L.lang === "en" ? 100 : 64;
    add(`<g class="${m.show(4.4, S.sense[1], { f: 0.35 })}">`);
    add(`<rect x="${PX}" y="${y}" width="${mw}" height="30" rx="15" fill="#11332f" stroke="#1f5b54"/>`);
    add(
      `<text x="${PX + mw / 2}" y="${y + 20}" text-anchor="middle" font-size="14" font-weight="600" fill="${C.teal}">${esc(L.s1.measured)}</text>`,
    );
    add(
      `<rect x="${PX + mw + 10}" y="${y}" width="${ew}" height="30" rx="15" fill="none" stroke="${C.dim}" stroke-dasharray="4 3"/>`,
    );
    add(
      `<text x="${PX + mw + 10 + ew / 2}" y="${y + 20}" text-anchor="middle" font-size="14" font-weight="600" fill="${C.muted}">${esc(L.s1.estimated)}</text>`,
    );
    add(
      `<text x="${PX + mw + ew + 26}" y="${y + 20}" font-size="15" fill="${C.muted}">${esc(L.s1.tierNote)}</text>`,
    );
    add(`</g>`);
  }
  add(`</g>`);

  // scene 2 — detect
  add(`<g class="${m.show(...S.detect, { from: "translate(14px,0)", to: "translate(-14px,0)" })}">`);
  add(kicker(L.s2.kicker));
  add(title(L.s2.title));
  L.s2.cards.forEach(([floor, text, kwh], k) => {
    const y = 330 + k * 82;
    add(`<g class="${m.show(6.6 + k * 0.45, S.detect[1], { f: 0.35, from: "translate(40px,0)" })}">`);
    add(`<rect x="${PX}" y="${y}" width="540" height="66" rx="14" fill="${C.card}" stroke="${C.cardLine}"/>`);
    add(`<rect x="${PX}" y="${y + 12}" width="4" height="42" rx="2" fill="${C.amber}"/>`);
    add(
      `<text x="${PX + 22}" y="${y + 41}" font-size="21" font-weight="700" fill="${C.text}" font-family='${mono}'>${floor}</text>`,
    );
    add(`<text x="${PX + 84}" y="${y + 41}" font-size="18" fill="${C.text}">${esc(text)}</text>`);
    add(
      `<rect x="${PX + 380}" y="${y + 21}" width="${L.lang === "en" ? 54 : 44}" height="24" rx="12" fill="${C.amberSoft}"/>`,
    );
    add(
      `<text x="${PX + 380 + (L.lang === "en" ? 27 : 22)}" y="${y + 38}" text-anchor="middle" font-size="12" font-weight="700" fill="${C.amber}">${esc(L.s2.tag)}</text>`,
    );
    add(
      `<text x="${PX + 524}" y="${y + 41}" text-anchor="end" font-size="19" font-weight="700" fill="${C.amber}" font-family='${mono}'>${kwh}</text>`,
    );
    add(`</g>`);
  });
  add(`</g>`);

  // scene 3 — explain
  add(`<g class="${m.show(...S.explain, { from: "translate(14px,0)", to: "translate(-14px,0)" })}">`);
  add(kicker(L.s3.kicker, 200));
  {
    const x = PX;
    const y = 226;
    const w = 560;
    const h = 276;
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${C.card}" stroke="#1f4b47"/>`);
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="url(#aiSheen)" opacity="0.7"/>`);
    add(
      `<g transform="translate(${x + 30} ${y + 38})"><g class="spark"><path d="M0 -11 L3 -3 L11 0 L3 3 L0 11 L-3 3 L-11 0 L-3 -3 Z" fill="${C.teal}" filter="url(#glow)"/></g></g>`,
    );
    add(
      `<text x="${x + 52}" y="${y + 44}" font-size="17" font-weight="700" fill="${C.teal}">${esc(L.s3.ai)}</text>`,
    );
    add(
      `<clipPath id="aiClip"><rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 4}" rx="16"/></clipPath>`,
    );
    add(`<g clip-path="url(#aiClip)">`);
    L.s3.lines.forEach((line, k) => {
      const ly = y + 96 + k * 50;
      const t0 = 10.1 + k * 0.62;
      if (k === 2)
        add(
          `<rect x="${x + 22}" y="${ly - 25}" width="${w - 44}" height="38" rx="10" fill="#11332f" stroke="#1f5b54"/>`,
        );
      add(
        `<text x="${x + 34}" y="${ly}" font-size="${k === 2 ? 19 : 17.5}" font-weight="${k === 2 ? 700 : 400}" fill="${k === 2 ? C.teal : k === 3 ? C.muted : C.text}">${esc(line)}</text>`,
      );
      // a cover in the card colour slides right to "type" the line
      add(
        `<rect class="${m.cls([
          [0, "transform:translate(0,0)"],
          [t0, "transform:translate(0,0)"],
          [t0 + 0.7, `transform:translate(${w}px,0)`],
          [T, `transform:translate(${w}px,0)`],
        ])}" x="${x + (k === 2 ? 26 : 20)}" y="${ly - 22}" width="${w - (k === 2 ? 52 : 30)}" height="${k === 2 ? 30 : 32}" fill="${k === 2 ? "#11332f" : C.card}"/>`,
      );
    });
    add(`</g>`);
    add(
      `<text class="${m.show(12.2, S.explain[1], { f: 0.3 })}" x="${PX}" y="${y + h + 44}" font-size="17" font-style="italic" fill="${C.muted}">${esc(L.s3.motto)}</text>`,
    );
  }
  add(`</g>`);

  // scene 4 — simulate
  add(`<g class="${m.show(...S.save, { from: "translate(14px,0)", to: "translate(-14px,0)" })}">`);
  add(kicker(L.s4.kicker));
  add(title(L.s4.title));
  {
    const y = 336;
    const bw = 172;
    const gap = 18;
    const boxes = [
      { label: L.s4.labels[0], frames: ["0", "58", "117", "175", "233"], unit: "MWh", color: C.teal },
      { label: L.s4.labels[1], frames: L.s4.money, unit: "", color: C.text },
      { label: L.s4.labels[2], frames: [L.s4.payback], unit: "", color: C.text },
    ];
    boxes.forEach((b, k) => {
      const x = PX + k * (bw + gap);
      add(`<g class="${m.show(13.4 + k * 0.25, S.save[1], { f: 0.3, from: "translate(0,10px)" })}">`);
      add(
        `<rect x="${x}" y="${y}" width="${bw}" height="124" rx="16" fill="${C.card}" stroke="${C.cardLine}"/>`,
      );
      if (b.frames.length === 1) {
        add(
          `<text x="${x + 20}" y="${y + 62}" font-size="34" font-weight="700" fill="${b.color}" font-family='${mono}'>${esc(b.frames[0])}</text>`,
        );
      } else {
        b.frames.forEach((v, j) => {
          const a = 13.6 + j * 0.42;
          const last = j === b.frames.length - 1;
          const cls = m.show(a, last ? S.save[1] : a + 0.42, { f: 0.06 });
          add(
            `<text class="${cls}" x="${x + 20}" y="${y + 62}" font-size="34" font-weight="700" fill="${b.color}" font-family='${mono}'>${esc(v)}</text>`,
          );
        });
      }
      if (b.unit)
        add(
          `<text x="${x + 20}" y="${y + 88}" font-size="15" font-weight="600" fill="${C.muted}" font-family='${mono}'>${b.unit}</text>`,
        );
      add(`<text x="${x + 20}" y="${y + 110}" font-size="14" fill="${C.muted}">${esc(b.label)}</text>`);
      add(`</g>`);
    });
    add(
      `<text class="${m.show(14.2, S.save[1], { f: 0.3 })}" x="${PX}" y="${y + 166}" font-size="15" fill="${C.dim}">${esc(L.s4.note)}</text>`,
    );
  }
  add(`</g>`);

  // scene 5 — report and the end card
  add(`<g class="${m.show(...S.report, { from: "translate(14px,0)" })}">`);
  add(kicker(L.s5.kicker));
  add(title(L.s5.title));
  {
    const y = 330;
    add(
      `<rect x="${PX}" y="${y}" width="560" height="136" rx="16" fill="${C.card}" stroke="${C.cardLine}"/>`,
    );
    L.s5.rows.forEach(([k, v], j) => {
      const ry = y + 40 + j * 38;
      add(`<text x="${PX + 24}" y="${ry}" font-size="16" fill="${C.muted}">Scope 2 · ${esc(k)}</text>`);
      add(
        `<text x="${PX + 536}" y="${ry}" text-anchor="end" font-size="18" font-weight="700" fill="${C.text}" ${j === 0 ? `font-family='${mono}'` : ""}>${esc(v)}</text>`,
      );
    });
    add(`<text x="${PX + 24}" y="${y + 114}" font-size="13.5" fill="${C.teal}">${esc(L.s5.factor)}</text>`);
    add(`<g class="${m.show(17.6, S.report[1], { f: 0.4, from: "translate(0,10px)" })}">`);
    add(
      `<text x="${PX}" y="${y + 196}" font-size="24" font-weight="700" fill="${C.text}">${esc(L.s5.open)}</text>`,
    );
    add(
      `<text x="${PX}" y="${y + 228}" font-size="18" font-weight="600" fill="${C.teal}" font-family='${mono}'>github.com/3351666087/flowcarbon</text>`,
    );
    add(`<text x="${PX}" y="${y + 256}" font-size="14" fill="${C.muted}">${esc(L.stack)}</text>`);
    add(`</g>`);
  }
  add(`</g>`);

  // ---------- timeline ----------
  {
    const x0 = 56;
    const x1 = W - 56;
    const y = 664;
    add(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="3" rx="1.5" fill="${C.cardLine}"/>`);
    add(
      `<rect class="${m.cls(
        [
          [0, "transform:scaleX(0)"],
          [T, "transform:scaleX(1)"],
        ],
        { ease: "linear" },
      )} grow" x="${x0}" y="${y}" width="${x1 - x0}" height="3" rx="1.5" fill="url(#progress)"/>`,
    );
    L.steps.forEach((s, k) => {
      const t = STEP_START[k];
      const x = x0 + ((x1 - x0) * t) / T;
      const end = k < 4 ? STEP_START[k + 1] : T - 0.4;
      add(
        `<circle cx="${x}" cy="${y + 1.5}" r="5" fill="${C.bg1}" stroke="${C.cardLine}" stroke-width="2"/>`,
      );
      add(
        `<circle class="${m.show(t, end, { f: 0.2 })}" cx="${x}" cy="${y + 1.5}" r="5" fill="${C.teal}" filter="url(#glow)"/>`,
      );
      add(
        `<text x="${x}" y="${y + 30}" text-anchor="middle" font-size="13" font-weight="600" fill="${C.dim}">${esc(s)}</text>`,
      );
      add(
        `<text class="${m.show(t, end, { f: 0.2 })}" x="${x}" y="${y + 30}" text-anchor="middle" font-size="13" font-weight="700" fill="${C.teal}">${esc(s)}</text>`,
      );
    });
  }

  const css = `
svg{font-family:${L.font}}
.tw{animation:tw 3s ease-in-out infinite}
@keyframes tw{0%,100%{opacity:.25}50%{opacity:.95}}
.blink{animation:blink 1.6s steps(1) infinite}
@keyframes blink{0%{opacity:1}50%{opacity:.15}}
.air{animation:air 1.4s linear infinite}
@keyframes air{to{stroke-dashoffset:-36}}
.bob{animation:bob 2.2s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translate(0,0)}50%{transform:translate(0,-2px)}}
.pulse{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.spark{animation:spark 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes spark{0%,100%{transform:rotate(0) scale(1)}50%{transform:rotate(45deg) scale(1.15)}}
.grow{transform-box:fill-box;transform-origin:left center}
${m.css.join("\n")}
/* without motion: a still frame of the explanation scene */
@media (prefers-reduced-motion: reduce){.a,.tw,.air,.bob,.pulse,.spark,.blink{animation-play-state:paused!important}.a{animation-delay:-12.4s!important}}
`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" lang="${L.lang}">
<title id="t">FlowCarbon</title>
<desc id="d">${esc(L.s0.title.join(" "))} ${esc(L.s0.sub)} ${esc(L.steps.join(" → "))}.</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${C.tealDeep}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.tealDeep}" stop-opacity="0"/></radialGradient>
<radialGradient id="halo2"><stop offset="0" stop-color="#1b3a7a" stop-opacity="0.22"/><stop offset="1" stop-color="#1b3a7a" stop-opacity="0"/></radialGradient>
<linearGradient id="logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ff0d9"/><stop offset="1" stop-color="#1aa597"/></linearGradient>
<linearGradient id="cool" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.cyan}" stop-opacity="0.04"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0.22"/></linearGradient>
<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.teal}" stop-opacity="0"/><stop offset="1" stop-color="${C.teal}" stop-opacity="0.28"/></linearGradient>
<linearGradient id="aiSheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.teal}" stop-opacity="0.10"/><stop offset="0.5" stop-color="${C.teal}" stop-opacity="0"/></linearGradient>
<linearGradient id="progress" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.tealDeep}"/><stop offset="1" stop-color="${C.teal}"/></linearGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="glowSoft" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<style>${css}</style>
${out.join("\n")}
</svg>
`;
}

for (const [key, L] of Object.entries(STRINGS)) {
  const svg = build(L);
  const file = `docs/media/flowcarbon-${key}.svg`;
  await writeFile(file, svg);
  console.log(`${file}  ${(svg.length / 1024).toFixed(1)} KB`);
}
