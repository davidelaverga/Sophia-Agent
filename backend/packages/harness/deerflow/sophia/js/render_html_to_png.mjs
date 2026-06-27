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
  // A slide referencing a local asset that was never generated (e.g.
  // `../assets/slide-03.png`) must NOT silently screenshot a broken-image
  // placeholder into a "successful" deck. Track allowed-but-missing local
  // file: subresources and fail the render so build_deck_from_slides reports
  // slide_render_failed and the builder gets a repair turn. (Codex P2,
  // 2026-06-27 — mirrors the render_html_to_pdf.mjs pre-validation.)
  const missingLocalResources = [];
  await page.route("**/*", (route) => {
    const requestUrl = route.request().url();
    if (isAllowedRenderRequest(requestUrl, htmlFile, outputRoot)) {
      const localPath = localRenderPathForUrl(requestUrl);
      if (
        localPath &&
        requestUrl !== pathToFileURL(path.resolve(htmlFile)).href &&
        !fs.existsSync(localPath)
      ) {
        missingLocalResources.push(localPath);
        return route.abort("failed");
      }
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
  return missingLocalResources;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.htmlFile)) {
    throw new Error(`html-file not found: ${args.htmlFile}`);
  }
  const width = Number.isFinite(args.width) && args.width > 0 ? args.width : 1920;
  const height = Number.isFinite(args.height) && args.height > 0 ? args.height : 1080;
  const scale = Number.isFinite(args.scale) && args.scale > 0 ? args.scale : 2;
  fs.mkdirSync(path.dirname(path.resolve(args.pngFile)), { recursive: true });

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
    const missingLocalResources = await installRenderRequestPolicy(page, args.htmlFile);
    await page.goto(`file://${path.resolve(args.htmlFile)}`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    if (missingLocalResources.length > 0) {
      const uniqueMissing = [...new Set(missingLocalResources)];
      throw new Error(`missing local render assets: ${uniqueMissing.slice(0, 8).join(", ")}`);
    }
    // Clip to the exact deck canvas so a slightly-too-tall document still yields
    // a 16:9 frame (no scrollbar, no letterbox).
    await page.screenshot({
      path: args.pngFile,
      clip: { x: 0, y: 0, width, height },
      type: "png",
    });
  } finally {
    await browser.close();
  }

  const bytes = fs.existsSync(args.pngFile) ? fs.statSync(args.pngFile).size : 0;
  if (bytes <= 0) {
    throw new Error(`render produced no bytes at ${args.pngFile}`);
  }
  console.error(`[render_html_to_png] wrote ${args.pngFile} bytes=${bytes}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
