import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import PptxGenJS from "pptxgenjs";

const OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/";
const DEFAULT_THEME = "sophia_light";
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

const THEMES = {
  sophia_light: {
    bg: "FFFFFF",
    ink: "1F2A37",
    muted: "6B7787",
    accent: "2E5AAC",
  },
  sophia_warm: {
    bg: "FFFFFF",
    ink: "1F2A37",
    muted: "6B7787",
    accent: "E76F51",
  },
};

function parseArgs(argv) {
  const args = { slideImages: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--plan-file") {
      args.planFile = argv[++index];
    } else if (value === "--output-file") {
      args.outputFile = argv[++index];
    } else if (value === "--slide-images") {
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        args.slideImages.push(argv[++index]);
      }
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.planFile || !args.outputFile) {
    throw new Error("--plan-file and --output-file are required");
  }
  return args;
}

function loadPlan(planFile) {
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Invalid presentation plan: top-level JSON must be an object");
  }
  return plan;
}

function asString(value, fallback = "") {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function inferOutputsRoot(outputFile) {
  let current = path.resolve(outputFile);
  if (!path.basename(current).includes(".")) {
    current = path.join(current, "placeholder");
  }
  let dir = path.dirname(current);
  while (dir && dir !== path.dirname(dir)) {
    if (path.basename(dir) === "outputs") {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(outputFile));
}

function resolveAssetPath(rawPath, planFile, outputFile) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return null;
  }
  const normalized = rawPath.trim().replaceAll("\\", "/");
  if (normalized.startsWith(OUTPUTS_VIRTUAL_PREFIX)) {
    const relative = normalized.slice(OUTPUTS_VIRTUAL_PREFIX.length).replace(/^\/+/, "");
    if (relative.split("/").includes("..")) {
      throw new Error("Slide asset path may not contain '..'");
    }
    return path.resolve(inferOutputsRoot(outputFile), relative);
  }
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.resolve(path.dirname(planFile), normalized);
}

function slideVisualPath(slideInfo, planFile, outputFile) {
  return resolveAssetPath(
    slideInfo.image_path || slideInfo.image,
    planFile,
    outputFile,
  );
}

function usablePlanVisualPath(visualPath, slideNumber) {
  if (!visualPath) {
    throw new Error(`Slide ${slideNumber} is missing a generated slide image`);
  }
  if (fs.existsSync(visualPath)) {
    return visualPath;
  }
  throw new Error(`Slide ${slideNumber} image is missing: ${visualPath}`);
}

function resolveTheme(plan) {
  const requested = asString(plan.theme || plan.design_system || plan.palette, DEFAULT_THEME);
  return THEMES[requested] || THEMES[DEFAULT_THEME];
}

function newSlide(pptx, theme) {
  const slide = pptx.addSlide();
  slide.background = { color: theme.bg };
  return slide;
}

function fullBleedImageSizing() {
  return { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };
}

function addFullBleedVisual(slide, visualPath) {
  if (!visualPath || !fs.existsSync(visualPath)) {
    return false;
  }
  slide.addImage({
    path: visualPath,
    ...fullBleedImageSizing(),
  });
  return true;
}

function addNotes(slide, slideInfo) {
  const notes = asString(slideInfo.notes || slideInfo.speaker_notes || slideInfo.narrative, "");
  if (notes) {
    slide.addNotes(notes);
  }
}

function renderImageForward(pptx, slideInfo, theme, visualPath, index) {
  const slide = newSlide(pptx, theme);
  if (!addFullBleedVisual(slide, visualPath)) {
    return null;
  }
  addNotes(slide, slideInfo);
  return {
    slide,
    diagnostics: {
      index,
      image_forward: true,
      visual_path: visualPath,
      native_title_overlay: false,
      native_caption_overlay: false,
      text_runs: 0,
      picture_count: 1,
    },
  };
}

export function renderSlide(pptx, slideInfo, plan, theme, visualPath) {
  const resolvedTheme = theme || resolveTheme(plan || {});
  return renderImageForward(pptx, slideInfo, resolvedTheme, visualPath, 0)?.slide || null;
}

function compiledSlideContext(pptx, slideInfo, plan, theme, args, index) {
  const cliVisualPath = args.slideImages[index]
    ? resolveAssetPath(args.slideImages[index], args.planFile, args.outputFile)
    : null;
  const plannedVisualPath = slideVisualPath(slideInfo, args.planFile, args.outputFile);
  const visualPath = usablePlanVisualPath(cliVisualPath || plannedVisualPath, index + 1);
  const rendered = renderImageForward(pptx, slideInfo, theme, visualPath, index);
  if (!rendered) {
    throw new Error(`Slide ${index + 1} could not be rendered in image-only mode`);
  }
  return rendered;
}

export function renderCompiledSlide(pptx, slideInfo, plan, theme, args, index) {
  const rendered = compiledSlideContext(pptx, slideInfo, plan, theme, args, index);
  const title = asString(slideInfo.title, `Slide ${index + 1}`);
  console.error(
    `[compile_pptx] slide ${index + 1}: mode=image-only title="${title}" visual="${rendered.diagnostics.visual_path}"`,
  );
  return rendered;
}

export function incrementTextRunCount(count) {
  return count;
}

export function incrementPictureCount(count, visualPath) {
  return visualPath ? count + 1 : count;
}

function compilePptx(plan, args) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Sophia";
  pptx.company = "Sophia";
  pptx.subject = asString(plan.title, "Sophia presentation");
  pptx.title = asString(plan.title, "Sophia presentation");
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: "Calibri",
    bodyFontFace: "Calibri",
    lang: "en-US",
  };
  pptx.defineLayout({ name: "LAYOUT_WIDE", width: SLIDE_W, height: SLIDE_H });

  const slides = Array.isArray(plan.slides) ? plan.slides : [];
  if (!slides.length) {
    throw new Error("Presentation plan must contain at least one slide");
  }

  const theme = resolveTheme(plan);
  const diagnostics = [];
  let textRuns = 0;
  let pictureCount = 0;

  slides.forEach((slideInfo, index) => {
    const rendered = renderCompiledSlide(pptx, slideInfo, plan, theme, args, index);
    diagnostics.push(rendered.diagnostics);
    textRuns = incrementTextRunCount(textRuns);
    pictureCount = incrementPictureCount(pictureCount, rendered.diagnostics.visual_path);
  });

  pptx._sophiaDiagnostics = {
    slide_count: slides.length,
    text_run_count: textRuns,
    picture_count: pictureCount,
    image_forward_slide_count: slides.length,
    slides: diagnostics,
  };
  return pptx;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = loadPlan(args.planFile);
  const pptx = compilePptx(plan, args);
  fs.mkdirSync(path.dirname(path.resolve(args.outputFile)), { recursive: true });
  await pptx.writeFile({ fileName: args.outputFile });
  console.error(
    `[compile_pptx] wrote ${args.outputFile} slides=${pptx._sophiaDiagnostics.slide_count} pictures=${pptx._sophiaDiagnostics.picture_count} text_runs=${pptx._sophiaDiagnostics.text_run_count}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
