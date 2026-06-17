import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import PptxGenJS from "pptxgenjs";

const OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/";
const SHAPE = {
  rect: "rect",
  roundRect: "roundRect",
};

// Office-safe brand fonts (never Aptos or Georgia — wrong metrics under QA renderer).
const FONT_HEAD = "Cambria";
const FONT_BODY = "Calibri";

// Brand themes — bare hex only (no leading '#'), compiled from skills/public/sophia/brand/tokens.md.
const THEMES = {
  sophia_light: {
    bg: "FFFFFF",
    surface: "F5F7FA",
    ink: "1F2A37",
    body: "3A4658",
    muted: "6B7787",
    line: "E3E8EF",
    accent: "2E5AAC",
    accent2: "2A9D8F",
  },
  sophia_warm: {
    bg: "FFFFFF",
    surface: "F5F7FA",
    ink: "1F2A37",
    body: "3A4658",
    muted: "6B7787",
    line: "E3E8EF",
    accent: "E76F51",
    accent2: "2A9D8F",
  },
};

const DEFAULT_THEME = "sophia_light";
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

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

function listFrom(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
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
    slideInfo.image_path || slideInfo.image || slideInfo.chart_path || slideInfo.visual_path,
    planFile,
    outputFile,
  );
}

function usablePlanVisualPath(visualPath) {
  if (!visualPath) return null;
  if (fs.existsSync(visualPath)) return visualPath;
  console.error(`Slide image missing, using text layout: ${visualPath}`);
  return null;
}

function normalizeLayout(value) {
  return asString(value, "")
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");
}

// Resolve the canonical slide type, mapping legacy/back-compat names onto the new set.
function slideType(slideInfo) {
  const raw = normalizeLayout(slideInfo.type) || normalizeLayout(slideInfo.layout) || "content";
  if (raw === "title") return "cover";
  if (["section_divider", "divider"].includes(raw)) return "section";
  if (["statement", "closing", "quote", "closer"].includes(raw)) return "statement";
  if (["conclusion", "takeaways"].includes(raw)) return "summary";
  if (["stat_band", "metrics"].includes(raw)) return "stat";
  if (["title_visual", "cover"].includes(raw)) return "cover";
  return raw;
}

// Resolve the content subtype (only meaningful when type === "content").
function contentSubtype(slideInfo) {
  const raw = normalizeLayout(slideInfo.subtype) || normalizeLayout(slideInfo.layout);
  if (["text_visual", "text+visual"].includes(raw)) return "text+visual";
  if (["two_column", "two_columns", "2_column", "2_columns", "comparison", "matrix"].includes(raw)) {
    return "two-column";
  }
  if (["full_visual", "full-visual"].includes(raw)) return "full-visual";
  if (raw === "stat") return "stat";
  return "text+visual";
}

// Clone a base options object per addText — never share a mutated object (PptxGenJS bug).
function withOpts(base, overrides) {
  return Object.assign({}, base, overrides);
}

function slideBullets(slideInfo) {
  const direct = listFrom(slideInfo.body)
    .concat(listFrom(slideInfo.key_points), listFrom(slideInfo.bullets), listFrom(slideInfo.points));
  if (direct.length) {
    return direct;
  }
  return slideColumns(slideInfo)
    .flatMap((column) => {
      const heading = columnHeading(column);
      return heading ? [heading, ...columnPoints(column)] : columnPoints(column);
    });
}

function slideColumns(slideInfo) {
  if (!Array.isArray(slideInfo.columns)) {
    return [];
  }
  return slideInfo.columns.filter((column) => column && typeof column === "object").slice(0, 2);
}

function columnHeading(column) {
  return asString(column.heading || column.title || column.label, "");
}

function columnPoints(column) {
  return listFrom(column.points).concat(listFrom(column.key_points), listFrom(column.bullets)).slice(0, 6);
}

function addFooter(slide, theme, index, total) {
  slide.addText(`${index + 1}/${total}`, {
    x: 11.7,
    y: 6.98,
    w: 0.8,
    h: 0.22,
    fontFace: FONT_BODY,
    fontSize: 8,
    color: theme.muted,
    align: "right",
    margin: 0,
  });
}

