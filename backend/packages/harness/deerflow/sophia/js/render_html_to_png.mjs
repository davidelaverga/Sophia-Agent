// Render a self-contained HTML slide to a PNG via headless Chromium.
//
// Sophia decks are authored as one self-contained HTML file per slide (real DOM
// text + a generated image referenced by a RELATIVE `../assets/<file>` path).
// The harness renders each slide HTML to a full-bleed PNG at exactly the deck
// canvas size, then wraps the PNGs into a .pptx (compile_pptx.mjs). This is the
// deck analog of render_html_to_pdf.mjs — same Chromium engine, file:// load so
// relative asset refs resolve from the slide's own directory.
//
// Usage:
//   node render_html_to_png.mjs --html-file <abs.html> --png-file <abs.png> \
//        [--width 1920] [--height 1080] [--scale 2]
// Prints "[render_html_to_png] wrote <png> bytes=N" to stderr; exits non-zero on failure.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--html-file") {
      args.htmlFile = argv[++index];
    } else if (value === "--png-file") {
      args.pngFile = argv[++index];
    } else if (value === "--width") {
      args.width = parseInt(argv[++index], 10);
    } else if (value === "--height") {
      args.height = parseInt(argv[++index], 10);
    } else if (value === "--scale") {
      args.scale = parseFloat(argv[++index]);
    } else if (value === "--bg-color") {
      args.bgColor = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.htmlFile || !args.pngFile) {
    throw new Error("--html-file and --png-file are required");
  }
  return args;
}

function outputRootForHtml(htmlFile) {
  const resolved = path.resolve(htmlFile);
  const parts = resolved.split(path.sep);
  const outputIndex = parts.lastIndexOf("outputs");
  if (outputIndex >= 0) {
    return parts.slice(0, outputIndex + 1).join(path.sep) || path.sep;
  }
  return path.dirname(resolved);
}

