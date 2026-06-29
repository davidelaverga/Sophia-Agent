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

// Clean neutral placeholder served in place of a slide image that was never
// generated, so the slide renders intentionally (no broken-image glyph) and the
// deck still compiles. The render reports the count as a quality warning rather
// than failing — a deck with partial images must ship the slides it has, not die
// at the turn ceiling (prod 019f099a: 2/8 images). (§WS-B fix-forward 2026-06-27.)
const MISSING_ASSET_PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
  '<rect width="100%" height="100%" fill="#ececf2"/>' +
  '<text x="50%" y="50%" font-family="Helvetica,Arial,sans-serif" font-size="34" ' +
  'fill="#9a9aa8" text-anchor="middle" dominant-baseline="middle">visual unavailable</text></svg>';

async function installRenderRequestPolicy(page, htmlFile) {
  const outputRoot = outputRootForHtml(htmlFile);
  // A slide may reference a local asset that was never generated (e.g.
  // `../assets/slide-03.png` when image-gen partially failed). Degrade it to a
  // clean placeholder so the slide renders intentionally and the deck compiles;
  // track the count as a warning (NOT a hard failure). A BLOCKED non-output /
  // symlink-escaping subresource still hard-fails (security — see below).
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
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: MISSING_ASSET_PLACEHOLDER_SVG });
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
const DEFAULT_BG_COLOR = "#0e1626";
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
    // Blocked (non-output / symlink-escaping) subresources are a security stop —
    // still hard-fail. Missing local assets were degraded to placeholders above
    // and are reported as a warning below, NOT a failure.
    if (blockedSubresources.length > 0) {
      const uniqueBlocked = [...new Set(blockedSubresources)];
      throw new Error(`blocked non-output render assets: ${uniqueBlocked.slice(0, 8).join(", ")}`);
    }
    const uniqueMissing = [...new Set(missingLocalResources)];
    if (uniqueMissing.length > 0) {
      console.error(
        `[render_html_to_png] degraded ${uniqueMissing.length} missing local asset(s) to placeholder: ` +
          uniqueMissing.slice(0, 8).join(", "),
      );
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
  console.error(`[render_html_to_png] wrote ${args.pngFile} bytes=${bytes} missing_assets=${missingForReport}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