// Add a title clamped to a width budget so it shrinks rather than wrapping into following text.
function addTitle(slide, title, theme, box) {
  slide.addText(title, withOpts(
    {
      fontFace: FONT_HEAD,
      bold: true,
      color: theme.ink,
      fit: "shrink",
      breakLine: false,
      margin: 0,
    },
    box,
  ));
}

function addBullets(slide, bullets, theme, box) {
  if (!bullets.length) return;
  const visibleBullets = bullets.slice(0, box.max || 6);
  const runs = visibleBullets.map((bullet) => ({
    text: bullet,
    options: { bullet: { type: "bullet" }, breakLine: true },
  }));
  const paraSpaceAfterPt = box.spaceAfter ?? Math.max(4, Math.min(12, 34 / Math.max(visibleBullets.length, 1)));
  slide.addText(runs, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fontFace: FONT_BODY,
    fontSize: box.fontSize || 18,
    color: theme.body,
    breakLine: false,
    fit: "shrink",
    valign: "middle",
    margin: 0.06,
    paraSpaceAfterPt,
  });
}

function addVisual(slide, visualPath, box) {
  if (!visualPath) return false;
  if (!fs.existsSync(visualPath)) {
    throw new Error(`Slide visual not found: ${visualPath}`);
  }
  slide.addImage({
    path: visualPath,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    sizing: { type: "contain", x: box.x, y: box.y, w: box.w, h: box.h },
  });
  return true;
}

function addFullBleedVisual(slide, visualPath) {
  if (!visualPath) return false;
  if (!fs.existsSync(visualPath)) {
    console.error(`Slide image missing, using text layout: ${visualPath}`);
    return false;
  }
  slide.addImage({
    path: visualPath,
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    sizing: { type: "cover", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H },
  });
  return true;
}

function isImageForwardSlide(slideInfo) {
  return typeof slideInfo.image_path === "string" && slideInfo.image_path.trim();
}

// A surface card with a line border (no stripe). Used by stat / visual surfaces.
function addCard(slide, theme, box) {
  slide.addShape(SHAPE.roundRect, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    rectRadius: box.radius || 0.12,
    fill: { color: theme.surface },
    line: { color: theme.line, width: 1 },
  });
}

function newSlide(pptx, theme) {
  const slide = pptx.addSlide();
  slide.background = { color: theme.bg };
  return slide;
}

// 1. cover — title + subtitle, optional image (right-half or full-bleed). No accent bar.
function renderCover(pptx, slideInfo, plan, theme, visualPath) {
  const slide = newSlide(pptx, theme);
  const hasImage = Boolean(visualPath);
  if (hasImage) {
    addVisual(slide, visualPath, { x: 7.3, y: 0.42, w: 5.35, h: 6.6 });
  }
  const textWidth = hasImage ? 6.0 : 11.3;
  addTitle(slide, asString(slideInfo.title, plan.title || "Presentation"), theme, {
    x: 0.82,
    y: 2.0,
    w: textWidth,
    h: 1.6,
    fontSize: 40,
  });
  const subtitle = asString(slideInfo.subtitle, plan.subtitle || "");
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.84,
      y: 3.7,
      w: textWidth,
      h: 0.7,
      fontFace: FONT_BODY,
      fontSize: 18,
      color: theme.muted,
      fit: "shrink",
      breakLine: false,
      margin: 0,
    });
  }
  return slide;
}

