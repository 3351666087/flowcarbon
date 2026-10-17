// Builds the repository's social preview (docs/media/social-preview.png, 1280×640): a still of the tower in the
// "detect" moment with the name and tagline. Upload it under Settings → Social preview.
//   node scripts/hero/build-poster.mjs
import { writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const W = 1280;
const H = 640;
const C = {
  bg0: "#060a13",
  bg1: "#0b1424",
  card: "#0e1829",
  line: "#1d2b42",
  text: "#e8edf4",
  muted: "#8d9aae",
  dim: "#5b6a80",
  teal: "#3cd6c3",
  tealDeep: "#0d7068",
  cyan: "#5fd0ff",
  amber: "#f4a63b",
  warm: "#ffd27a",
  window: "#121d31",
  windowLine: "#1c2a43",
};
const SANS = "Helvetica Neue, Helvetica, Arial, PingFang SC, Hiragino Sans GB, sans-serif";
const ZH = "PingFang SC, Hiragino Sans GB, Heiti SC, sans-serif";
const MONO = "Menlo, SF Mono, Monaco, monospace";

const out = [];
const add = (s) => out.push(s);

// backdrop
add(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
add(`<ellipse cx="270" cy="380" rx="320" ry="290" fill="url(#halo)"/>`);
add(`<ellipse cx="900" cy="300" rx="420" ry="300" fill="url(#halo2)"/>`);
add(`<g opacity="0.07" stroke="${C.muted}" stroke-width="1">`);
for (let x = 40; x < W; x += 40) add(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
for (let y = 40; y < H; y += 40) add(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
add(`</g>`);
let seed = 11;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
add(`<g fill="#cfe3ff">`);
for (let i = 0; i < 50; i++)
  add(
    `<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * 260).toFixed(0)}" r="${(0.6 + rnd()).toFixed(2)}" opacity="${(0.3 + rnd() * 0.6).toFixed(2)}"/>`,
  );
add(`</g>`);

// tower in the detect moment: the zone cools every floor for one booking; 11 floors are flagged
const TX = 110;
const TW = 300;
const FY = 150;
const STEP = 34;
const FH = 28;
const floors = Array.from({ length: 12 }, (_, i) => 16 - i);
for (const [x, y, w] of [
  [24, 330, 70],
  [430, 300, 60],
  [494, 380, 46],
])
  add(`<rect x="${x}" y="${y}" width="${w}" height="${562 - y}" rx="3" fill="#0a1322" stroke="#122038"/>`);
add(`<rect x="24" y="562" width="${W - 48}" height="2" fill="${C.line}"/>`);
add(
  `<rect x="${TX + 30}" y="${FY - 24}" width="${TW - 60}" height="22" rx="4" fill="#0d1729" stroke="${C.line}"/>`,
);
add(
  `<line x1="${TX + TW - 60}" y1="${FY - 24}" x2="${TX + TW - 60}" y2="${FY - 50}" stroke="${C.line}" stroke-width="2"/>`,
);
add(`<circle cx="${TX + TW - 60}" cy="${FY - 52}" r="3.2" fill="#ff5a5a" filter="url(#glow)"/>`);
add(
  `<rect x="${TX - 6}" y="${FY - 4}" width="${TW + 12}" height="${12 * STEP + 2}" rx="8" fill="#0b1424" stroke="${C.line}"/>`,
);
floors.forEach((label, i) => {
  const y = FY + i * STEP;
  const busy = label === 12;
  add(
    `<rect x="${TX}" y="${y}" width="${TW}" height="${FH}" rx="5" fill="#0f1a2c" stroke="${C.windowLine}"/>`,
  );
  add(`<rect x="${TX + 1}" y="${y + 1}" width="${TW - 2}" height="${FH - 2}" rx="4" fill="url(#cool)"/>`);
  add(
    `<line x1="${TX + 8}" y1="${y + 3}" x2="${TX + TW - 8}" y2="${y + 3}" stroke="${C.cyan}" stroke-width="1.6" stroke-dasharray="7 11" opacity="0.75"/>`,
  );
  add(
    `<text x="${TX - 14}" y="${y + 19}" text-anchor="end" font-size="13" font-weight="bold" fill="${C.dim}" font-family="${MONO}">F${label}</text>`,
  );
  const lit = busy || label === 16;
  for (let w = 0; w < 8; w++)
    add(
      `<rect x="${TX + 12 + w * 36}" y="${y + 6}" width="24" height="13" rx="2.5" fill="${lit ? C.warm : C.window}" ${lit ? `opacity="${busy ? 0.92 : 0.75}" filter="url(#soft)"` : `stroke="${C.windowLine}"`}/>`,
    );
  if (busy)
    for (let p = 0; p < 8; p++)
      add(`<circle cx="${TX + 24 + p * 36}" cy="${y + 23.5}" r="3" fill="#7ff5e4" filter="url(#glow)"/>`);
  else
    add(
      `<rect x="${TX - 3}" y="${y - 3}" width="${TW + 6}" height="${FH + 6}" rx="7" fill="none" stroke="${C.amber}" stroke-width="1.6" stroke-dasharray="5 4"/>`,
    );
  add(
    `<text x="${TX + TW + 16}" y="${y + 19}" font-size="15" font-weight="bold" font-family="${MONO}" fill="${busy ? C.teal : C.dim}">${busy ? 8 : 0}</text>`,
  );
});

// title block
const X = 548;
add(`<rect x="${X}" y="118" width="64" height="64" rx="17" fill="url(#logo)"/>`);
add(
  `<g transform="translate(${X + 32} 150) scale(1.6)" fill="none" stroke="#04201d" stroke-width="2.2" stroke-linejoin="round"><path d="M0 -10 L11 -4.5 L0 1 L-11 -4.5 Z"/><path d="M-11 0.5 L0 6 L11 0.5"/><path d="M-11 5.5 L0 11 L11 5.5"/></g>`,
);
add(
  `<text x="${X + 86}" y="170" font-size="64" font-weight="bold" fill="${C.text}" font-family="${SANS}" letter-spacing="-1.5">FlowCarbon</text>`,
);
add(
  `<text x="${X}" y="242" font-size="28" fill="${C.text}" font-family="${SANS}">Occupancy-driven after-hours energy</text>`,
);
add(
  `<text x="${X}" y="278" font-size="28" fill="${C.text}" font-family="${SANS}">and carbon for office buildings</text>`,
);
add(
  `<text x="${X}" y="322" font-size="23" fill="${C.muted}" font-family="${ZH}">按楼层人数管理写字楼下班后的能耗与碳排</text>`,
);

// the five steps
const steps = ["Sense", "Detect", "Explain", "Simulate", "Report"];
let sx = X;
steps.forEach((s, k) => {
  const w = s.length * 10.5 + 32;
  const active = k === 1;
  add(
    `<rect x="${sx}" y="364" width="${w}" height="38" rx="19" fill="${active ? "#11332f" : C.card}" stroke="${active ? "#1f5b54" : C.line}"/>`,
  );
  add(
    `<text x="${sx + w / 2}" y="389" text-anchor="middle" font-size="17" font-weight="bold" fill="${active ? C.teal : C.muted}" font-family="${SANS}">${s}</text>`,
  );
  sx += w + (k < steps.length - 1 ? 26 : 0);
  if (k < steps.length - 1)
    add(
      `<path d="M${sx - 19} 383 h12 m-5 -5 l5 5 l-5 5" fill="none" stroke="${C.dim}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
});

add(
  `<text x="${X}" y="452" font-size="21" font-style="italic" fill="${C.muted}" font-family="${SANS}">Rules decide · AI explains · people choose</text>`,
);
add(`<rect x="${X}" y="490" width="660" height="1" fill="${C.line}"/>`);
add(
  `<text x="${X}" y="530" font-size="19" font-weight="bold" fill="${C.text}" font-family="${SANS}">Open source · Apache-2.0</text>`,
);
add(
  `<text x="${X}" y="562" font-size="19" font-weight="bold" fill="${C.teal}" font-family="${MONO}">github.com/3351666087/flowcarbon</text>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${C.tealDeep}" stop-opacity="0.38"/><stop offset="1" stop-color="${C.tealDeep}" stop-opacity="0"/></radialGradient>
<radialGradient id="halo2"><stop offset="0" stop-color="#1b3a7a" stop-opacity="0.24"/><stop offset="1" stop-color="#1b3a7a" stop-opacity="0"/></radialGradient>
<linearGradient id="logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ff0d9"/><stop offset="1" stop-color="#1aa597"/></linearGradient>
<linearGradient id="cool" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.cyan}" stop-opacity="0.04"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0.22"/></linearGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="soft" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
${out.join("\n")}
</svg>
`;

const png = new Resvg(svg, {
  fitTo: { mode: "width", value: W },
  font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
}).render();
await writeFile("docs/media/social-preview.png", png.asPng());
console.log(`docs/media/social-preview.png  ${png.width}×${png.height}`);
