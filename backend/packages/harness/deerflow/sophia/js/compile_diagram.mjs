import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const PALETTE = {
  background: "#f8fafc",
  title: "#0f172a",
  stroke: "#334155",
  muted: "#64748b",
  fills: ["#e0f2fe", "#ccfbf1", "#fef3c7", "#ede9fe", "#fee2e2", "#dcfce7"],
  accents: ["#0284c7", "#0f766e", "#d97706", "#7c3aed", "#dc2626", "#16a34a"],
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mermaid") {
      args.mermaidFile = argv[++index];
    } else if (value === "--svg") {
      args.svgFile = argv[++index];
    } else if (value === "--scene") {
      args.sceneFile = argv[++index];
    } else if (value === "--title") {
      args.title = argv[++index];
    } else if (value === "--width") {
      args.width = Number(argv[++index]);
    } else if (value === "--height") {
      args.height = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.mermaidFile || !args.svgFile || !args.sceneFile) {
    throw new Error("--mermaid, --svg, and --scene are required");
  }
  args.width = Number.isFinite(args.width) ? args.width : 1280;
  args.height = Number.isFinite(args.height) ? args.height : 720;
  return args;
}

async function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  const createDOMPurify = (await import("dompurify")).default;
  globalThis.DOMPurify = createDOMPurify(dom.window);
  dom.window.SVGElement.prototype.getBBox = function getBBox() {
    const text = this.textContent || "";
    return {
      x: 0,
      y: 0,
      width: Math.max(28, text.length * 8),
      height: 20,
    };
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function measure(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const x = Number(element.x || 0);
    const y = Number(element.y || 0);
    const points = Array.isArray(element.points) ? element.points : null;
    if (points) {
      for (const [px, py] of points) {
        minX = Math.min(minX, x + Number(px || 0));
        minY = Math.min(minY, y + Number(py || 0));
        maxX = Math.max(maxX, x + Number(px || 0));
        maxY = Math.max(maxY, y + Number(py || 0));
      }
    } else {
      const width = Number(element.width || 0);
      const height = Number(element.height || 0);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  return { minX, minY, maxX, maxY };
}

function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = `${current} ${word}`.trim();
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word.slice(0, maxChars);
    if (lines.length >= 2) break;
  }
  if (current && lines.length < 3) lines.push(current);
  return lines.length ? lines : [String(text || "")];
}

function transformFor(elements, { width, height, title }) {
  const bounds = measure(elements);
  const margin = 70;
  const titleSpace = title ? 62 : 28;
  const sourceWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const sourceHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min((width - margin * 2) / sourceWidth, (height - margin - titleSpace) / sourceHeight);
  return {
    scale,
    tx: margin - bounds.minX * scale,
    ty: titleSpace - bounds.minY * scale,
  };
}

function titleSvg(title) {
  return title ? [`<text x="48" y="44" class="title" font-size="26">${escapeXml(title)}</text>`] : [];
}

function nodeSvg(element, transform, colorIndex) {
  const { scale, tx, ty } = transform;
  const x = tx + Number(element.x || 0) * scale;
  const y = ty + Number(element.y || 0) * scale;
  const w = Math.max(72, Number(element.width || 80) * scale);
  const h = Math.max(42, Number(element.height || 44) * scale);
  const label = element.label?.text || element.text || element.id || "";
  const parts = [
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="16" fill="${PALETTE.fills[colorIndex]}" stroke="${PALETTE.accents[colorIndex]}" stroke-width="2"/>`,
  ];
  const lines = wrapText(label, Math.max(8, Math.floor(w / 9)));
  const startY = y + h / 2 - ((lines.length - 1) * 14) / 2 + 5;
  lines.forEach((line, index) => {
    parts.push(`<text x="${(x + w / 2).toFixed(1)}" y="${(startY + index * 17).toFixed(1)}" text-anchor="middle" class="node" font-size="15">${escapeXml(line)}</text>`);
  });
  return parts;
}

function arrowSvg(element, transform) {
  const { scale, tx, ty } = transform;
  const x = tx + Number(element.x || 0) * scale;
  const y = ty + Number(element.y || 0) * scale;
  const points = (element.points || []).map(([px, py]) => `${(x + Number(px || 0) * scale).toFixed(1)},${(y + Number(py || 0) * scale).toFixed(1)}`);
  if (points.length < 2) return [];
  return [`<polyline points="${points.join(" ")}" fill="none" stroke="${PALETTE.stroke}" stroke-width="2.4" marker-end="url(#arrowhead)"/>`];
}

function serializeSvg(elements, { width, height, title }) {
  const transform = transformFor(elements, { width, height, title });
  const idToColor = new Map();
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title || "Diagram")}">`,
    "<defs>",
    '<marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#334155"/></marker>',
    "<style>.title{font-family:Georgia,Calibri,Arial,sans-serif;font-weight:700;fill:#0f172a}.node{font-family:Calibri,Arial,sans-serif;font-weight:600;fill:#0f172a}.edge{font-family:Calibri,Arial,sans-serif;fill:#64748b}</style>",
    "</defs>",
    `<rect width="100%" height="100%" rx="24" fill="${PALETTE.background}"/>`,
    ...titleSvg(title),
  ];
  for (const element of elements.filter((item) => item.type !== "arrow")) {
    const colorIndex = idToColor.size % PALETTE.fills.length;
    idToColor.set(element.id, colorIndex);
    parts.push(...nodeSvg(element, transform, colorIndex));
  }
  for (const element of elements.filter((item) => item.type === "arrow")) {
    parts.push(...arrowSvg(element, transform));
  }
  parts.push("</svg>");
  return parts.join("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mermaid = fs.readFileSync(args.mermaidFile, "utf8");
  if (!mermaid.trim()) {
    throw new Error("Mermaid input is empty");
  }
  await installDom();
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const parsed = await parseMermaidToExcalidraw(mermaid, {
    themeVariables: { fontSize: "20px" },
    flowchart: { curve: "linear" },
  });
  const elements = Array.isArray(parsed.elements) ? parsed.elements : parsed;
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error("Mermaid conversion produced no elements");
  }
  fs.mkdirSync(path.dirname(path.resolve(args.svgFile)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(args.sceneFile)), { recursive: true });
  fs.writeFileSync(args.sceneFile, JSON.stringify({ type: "excalidraw", version: 2, source: "sophia-builder", elements, files: parsed.files || {}, appState: { viewBackgroundColor: PALETTE.background, name: args.title || "Diagram" } }, null, 2));
  fs.writeFileSync(args.svgFile, serializeSvg(elements, args));
  console.error(`DIAGRAM diagnostics: elements=${elements.length} width=${args.width} height=${args.height}`);
}

main().catch((error) => {
  console.error(`DIAGRAM_FAIL reason=${error?.name || "Error"} detail=${error?.message || String(error)}`);
  process.exit(1);
});