// 2. agenda — title + 3–6 numbered items (number accent, text body), generous spacing.
function renderAgenda(pptx, slideInfo, theme) {
  const slide = newSlide(pptx, theme);
  addTitle(slide, asString(slideInfo.title, "Agenda"), theme, {
    x: 0.72, y: 0.52, w: 11.8, h: 0.7, fontSize: 28,
  });
  const items = slideBullets(slideInfo).slice(0, 6);
  const top = 1.85;
  const step = items.length ? Math.min(0.92, 4.6 / items.length) : 0.92;
  items.forEach((item, idx) => {
    const y = top + idx * step;
    slide.addText(String(idx + 1), {
      x: 0.85,
      y,
      w: 0.7,
      h: 0.6,
      fontFace: FONT_HEAD,
      fontSize: 26,
      bold: true,
      color: theme.accent,
      align: "left",
      valign: "top",
      margin: 0,
    });
    slide.addText(item, {
      x: 1.7,
      y,
      w: 10.4,
      h: 0.6,
      fontFace: FONT_BODY,
      fontSize: 18,
      color: theme.body,
      valign: "top",
      fit: "shrink",
      breakLine: false,
      margin: 0,
    });
  });
  return slide;
}

// 3. section — large short title + optional image.
function renderSection(pptx, slideInfo, theme, visualPath) {
  const slide = newSlide(pptx, theme);
  const hasImage = Boolean(visualPath);
  if (hasImage) {
    addVisual(slide, visualPath, { x: 7.2, y: 0.75, w: 5.0, h: 5.55 });
  }
  addTitle(slide, asString(slideInfo.title, "Section"), theme, {
    x: 0.82,
    y: 2.7,
    w: hasImage ? 5.9 : 10.8,
    h: 1.4,
    fontSize: 36,
  });
  return slide;
}

// 4a. content / text+visual — bullets left, visual right (column-sized, line border, no overlap).
function renderTextVisual(pptx, slideInfo, theme, visualPath) {
  const slide = newSlide(pptx, theme);
  addTitle(slide, asString(slideInfo.title, "Untitled"), theme, {
    x: 0.72, y: 0.52, w: 11.8, h: 0.7, fontSize: 26,
  });
  if (visualPath) {
    addCard(slide, theme, { x: 7.15, y: 1.6, w: 5.35, h: 4.85 });
    addVisual(slide, visualPath, { x: 7.35, y: 1.8, w: 4.95, h: 4.45 });
    addBullets(slide, slideBullets(slideInfo), theme, {
      x: 0.82, y: 1.7, w: 5.95, h: 4.7, fontSize: 18, max: 6,
    });
  } else {
    addBullets(slide, slideBullets(slideInfo), theme, {
      x: 0.9, y: 1.7, w: 10.9, h: 4.7, fontSize: 18, max: 6,
    });
  }
  return slide;
}

// 4b. content / stat — huge figure (accent), label (muted), optional support. No chart.
function renderStat(pptx, slideInfo, theme) {
  const slide = newSlide(pptx, theme);
  const title = asString(slideInfo.title, "");
  if (title) {
    addTitle(slide, title, theme, { x: 0.72, y: 0.52, w: 11.8, h: 0.7, fontSize: 26 });
  }
  addCard(slide, theme, { x: 2.6, y: 2.1, w: 8.1, h: 3.2, radius: 0.16 });
  slide.addText(asString(slideInfo.stat || slideInfo.value || slideInfo.metric, ""), {
    x: 2.8,
    y: 2.35,
    w: 7.7,
    h: 1.7,
    fontFace: FONT_HEAD,
    fontSize: 72,
    bold: true,
    color: theme.accent,
    align: "center",
    fit: "shrink",
    breakLine: false,
    margin: 0,
  });
  slide.addText(asString(slideInfo.stat_label || slideInfo.label, ""), {
    x: 2.8,
    y: 4.15,
    w: 7.7,
    h: 0.5,
    fontFace: FONT_BODY,
    fontSize: 18,
    color: theme.muted,
    align: "center",
    fit: "shrink",
    breakLine: false,
    margin: 0,
  });
  const support = asString(slideInfo.support || slideInfo.subtitle, "");
  if (support) {
    slide.addText(support, {
      x: 2.6,
      y: 5.45,
      w: 8.1,
      h: 0.7,
      fontFace: FONT_BODY,
      fontSize: 14,
      color: theme.body,
      align: "center",
      fit: "shrink",
      breakLine: false,
      margin: 0,
    });
  }
  return slide;
}

