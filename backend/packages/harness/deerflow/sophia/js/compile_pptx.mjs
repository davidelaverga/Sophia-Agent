import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import PptxGenJS from "pptxgenjs";

const OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/";
const SHAPE = {
  line: "line",
  rect: "rect",
  roundRect: "roundRect",
};

const THEMES = {
  boardroom: {
    background: "0E1A2B",
    title: "F8FAF5",
    body: "B8C4D6",
    accent: "3B82C4",
    card: "14243A",
    border: "2C405C",
  },
  daylight: {
    background: "F8FAFC",
    title: "121826",
    body: "2D3748",
    accent: "1C7ED6",
    card: "FFFFFF",
    border: "CBD5E1",
  },
  ember: {
    background: "1C1410",
    title: "F8F1E7",
    body: "D9C8B4",
    accent: "E08A00",
    card: "281D16",
    border: "4A3826",
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
    slideInfo.image || slideInfo.chart_path || slideInfo.visual_path,
    planFile,
    outputFile,
  );
}

function normalizeLayout(value) {
  return asString(value, "")
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/\s+/g, "_");
}

function addFooter(slide, theme, index, total) {
  slide.addShape(SHAPE.line, {
    x: 0.6,
    y: 6.95,
    w: 12.1,
    h: 0,
    line: { color: theme.border, transparency: 35, width: 1 },
  });
  slide.addText(`${index + 1}/${total}`, {
    x: 11.7,
    y: 6.98,
    w: 0.8,
    h: 0.22,
    fontFace: "Aptos",
    fontSize: 8,
    color: theme.body,
    align: "right",
    margin: 0,
  });
}

function addTitle(slide, title, theme, y = 0.52, h = 0.55) {
  slide.addText(title, {
    x: 0.72,
    y,
    w: 11.8,
    h,
    fontFace: "Aptos Display",
    fontSize: 25,
    bold: true,
    color: theme.title,
    fit: "shrink",
    breakLine: false,
    margin: 0,
  });
}

function addSubtitle(slide, subtitle, theme) {
  if (!subtitle) return;
  slide.addText(subtitle, {
    x: 0.76,
    y: 1.22,
    w: 10.4,
    h: 0.45,
    fontFace: "Aptos",
    fontSize: 13,
    color: theme.body,
    fit: "shrink",
    margin: 0,
  });
}