function isInsideDirectory(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAllowedRenderRequest(url, htmlFile, outputRoot) {
  if (url === pathToFileURL(path.resolve(htmlFile)).href) {
    return true;
  }
  if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") {
    return true;
  }
  if (!url.startsWith("file:")) {
    return false;
  }
  let candidate;
  try {
    candidate = path.resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  try {
    // Resolve symlinks: a real existing asset must stay under the REAL outputs
    // root, so a symlinked asset pointing outside outputs cannot smuggle an
    // outside file into the rendered deliverable (Codex P1, 2026-06-27).
    return isInsideDirectory(fs.realpathSync(candidate), fs.realpathSync(outputRoot));
  } catch {
    // Missing target (or missing file): fall back to the lexical check so a
    // genuinely-absent asset is still recognized/tracked downstream — a
    // nonexistent path discloses nothing.
    return isInsideDirectory(candidate, outputRoot);
  }
}

function localRenderPathForUrl(url) {
  if (!url.startsWith("file:")) {
    return null;
  }
  try {
    return path.resolve(fileURLToPath(url));
  } catch {
    return null;
  }
}

async function installRenderRequestPolicy(page, htmlFile) {
  const outputRoot = outputRootForHtml(htmlFile);
  // A slide may reference a local asset that was never generated (e.g.
  // `../assets/slide-03.png` when image-gen partially failed). Treat that as a
  // render failure: normal PPTX decks require generated visuals, and compiling a
  // screenshot with a broken/placeholder image hides the real build defect.
  const missingLocalResources = [];
  const blockedSubresources = [];
  await page.route("**/*", (route) => {
    const requestUrl = route.request().url();
    if (isAllowedRenderRequest(requestUrl, htmlFile, outputRoot)) {
      const localPath = localRenderPathForUrl(requestUrl);
      if (
        localPath &&
        requestUrl !== pathToFileURL(path.resolve(htmlFile)).href &&
        !fs.existsSync(localPath)
      ) {
        const resourceType = route.request().resourceType();
        if (resourceType !== "image") {
          blockedSubresources.push(`${resourceType}:${requestUrl}`);
          return route.abort("failed");
        }
        missingLocalResources.push(localPath);
        return route.abort("failed");
      }
      return route.continue();
    }
    const request = route.request();
    const resourceType = request.resourceType();
    if (requestUrl !== pathToFileURL(path.resolve(htmlFile)).href) {
      blockedSubresources.push(`${resourceType}:${requestUrl}`);
    }
    return route.abort("blockedbyclient");
  });
  return { missingLocalResources, blockedSubresources };
}

// Parse #RRGGBB / #RGB into a CDP RGBA object (alpha 1). Falls back to the deck
// navy on anything unparseable so the base-background override is always opaque.
const DEFAULT_BG_COLOR = "#f7f9fc";
function hexToCdpRgba(hex) {
  const fallback = { r: 14, g: 22, b: 38, a: 1 };
  if (typeof hex !== "string") {
    return fallback;
  }
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value.split("").map((char) => char + char).join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    return fallback;
  }
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
    a: 1,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.htmlFile)) {
    throw new Error(`html-file not found: ${args.htmlFile}`);
  }
  const width = Number.isFinite(args.width) && args.width > 0 ? args.width : 1920;
  const height = Number.isFinite(args.height) && args.height > 0 ? args.height : 1080;
  const scale = Number.isFinite(args.scale) && args.scale > 0 ? args.scale : 2;
  const bgColor = typeof args.bgColor === "string" && args.bgColor.trim() ? args.bgColor.trim() : DEFAULT_BG_COLOR;
  fs.mkdirSync(path.dirname(path.resolve(args.pngFile)), { recursive: true });

  let missingForReport = 0;
  let overflowForReport = 0;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SOPHIA_CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    const { missingLocalResources, blockedSubresources } = await installRenderRequestPolicy(page, args.htmlFile);
    await page.goto(`file://${path.resolve(args.htmlFile)}`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    // Blocked (non-output / symlink-escaping) subresources are a security stop.
    // Missing local images are also a correctness stop for deck builds: a slide
    // that references an absent generated visual is not ready to compile.
    if (blockedSubresources.length > 0) {
      const uniqueBlocked = [...new Set(blockedSubresources)];
      throw new Error(`blocked non-output render assets: ${uniqueBlocked.slice(0, 8).join(", ")}`);
    }
    const uniqueMissing = [...new Set(missingLocalResources)];
    if (uniqueMissing.length > 0) {
      throw new Error(`missing local render assets: ${uniqueMissing.slice(0, 8).join(", ")}`);
    }
    // Force an opaque base background so any region the slide HTML leaves
    // uncovered renders as the deck color, not Chromium's default WHITE (the
    // white-band defect, prod 019f0b8a: a model-authored layout whose gutters
    // fell on the unpainted body). CDP's default-background override is
    // JS-independent (page JS is disabled here) and an opaque `.slide` still
    // paints on top — only uncovered/transparent regions pick up this base.
    // omitBackground stays unset so the override is captured. Non-fatal.
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: hexToCdpRgba(bgColor) });
      // Slide-quality overflow probe (FIX 2, 2026-06-30). The screenshot clips to
      // the 16:9 canvas, so content that overruns the 1080-tall frame is silently
      // cut off (cramped/clipped text — the page-1 defect). page JS is disabled,
      // so measure layout via CDP (not page.evaluate): cssContentSize is the full
      // scrollable content rect in CSS px; the excess over the viewport is the
      // clipped amount. Reported on stderr; build_deck_from_slides aggregates it
      // and SlideQualityMiddleware gates one bounded re-author on it. Non-fatal.
      try {
        const metrics = await cdp.send("Page.getLayoutMetrics");
        const content = metrics.cssContentSize || metrics.contentSize || {};
        const overV = Math.max(0, Math.round((content.height || 0) - height));
        const overH = Math.max(0, Math.round((content.width || 0) - width));
        overflowForReport = Math.max(overV, overH);
      } catch {
        // Layout-metrics unavailable — report no overflow (gate stays permissive).
      }
    } catch {
      // CDP unavailable — fall back to pre-fix behavior (white default).
    }
    // Clip to the exact deck canvas so a slightly-too-tall document still yields
    // a 16:9 frame (no scrollbar, no letterbox).
    await page.screenshot({
      path: args.pngFile,
      clip: { x: 0, y: 0, width, height },
      type: "png",
    });
    missingForReport = uniqueMissing.length;
  } finally {
    await browser.close();
  }

  const bytes = fs.existsSync(args.pngFile) ? fs.statSync(args.pngFile).size : 0;
  if (bytes <= 0) {
    throw new Error(`render produced no bytes at ${args.pngFile}`);
  }
  // Machine-readable so build_deck_from_slides can aggregate a quality_warning.
  console.error(
    `[render_html_to_png] wrote ${args.pngFile} bytes=${bytes} missing_assets=${missingForReport} overflow=${overflowForReport}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