// 4c. content / two-column — two balanced text (or text+small-visual) columns.
function renderTwoColumn(pptx, slideInfo, theme) {
  const slide = newSlide(pptx, theme);
  addTitle(slide, asString(slideInfo.title, "Comparison"), theme, {
    x: 0.72, y: 0.52, w: 11.8, h: 0.7, fontSize: 26,
  });
  const explicit = slideColumns(slideInfo);
  const items = slideBullets(slideInfo);
  const columns = explicit.length
    ? [
        { heading: columnHeading(explicit[0]), points: columnPoints(explicit[0]) },
        { heading: columnHeading(explicit[1] || {}), points: columnPoints(explicit[1] || {}) },
      ]
    : [
        { heading: "", points: items.filter((_, i) => i % 2 === 0) },
        { heading: "", points: items.filter((_, i) => i % 2 === 1) },
      ];
  [0, 1].forEach((columnIndex) => {
    const x = 0.82 + columnIndex * 6.1;
    addCard(slide, theme, { x, y: 1.62, w: 5.55, h: 4.7 });
    const heading = columns[columnIndex].heading;
    if (heading) {
      slide.addText(heading, {
        x: x + 0.34,
        y: 1.86,
        w: 4.9,
        h: 0.4,
        fontFace: FONT_HEAD,
        fontSize: 17,
        bold: true,
        color: theme.ink,
        fit: "shrink",
        breakLine: false,
        margin: 0,
      });
    }
    addBullets(slide, columns[columnIndex].points, theme, {
      x: x + 0.32,
      y: heading ? 2.42 : 2.0,
      w: 4.9,
      h: heading ? 3.7 : 4.1,
      fontSize: 14,
      max: 6,
    });
  });
  return slide;
}

// 4d. content / full-visual — title bar + single large image + optional caption.
function renderFullVisual(pptx, slideInfo, theme, visualPath) {
  const slide = newSlide(pptx, theme);
  const title = asString(slideInfo.title, "");
  if (title) {
    addTitle(slide, title, theme, { x: 0.72, y: 0.4, w: 11.8, h: 0.6, fontSize: 24 });
  }
  const caption = asString(slideInfo.caption, "");
  const imageTop = title ? 1.15 : 0.55;
  const imageHeight = caption ? 5.0 : 5.6;
  addVisual(slide, visualPath, { x: 0.82, y: imageTop, w: 11.7, h: imageHeight });
  if (caption) {
    slide.addText(caption, {
      x: 0.82,
      y: imageTop + imageHeight + 0.1,
      w: 11.7,
      h: 0.4,
      fontFace: FONT_BODY,
      fontSize: 12,
      color: theme.muted,
      align: "center",
      fit: "shrink",
      breakLine: false,
      margin: 0,
    });
  }
  return slide;
}

function renderContent(pptx, slideInfo, theme, visualPath) {
  const subtype = contentSubtype(slideInfo);
  if (subtype === "stat") return renderStat(pptx, slideInfo, theme);
  if (subtype === "two-column") return renderTwoColumn(pptx, slideInfo, theme);
  if (subtype === "full-visual") return renderFullVisual(pptx, slideInfo, theme, visualPath);
  return renderTextVisual(pptx, slideInfo, theme, visualPath);
}

function firstPresentText(values, fallback = "") {
  const normalized = values.map((value) => asString(value, "")).find(Boolean);
  return normalized || fallback;
}

function statementText(slideInfo) {
  return firstPresentText(
    [slideInfo.statement, slideInfo.quote, slideInfo.title, slideInfo.subtitle],
    "A clear next step.",
  );
}

function statementSupport(slideInfo, statement) {
  const support = firstPresentText([slideInfo.attribution, slideInfo.subtitle, slideInfo.support]);
  return support === statement ? "" : support;
}

function statementFontSize(statement) {
  return statement.length > 90 ? 30 : 38;
}

function addStatementSupport(slide, support, theme) {
  if (!support) return;
  slide.addText(support, {
    x: 2.2,
    y: 4.25,
    w: 8.9,
    h: 0.46,
    fontFace: FONT_BODY,
    fontSize: 16,
    color: theme.accent,
    align: "center",
    fit: "shrink",
    margin: 0,
  });
}