function addBullets(slide, bullets, theme, box) {
  if (!bullets.length) return;
  const runs = bullets.slice(0, 6).map((bullet) => ({
    text: bullet,
    options: { bullet: { type: "bullet" }, breakLine: true },
  }));
  slide.addText(runs, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fontFace: "Aptos",
    fontSize: box.fontSize || 14,
    color: theme.body,
    breakLine: false,
    fit: "shrink",
    margin: 0.06,
    paraSpaceAfterPt: 4,
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

function slideBullets(slideInfo) {
  const directBullets = listFrom(slideInfo.key_points).concat(listFrom(slideInfo.bullets), listFrom(slideInfo.points));
  if (directBullets.length) {
    return directBullets.slice(0, 7);
  }
  return slideColumns(slideInfo)
    .flatMap((column) => {
      const heading = columnHeading(column);
      return heading ? [heading, ...columnPoints(column)] : columnPoints(column);
    })
    .slice(0, 7);
}

function slideType(slideInfo) {
  return normalizeLayout(slideInfo.layout) || normalizeLayout(slideInfo.type) || "content";
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

function isTwoColumnType(type) {
  return ["two_column", "two_columns", "2_column", "2_columns", "comparison", "matrix"].includes(type);
}

function renderTitleSlide(pptx, slideInfo, plan, theme, visualPath) {
  const slide = pptx.addSlide();
  slide.background = { color: theme.background };
  if (visualPath) {
    addVisual(slide, visualPath, { x: 7.3, y: 0.42, w: 5.35, h: 6.1 });
    slide.addShape(SHAPE.rect, {
      x: 0,
      y: 0,
      w: 7.6,
      h: 7.5,
      fill: { color: theme.background, transparency: 0 },
      line: { color: theme.background, transparency: 100 },
    });
  }
  slide.addShape(SHAPE.rect, {
    x: 0.72,
    y: 1.1,
    w: 0.12,
    h: 0.72,
    fill: { color: theme.accent },
    line: { color: theme.accent },
  });
  slide.addText(asString(slideInfo.title, plan.title || "Presentation"), {
    x: 0.98,
    y: 1.02,
    w: visualPath ? 5.9 : 11.2,
    h: 1.45,
    fontFace: "Aptos Display",
    fontSize: 34,
    bold: true,
    color: theme.title,
    fit: "shrink",
    margin: 0,
  });
  addSubtitle(slide, asString(slideInfo.subtitle, plan.subtitle || ""), theme);
  const bullets = slideBullets(slideInfo);
  addBullets(slide, bullets, theme, { x: 1.0, y: 3.15, w: visualPath ? 5.7 : 9.6, h: 2.2, fontSize: 15 });
  return slide;
}

function renderContentSlide(pptx, slideInfo, theme, visualPath) {
  const slide = pptx.addSlide();
  slide.background = { color: theme.background };
  addTitle(slide, asString(slideInfo.title, "Untitled"), theme);
  addSubtitle(slide, asString(slideInfo.subtitle, ""), theme);

  if (visualPath) {
    slide.addShape(SHAPE.roundRect, {
      x: 7.15,
      y: 1.55,
      w: 5.35,
      h: 4.72,
      rectRadius: 0.14,
      fill: { color: theme.card },
      line: { color: theme.border, transparency: 15 },
    });
    addVisual(slide, visualPath, { x: 7.35, y: 1.75, w: 4.95, h: 4.3 });
    addBullets(slide, slideBullets(slideInfo), theme, { x: 0.82, y: 1.72, w: 5.85, h: 4.5, fontSize: 14 });
  } else {
    addBullets(slide, slideBullets(slideInfo), theme, { x: 0.95, y: 1.68, w: 10.9, h: 4.7, fontSize: 15 });
  }
  return slide;
}

function renderComparisonSlide(pptx, slideInfo, theme, visualPath) {
  const slide = pptx.addSlide();
  slide.background = { color: theme.background };
  addTitle(slide, asString(slideInfo.title, "Comparison"), theme);
  const explicitColumns = slideColumns(slideInfo);
  const items = slideBullets(slideInfo);
  const columns = explicitColumns.length
    ? [
        { heading: columnHeading(explicitColumns[0]), points: columnPoints(explicitColumns[0]) },
        { heading: columnHeading(explicitColumns[1] || {}), points: columnPoints(explicitColumns[1] || {}) },
      ]
    : [
        { heading: "", points: items.filter((_, i) => i % 2 === 0) },
        { heading: "", points: items.filter((_, i) => i % 2 === 1) },
      ];
  [0, 1].forEach((columnIndex) => {
    const x = 0.82 + columnIndex * 6.1;
    slide.addShape(SHAPE.roundRect, {
      x,
      y: 1.62,
      w: 5.55,
      h: 4.55,
      rectRadius: 0.14,
      fill: { color: theme.card },
      line: { color: theme.border, transparency: 15 },
    });
    const heading = columns[columnIndex].heading;
    if (heading) {
      slide.addText(heading, {
        x: x + 0.34,
        y: 1.86,
        w: 4.9,
        h: 0.34,
        fontFace: "Aptos Display",
        fontSize: 15,
        bold: true,
        color: theme.title,
        fit: "shrink",
        margin: 0,
      });
    }
    addBullets(slide, columns[columnIndex].points, theme, {
      x: x + 0.32,
      y: heading ? 2.34 : 2.0,
      w: 4.9,
      h: heading ? 3.35 : 3.7,
      fontSize: 13,
    });
  });
  if (visualPath) addVisual(slide, visualPath, { x: 5.85, y: 5.65, w: 1.65, h: 0.78 });
  return slide;
}

function addNotes(slide, slideInfo) {
  const notes = asString(slideInfo.speaker_notes || slideInfo.notes, "");
  if (notes && typeof slide.addNotes === "function") {
    slide.addNotes(notes);
  }
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
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "en-US",
  };

  const theme = THEMES[asString(plan.theme, "boardroom").toLowerCase()] || THEMES.boardroom;
  const slidesInfo = Array.isArray(plan.slides) && plan.slides.length
    ? plan.slides
    : [{ type: "title", title: asString(plan.title, "Presentation") }];
  let pictureCount = 0;
  let textRunCount = 0;

  slidesInfo.forEach((slideInfo, index) => {
    const cliImagePath = index < args.slideImages.length
      ? resolveAssetPath(args.slideImages[index], args.planFile, args.outputFile)
      : null;
    const visualPath = cliImagePath || slideVisualPath(slideInfo, args.planFile, args.outputFile);
    const type = slideType(slideInfo);
    const slide = type === "title"
      ? renderTitleSlide(pptx, slideInfo, plan, theme, visualPath)
      : isTwoColumnType(type)
        ? renderComparisonSlide(pptx, slideInfo, theme, visualPath)
        : renderContentSlide(pptx, slideInfo, theme, visualPath);
    addFooter(slide, theme, index, slidesInfo.length);
    addNotes(slide, slideInfo);
    if (visualPath) pictureCount += 1;
    textRunCount += 1 + slideBullets(slideInfo).length;
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
