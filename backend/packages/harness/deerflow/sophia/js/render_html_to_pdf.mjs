// Render a self-contained HTML report to PDF via headless Chromium.
//
// Sophia PDF reports are authored as one HTML file with INLINE <svg> charts /
// diagrams (deterministic, local — no remote chart service). This script loads
// the HTML in headless Chromium (already installed; playwright-core is bundled
// beside this file) and prints it to PDF. Inline SVG rasterizes crisply at
// print DPI; relative <img src="visuals/..."> refs for the bounded conceptual
// images resolve because we open the file via file:// (its own directory is the
// base URL).
//
// Usage: node render_html_to_pdf.mjs --html-file <abs.html> --pdf-file <abs.pdf> [--margin 16mm]
// Prints "[render_html_to_pdf] wrote <pdf> bytes=N" to stderr; exits non-zero on failure.

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
    } else if (value === "--pdf-file") {
      args.pdfFile = argv[++index];
    } else if (value === "--margin") {
      args.margin = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.htmlFile || !args.pdfFile) {
    throw new Error("--html-file and --pdf-file are required");
  }
  return args;
}

// Right-aligned page numbers in the print footer so the model never has to
// compute pagination. Header is intentionally empty (the cover/running title
// lives in the document's own CSS).
const FOOTER_TEMPLATE =
  '<div style="width:100%;font-size:8px;color:#888;padding:0 12mm;text-align:right;">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';
const HEADER_TEMPLATE = "<div></div>";

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
  try {
    return isInsideDirectory(path.resolve(fileURLToPath(url)), outputRoot);
  } catch {
    return false;
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
  const margin = args.margin || "16mm";
  fs.mkdirSync(path.dirname(path.resolve(args.pdfFile)), { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SOPHIA_CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
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
    await page.pdf({
      path: args.pdfFile,
      format: "A4",
      printBackground: true,
      margin: { top: margin, bottom: margin, left: margin, right: margin },
      displayHeaderFooter: true,
      headerTemplate: HEADER_TEMPLATE,
      footerTemplate: FOOTER_TEMPLATE,
    });
  } finally {
    await browser.close();
  }

  const bytes = fs.existsSync(args.pdfFile) ? fs.statSync(args.pdfFile).size : 0;
  if (bytes <= 0) {
    throw new Error(`render produced no bytes at ${args.pdfFile}`);
  }
  console.error(`[render_html_to_pdf] wrote ${args.pdfFile} bytes=${bytes}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