function renderStatement(pptx, slideInfo, theme) {
  const slide = newSlide(pptx, theme);
  slide.background = { color: theme.surface };
  slide.addShape(SHAPE.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    fill: { color: theme.surface },
    line: { color: theme.surface, transparency: 100 },
  });
  const statement = statementText(slideInfo);
  slide.addText(statement, {
    x: 1.35,
    y: 2.35,
    w: 10.65,
    h: 1.65,
    fontFace: FONT_HEAD,
    fontSize: statementFontSize(statement),
    bold: true,
    color: theme.ink,
    align: "center",
    valign: "middle",
    fit: "shrink",
    margin: 0,
  });
  addStatementSupport(slide, statementSupport(slideInfo, statement), theme);
  return slide;
}

function renderImageForward(pptx, visualPath, theme) {
  const slide = newSlide(pptx, theme);
  return addFullBleedVisual(slide, visualPath) ? slide : null;
}

function renderCoverFromContext(ctx) {
  return renderCover(ctx.pptx, ctx.slideInfo, ctx.plan, ctx.theme, ctx.visualPath);
}

function renderAgendaFromContext(ctx) {
  return renderAgenda(ctx.pptx, ctx.slideInfo, ctx.theme);
}

function renderSectionFromContext(ctx) {
  return renderSection(ctx.pptx, ctx.slideInfo, ctx.theme, ctx.visualPath);
}

function renderStatementFromContext(ctx) {
  return renderStatement(ctx.pptx, ctx.slideInfo, ctx.theme);
}

function renderSummaryFromContext(ctx) {
  return renderSummary(ctx.pptx, ctx.slideInfo, ctx.theme);
}

function renderStatFromContext(ctx) {
  return renderStat(ctx.pptx, ctx.slideInfo, ctx.theme);
}

function renderTwoColumnFromContext(ctx) {
  return renderTwoColumn(ctx.pptx, ctx.slideInfo, ctx.theme);
}

function renderContentFromContext(ctx) {
  return renderContent(ctx.pptx, ctx.slideInfo, ctx.theme, ctx.visualPath);
}

const SLIDE_RENDERERS = {
  cover: renderCoverFromContext,
  agenda: renderAgendaFromContext,
  section: renderSectionFromContext,
  statement: renderStatementFromContext,
  summary: renderSummaryFromContext,
  stat: renderStatFromContext,
};

const TWO_COLUMN_TYPES = new Set(["two_column", "two_columns", "comparison", "matrix"]);

function rendererForSlideType(type) {
  return SLIDE_RENDERERS[type] || (TWO_COLUMN_TYPES.has(type) ? renderTwoColumnFromContext : renderContentFromContext);
}

// 5. summary — title + points mirroring agenda.
function renderSummary(pptx, slideInfo, theme) {
  const slide = newSlide(pptx, theme);
  addTitle(slide, asString(slideInfo.title, "Summary"), theme, {
    x: 0.72, y: 0.52, w: 11.8, h: 0.7, fontSize: 28,
  });
  const items = slideBullets(slideInfo).slice(0, 6);
  const top = 1.85;
  const step = items.length ? Math.min(0.92, 4.6 / items.length) : 0.92;
  items.forEach((item, idx) => {
    const y = top + idx * step;
    slide.addText(String(idx + 1), {
      x: 0.85,
      y,
      w: 0.7,
      h: 0.6,
      fontFace: FONT_HEAD,
      fontSize: 26,
      bold: true,
      color: theme.accent,
      valign: "top",
      margin: 0,
    });
    slide.addText(item, {
      x: 1.7,
      y,
      w: 10.4,
      h: 0.6,
      fontFace: FONT_BODY,
      fontSize: 18,
      color: theme.body,
      valign: "top",
      fit: "shrink",
      breakLine: false,
      margin: 0,
    });
  });
  return slide;
}

function renderSlide(pptx, slideInfo, plan, theme, visualPath) {
  if (isImageForwardSlide(slideInfo) && visualPath) {
    const imageForwardSlide = renderImageForward(pptx, visualPath, theme);
    if (imageForwardSlide) {
      return imageForwardSlide;
    }
  }
  const ctx = { pptx, slideInfo, plan, theme, visualPath };
  return rendererForSlideType(slideType(slideInfo))(ctx);
}

function addNotes(slide, slideInfo) {
  const notes = asString(slideInfo.speaker_notes || slideInfo.notes, "");
  if (notes && typeof slide.addNotes === "function") {
    slide.addNotes(notes);
  }
}

function resolveTheme(plan) {
  const requested = asString(plan.theme, DEFAULT_THEME).toLowerCase().replaceAll("-", "_");
  return THEMES[requested] || THEMES[DEFAULT_THEME];
}

function compiledSlideContext(pptx, args, plan, theme, slidesInfo, slideInfo, index) {
  const cliImagePath = index < args.slideImages.length
    ? resolveAssetPath(args.slideImages[index], args.planFile, args.outputFile)
    : null;
  const planVisualPath = slideVisualPath(slideInfo, args.planFile, args.outputFile);
  const visualPath = usablePlanVisualPath(cliImagePath || planVisualPath);
  return {
    slide: renderSlide(pptx, slideInfo, plan, theme, visualPath),
    visualPath,
    imageForward: Boolean(isImageForwardSlide(slideInfo) && visualPath),
    totalSlides: slidesInfo.length,
  };
}

function renderCompiledSlide(pptx, args, plan, theme, slidesInfo, slideInfo, index) {
  const ctx = compiledSlideContext(pptx, args, plan, theme, slidesInfo, slideInfo, index);
  const imageForward = ctx.imageForward;
  if (!imageForward) {
    addFooter(ctx.slide, theme, index, ctx.totalSlides);
  }
  addNotes(ctx.slide, slideInfo);
  return ctx;
}

function incrementPictureCount(count, visualPath) {
  return visualPath ? count + 1 : count;
}

function incrementTextRunCount(count, slideInfo, imageForward) {
  if (imageForward) return count;
  return count + 1 + slideBullets(slideInfo).length;
}

async function compilePptx(args) {
  const plan = loadPlan(args.planFile);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Sophia Builder";
  pptx.company = "Sophia";
  pptx.subject = asString(plan.title, "Sophia presentation");
  pptx.title = asString(plan.title, "Sophia presentation");
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: FONT_HEAD,
    bodyFontFace: FONT_BODY,
    lang: "en-US",
  };

  const theme = resolveTheme(plan);
  const slidesInfo = Array.isArray(plan.slides) && plan.slides.length
    ? plan.slides
    : [{ type: "cover", title: asString(plan.title, "Presentation") }];
  let pictureCount = 0;
  let textRunCount = 0;

  slidesInfo.forEach((slideInfo, index) => {
    const rendered = renderCompiledSlide(pptx, args, plan, theme, slidesInfo, slideInfo, index);
    pictureCount = incrementPictureCount(pictureCount, rendered.visualPath);
    textRunCount = incrementTextRunCount(textRunCount, slideInfo, rendered.imageForward);
  });

  fs.mkdirSync(path.dirname(path.resolve(args.outputFile)), { recursive: true });
  await pptx.writeFile({ fileName: args.outputFile });
  const bytes = fs.statSync(args.outputFile).size;
  if (bytes <= 0) {
    throw new Error("PPTX compiler produced no bytes");
  }
  console.log(`Successfully generated presentation with ${slidesInfo.length} slides (picture_count=${pictureCount})`);
  console.error(
    `PPTXGEN diagnostics: slide_count=${slidesInfo.length} text_run_count=${textRunCount} picture_count=${pictureCount} output_ext=.pptx bytes=${bytes}`,
  );
}

try {
  await compilePptx(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`PPTXGEN_FAIL reason=${error?.name || "Error"} detail=${error?.message || String(error)}`);
  process.exit(1);
}
