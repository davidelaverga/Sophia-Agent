#!/usr/bin/env python3
"""html2patch — compile an HTML slide into a deck.py patch.

The agent writes a slide as HTML/CSS; a headless browser (Playwright/Chromium)
is used purely as a MEASURING engine. Every rendered element's box and computed
style is read back and translated into deck.py ops (add-shape / add-picture /
add-table / set-text). The output is a standard patch: apply it with

    python deck.py deck.pptx apply patch.json -o out.pptx --fix --render img/

Design spec: docs/html2patch-spec.md in the hands-on-deck repo. No code is shared
with any other HTML-to-PPTX implementation.

Usage:
    html2patch.py slide.html [slide2.html ...] --deck deck.pptx [--layout NAME] -o patch.json
    html2patch.py overlay.html --deck deck.pptx --slide 3 -o patch.json
    html2patch.py slide.html --size 13.333x7.5 --slide 0 -o patch.json
"""

import argparse
import base64
import json
import re
import sys
import tempfile
from pathlib import Path

PX_PER_IN = 96.0
PT_PER_PX = 0.75
MAX_TYPOGRAPHY_NORMALIZATIONS = 128

# Browser-side extractor. Runs inside the page; returns a JSON-able tree of
# "items" in document order (= back-to-front z-order) plus page metadata.
# All geometry is in CSS px; Python converts to inches/points.
EXTRACT_JS = r"""
() => {
  const out = {
    body: {}, items: [], warnings: [], errors: [],
    typographyNormalizations: [],
    typographyNormalizationCount: 0,
    typographyNormalizationsTruncated: false,
  };
  const cs = (el) => window.getComputedStyle(el);
  const TEXT_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6']);
  const SINGLE_WEIGHT = new Set(['impact']);  // faux-bold widens text in PPT
  const REQUIRED_TEXT_ROLES = new Set([
    'body', 'callout', 'content', 'description', 'evidence',
    'heading', 'headline', 'narrative', 'paragraph', 'title',
  ]);
  const REQUIRED_TEXT_MIN_PX = 24;
  const COMPACT_TEXT_MIN_PX = 20;
  const SAFE_LINE_HEIGHT_RATIO = 1.2;
  const MAX_TYPOGRAPHY_NORMALIZATIONS = 128;

  const ownSourceMeta = (el) => ({
    sourceId: el.getAttribute('data-deck-id') || null,
    sourceRole: el.getAttribute('data-deck-role') || null,
    sourceRequired: (el.getAttribute('data-deck-required') || '').toLowerCase() === 'true',
  });
  const sourceMeta = (el) => {
    const direct = ownSourceMeta(el);
    const sourceRefs = [];
    for (let current = el; current; current = current.parentElement) {
      const ref = ownSourceMeta(current);
      if (ref.sourceId) sourceRefs.push(ref);
    }
    return { ...direct, sourceRefs };
  };
  const mergeSourceRefs = (...groups) => {
    const merged = new Map();
    groups.flat().forEach(ref => {
      if (!ref || !ref.sourceId) return;
      const prior = merged.get(ref.sourceId);
      if (!prior) {
        merged.set(ref.sourceId, { ...ref });
        return;
      }
      prior.sourceRole = prior.sourceRole || ref.sourceRole || null;
      prior.sourceRequired = Boolean(prior.sourceRequired || ref.sourceRequired);
    });
    return Array.from(merged.values());
  };
  const subtreeHidden = (el, style = cs(el)) => {
    if (style.display === 'none' || parseFloat(style.opacity) === 0) return true;
    for (let current = el.parentElement; current; current = current.parentElement) {
      const ancestorStyle = cs(current);
      if (ancestorStyle.display === 'none' || parseFloat(ancestorStyle.opacity) === 0)
        return true;
    }
    return false;
  };
  const visible = (el, style = cs(el)) => {
    if (subtreeHidden(el, style) || ['hidden', 'collapse'].includes(style.visibility)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const textPaintVisible = (style) => {
    const color = String(style.color || '').trim().toLowerCase();
    if (!color || color === 'transparent') return false;
    const rgba = color.match(/rgba\([^)]*[,/]\s*([\d.]+)\s*\)$/);
    return !rgba || parseFloat(rgba[1]) > 0;
  };
  const textNodeIsRendered = (node) => {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    const style = cs(parent);
    if (!visible(parent, style) || !textPaintVisible(style)) return false;
    let rects;
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      rects = Array.from(range.getClientRects());
    } catch (e) { return false; }
    return rects.some(rect => {
      let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
      for (let current = parent; current; current = current.parentElement) {
        const currentStyle = cs(current);
        const clipX = ['hidden', 'clip', 'auto', 'scroll'].includes(currentStyle.overflowX);
        const clipY = ['hidden', 'clip', 'auto', 'scroll'].includes(currentStyle.overflowY);
        if (!clipX && !clipY) continue;
        const clip = current.getBoundingClientRect();
        if (clipX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
        if (clipY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
      }
      return right - left > 0.5 && bottom - top > 0.5;
    });
  };
  const firstRenderedTextNode = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (textNodeIsRendered(node)) return node;
    return null;
  };
  const hasRenderedText = (el) => Boolean(firstRenderedTextNode(el));
  const ownsRenderedText = (el) => {
    if (Array.from(el.childNodes).some(node =>
      node.nodeType === Node.TEXT_NODE && textNodeIsRendered(node))) return true;
    if (!['TH', 'TD'].includes(el.tagName)) return false;
    // A native table uses the cell's computed font for the flattened cell
    // text, so the cell is the style owner even when inline descendants own
    // the source text nodes.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (textNodeIsRendered(node)) return true;
    }
    return false;
  };
  const requiredTextContext = (el) => {
    for (let current = el; current; current = current.parentElement) {
      const meta = ownSourceMeta(current);
      if (meta.sourceRequired || REQUIRED_TEXT_ROLES.has((meta.sourceRole || '').toLowerCase()))
        return true;
    }
    return false;
  };
  const nearestSourceMeta = (el) => {
    for (let current = el; current; current = current.parentElement) {
      const meta = ownSourceMeta(current);
      if (meta.sourceId) return meta;
    }
    return { sourceId: null, sourceRole: null, sourceRequired: false };
  };
  const roundedPx = (value) => Number.isFinite(value)
    ? Math.round(value * 1000) / 1000 : null;
  const normalizeTypography = () => {
    const pending = [];
    const requiredTables = new Set();
    document.body.querySelectorAll('table').forEach(table => {
      const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!textNodeIsRendered(node)) continue;
        if (requiredTextContext(node.parentElement)) {
          requiredTables.add(table);
          break;
        }
      }
    });
    document.body.querySelectorAll('*').forEach(el => {
      if (!ownsRenderedText(el)) return;
      const style = cs(el);
      if (!visible(el, style)) return;
      const oldFontPx = parseFloat(style.fontSize);
      if (!Number.isFinite(oldFontPx) || oldFontPx <= 0.5) return;
      const table = el.closest('table');
      const required = requiredTextContext(el) || Boolean(table && requiredTables.has(table));
      const minimumPx = required ? REQUIRED_TEXT_MIN_PX : COMPACT_TEXT_MIN_PX;
      const targetFontPx = Math.max(oldFontPx, minimumPx);
      const rawLineHeight = style.lineHeight;
      const oldLineHeightPx = rawLineHeight === 'normal' ? null : parseFloat(rawLineHeight);
      const lineHeightIsExplicit = Number.isFinite(oldLineHeightPx);
      const minimumLineHeightPx = targetFontPx * SAFE_LINE_HEIGHT_RATIO;
      const fontChanged = oldFontPx + 0.01 < targetFontPx;
      const lineHeightChanged = lineHeightIsExplicit && oldLineHeightPx + 0.01 < minimumLineHeightPx;
      if (!fontChanged && !lineHeightChanged) return;
      const source = nearestSourceMeta(el);
      if (fontChanged)
        el.style.setProperty('font-size', `${targetFontPx}px`, 'important');
      if (lineHeightChanged)
        el.style.setProperty('line-height', `${minimumLineHeightPx}px`, 'important');
      pending.push({
        el,
        source,
        required,
        minimumPx,
        oldFontPx,
        oldLineHeightPx: lineHeightIsExplicit ? oldLineHeightPx : null,
        fontChanged,
        lineHeightChanged,
      });
    });

    // Resolve every contract mutation before any extraction geometry is read.
    document.body.getBoundingClientRect();
    out.typographyNormalizationCount = pending.length;
    out.typographyNormalizationsTruncated = pending.length > MAX_TYPOGRAPHY_NORMALIZATIONS;
    pending.slice(0, MAX_TYPOGRAPHY_NORMALIZATIONS).forEach(item => {
      const normalized = cs(item.el);
      const normalizedLineHeight = normalized.lineHeight === 'normal'
        ? null : parseFloat(normalized.lineHeight);
      out.typographyNormalizations.push({
        sourceId: item.source.sourceId,
        sourceRole: item.source.sourceRole,
        elementTag: item.el.tagName.toLowerCase(),
        required: item.required,
        minimumPx: item.minimumPx,
        oldFontPx: roundedPx(item.oldFontPx),
        newFontPx: roundedPx(parseFloat(normalized.fontSize)),
        oldLineHeightPx: roundedPx(item.oldLineHeightPx),
        newLineHeightPx: roundedPx(normalizedLineHeight),
        fontChanged: item.fontChanged,
        lineHeightChanged: item.lineHeightChanged,
      });
    });
  };
  const seenSourceIds = new Set();
  document.querySelectorAll('[data-deck-id]').forEach(el => {
    const sourceId = el.getAttribute('data-deck-id');
    if (seenSourceIds.has(sourceId)) out.errors.push('duplicate data-deck-id: ' + sourceId);
    seenSourceIds.add(sourceId);
  });

  normalizeTypography();

  // an element whose rendered children are all inline (or text/BR) is a text
  // block even if it isn't a <p>/<h*> — figcaption, blockquote, dt, a bare div
  const isInlineOnlyTextBlock = (el) => {
    if (!el.textContent.trim()) return false;
    return Array.from(el.childNodes).every(n => {
      if (n.nodeType === Node.TEXT_NODE) return true;
      if (n.nodeType !== Node.ELEMENT_NODE) return true;
      if (n.tagName === 'BR') return true;
      const d = cs(n).display;
      return d === 'inline' || d === 'none';
    });
  };

  const bodyStyle = cs(document.body);
  out.body.w = parseFloat(bodyStyle.width);
  out.body.h = parseFloat(bodyStyle.height);
  out.body.scrollW = document.body.scrollWidth;
  out.body.scrollH = document.body.scrollHeight;
  out.body.bg = bodyStyle.backgroundColor;
  out.body.bgImage = bodyStyle.backgroundImage;
  out.body.bgSize = bodyStyle.backgroundSize;

  const parseColor = (str) => {
    // -> {hex, alpha} or null for fully transparent / unparseable
    if (!str || str === 'transparent') return null;
    const m = str.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a === 0) return null;
    const hex = [m[1], m[2], m[3]]
      .map(n => parseInt(n).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { hex, alpha: a };
  };

  const firstFont = (stack) => {
    if (!stack) return null;
    const fam = stack.split(',')[0].replace(/['"]/g, '').trim();
    const generic = { 'sans-serif': 'Arial', serif: 'Georgia', monospace: 'Courier New' };
    return generic[fam.toLowerCase()] || fam;
  };

  const transformText = (text, mode) => {
    // textContent does NOT reflect CSS text-transform; apply it ourselves
    if (mode === 'uppercase') return text.toUpperCase();
    if (mode === 'lowercase') return text.toLowerCase();
    if (mode === 'capitalize') return text.replace(/(^|\s)\S/g, c => c.toUpperCase());
    return text;
  };

  const rotationOf = (style) => {
    let deg = 0;
    if (style.writingMode === 'vertical-rl') deg = 90;
    else if (style.writingMode === 'vertical-lr') deg = 270;
    const t = style.transform;
    if (t && t !== 'none') {
      const m = t.match(/matrix\(([^)]+)\)/);
      if (m) {
        const v = m[1].split(',').map(parseFloat);
        deg += Math.atan2(v[1], v[0]) * 180 / Math.PI;
      }
    }
    deg = ((Math.round(deg * 10) / 10) % 360 + 360) % 360;
    return deg === 0 ? null : deg;
  };

  // PPT rotates the PRE-rotation box about its center; undo the browser's
  // rotated bounding box to recover it.
  const boxOf = (el, rot) => {
    const r = el.getBoundingClientRect();
    if (rot === null) return { x: r.left, y: r.top, w: r.width, h: r.height };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (rot === 90 || rot === 270) {
      return { x: cx - r.height / 2, y: cy - r.width / 2, w: r.height, h: r.width };
    }
    return { x: cx - el.offsetWidth / 2, y: cy - el.offsetHeight / 2,
             w: el.offsetWidth, h: el.offsetHeight };
  };

  // Where does the text actually sit inside its box? Measured, not guessed:
  // the browser has already applied flex/grid centering, line-height, explicit
  // heights, etc. We read the rendered text ink box and compare it to the
  // element's content box. A box that hugs its text → top (the default, no
  // anchor needed); text floating centered or pinned to the bottom of a taller
  // box → MIDDLE / BOTTOM, which PPTX needs as an explicit vertical anchor.
  const measureVAnchor = (el, style) => {
    const r = el.getBoundingClientRect();
    const top = r.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
    const bottom = r.bottom - (parseFloat(style.borderBottomWidth) || 0) - (parseFloat(style.paddingBottom) || 0);
    const contentH = bottom - top;
    if (contentH <= 0) return null;
    let tr;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      tr = range.getBoundingClientRect();
    } catch (e) { return null; }
    if (!tr || tr.height <= 0) return null;
    const slack = contentH - tr.height;
    if (slack < 4) return null;  // box hugs the text → default top
    const topGap = tr.top - top, botGap = bottom - tr.bottom;
    const tol = Math.max(2, slack * 0.2);
    if (Math.abs(topGap - botGap) <= tol) return 'MIDDLE';
    if (botGap <= tol && topGap > tol) return 'BOTTOM';
    return null;  // top-anchored or ambiguous → leave as default
  };

  // Resolve the effective run style at an inline node
  const runStyle = (style) => {
    const color = parseColor(style.color);
    const fam = firstFont(style.fontFamily);
    const w = style.fontWeight === 'bold' ? 700 : parseInt(style.fontWeight) || 400;
    return {
      bold: w >= 600 && !SINGLE_WEIGHT.has((fam || '').toLowerCase()),
      italic: style.fontStyle === 'italic',
      underline: (style.textDecorationLine || style.textDecoration || '').includes('underline'),
      sizePx: parseFloat(style.fontSize),
      font: fam,
      color: color ? color.hex : '000000',
      alpha: color ? color.alpha : 1,
    };
  };

  // Flatten an element's inline content into runs; <br> splits paragraphs.
  const collectRuns = (el, baseTransform) => {
    const paras = [[]];
    const walk = (node, transform) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = transformText(node.textContent.replace(/\s+/g, ' '), transform);
        if (text && textNodeIsRendered(node)) {
          const st = runStyle(cs(node.parentElement));
          const a = node.parentElement.closest('a[href]');
          if (a) st.link = a.href;
          const cur = paras[paras.length - 1];
          const prev = cur[cur.length - 1];
          if (prev && JSON.stringify(prev.style) === JSON.stringify(st)) prev.text += text;
          else cur.push({ text, style: st });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') { paras.push([]); return; }
      if (node.tagName === 'UL' || node.tagName === 'OL') return; // nested lists are their own paragraphs
      const st = cs(node);
      if (subtreeHidden(node, st)) return;
      const t = st.textTransform !== 'none' ? st.textTransform : transform;
      node.childNodes.forEach(c => walk(c, t));
    };
    walk(el, baseTransform);
    // trim paragraph edges, drop empty runs/paragraphs
    return paras.map(runs => {
      if (runs.length) {
        runs[0].text = runs[0].text.replace(/^\s+/, '');
        runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
      }
      return runs.filter(r => r.text.length > 0);
    }).filter(runs => runs.length > 0);
  };

  const blockMeta = (el, style) => {
    const align = { start: 'left', left: 'left', center: 'center', right: 'right',
                    justify: 'justify', end: 'right' }[style.textAlign] || 'left';
    const lh = style.lineHeight === 'normal'
      ? parseFloat(style.fontSize) * 1.2 : parseFloat(style.lineHeight);
    return {
      align, lineHeightPx: lh, fontSizePx: parseFloat(style.fontSize),
      padding: [style.paddingLeft, style.paddingTop, style.paddingRight, style.paddingBottom]
        .map(parseFloat),
    };
  };

  const borderInfo = (style) => {
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map(s => ({
      w: parseFloat(style['border' + s + 'Width']) || 0,
      color: parseColor(style['border' + s + 'Color']),
      style: style['border' + s + 'Style'],
    }));
    const painted = sides.filter(s => s.w > 0 && s.style !== 'none' && s.color);
    if (!painted.length) return { kind: 'none' };
    const uniform = sides.every(s =>
      s.w === sides[0].w && s.style === sides[0].style &&
      JSON.stringify(s.color) === JSON.stringify(sides[0].color));
    return { kind: uniform ? 'uniform' : 'partial', sides };
  };

  const gradientInfo = (bgImage) => {
    if (!bgImage || bgImage === 'none' || !bgImage.includes('linear-gradient')) return null;
    const inner = bgImage.match(/linear-gradient\((.*)\)/s);
    if (!inner) return null;
    // split top-level commas only
    const parts = []; let depth = 0, cur = '';
    for (const ch of inner[1]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    parts.push(cur.trim());
    let cssDeg = 180;  // CSS default: to bottom
    if (/^-?[\d.]+deg$/.test(parts[0])) cssDeg = parseFloat(parts.shift());
    else if (parts[0].startsWith('to ')) {
      const dir = parts.shift().slice(3).trim();
      cssDeg = { top: 0, right: 90, bottom: 180, left: 270,
                 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
                 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 }[dir] ?? 180;
    }
    const stops = parts.map(p => {
      const colorMatch = p.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/);
      const posMatch = p.match(/([\d.]+)%/);
      let col = colorMatch ? parseColor(colorMatch[0]) : null;
      if (!col && colorMatch && colorMatch[0][0] === '#') {
        let h = colorMatch[0].slice(1);
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        col = { hex: h.slice(0, 6).toUpperCase(), alpha: 1 };
      }
      return col ? { hex: col.hex, pos: posMatch ? parseFloat(posMatch[1]) / 100 : null } : null;
    }).filter(Boolean);
    if (stops.length < 2) return null;
    return { cssDeg, stops };
  };

  // box paint extraction, shared by the body, painted text blocks, and boxes
  const paintOf = (el2, style2, rot2, box2) => {
    const fill = parseColor(style2.backgroundColor);
    const grad = gradientInfo(style2.backgroundImage);
    const border = borderInfo(style2);
    const bgUrl = (style2.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/) || [])[1];
    if (!fill && !grad && border.kind === 'none' && !bgUrl) return null;
    const radius = parseFloat(style2.borderTopLeftRadius) || 0;
    const radiusIsPct = String(style2.borderTopLeftRadius).includes('%');
    if (style2.boxShadow && style2.boxShadow !== 'none')
      out.warnings.push('box-shadow is not supported and was dropped');
    return {
      bgUrl,
      bgFit: (style2.backgroundSize || '').includes('cover') ? 'cover'
           : (style2.backgroundSize || '').includes('contain') ? 'contain' : 'fill',
      item: {
        ...sourceMeta(el2),
        type: 'box', box: box2, rotation: rot2,
        fill: fill ? fill.hex : null,
        fillAlpha: fill ? fill.alpha : 1,
        gradient: grad,
        radiusPx: radiusIsPct
          ? Math.min(box2.w, box2.h) * Math.min(parseFloat(style2.borderTopLeftRadius), 50) / 100
          : radius,
        border: border.kind === 'uniform'
          ? { w: border.sides[0].w, color: border.sides[0].color.hex,
              dashed: ['dashed', 'dotted'].includes(border.sides[0].style) }
          : null,
        partialBorders: border.kind === 'partial'
          ? border.sides.map((s, i) => s.w > 0 && s.color
              ? { side: i, w: s.w, color: s.color.hex,
                  dashed: ['dashed', 'dotted'].includes(s.style) } : null).filter(Boolean)
          : [],
      },
    };
  };

  // ---- walk ----
  const emit = (el) => {
    const style = cs(el);
    if (!visible(el, style)) {
      // visibility is overridable and zero-size/display:contents containers
      // may still have rendered descendants. Only display:none or composed
      // zero opacity hides the entire subtree.
      if (!subtreeHidden(el, style))
        el.childNodes.forEach(n => { if (n.nodeType === Node.ELEMENT_NODE) emit(n); });
      return;
    }
    const tag = el.tagName;

    if (tag === 'IMG') {
      const r = el.getBoundingClientRect();
      out.items.push({ ...sourceMeta(el), type: 'image', src: el.currentSrc || el.src,
                       box: { x: r.left, y: r.top, w: r.width, h: r.height },
                       fit: style.objectFit || 'fill' });
      return;
    }

    if (tag === 'TABLE') {
      const r = el.getBoundingClientRect();
      const rows = [];
      const cellStyles = [];
      const representedCellRows = [];
      el.querySelectorAll('tr').forEach(tr => {
        const row = [], rowSt = [], representedCells = [];
        tr.querySelectorAll('th,td').forEach(cell => {
          const cellCs = cs(cell);
          if (!visible(cell, cellCs)) return;
          if (cell.colSpan > 1 || cell.rowSpan > 1)
            out.warnings.push('table cell spans are not supported; layout will be off');
          // textContent flattens <br> to nothing, gluing words together —
          // walk the cell so explicit breaks survive as newlines
          const withBreaks = (function walk(node) {
            let s = '';
            node.childNodes.forEach(n => {
              if (n.nodeType === Node.TEXT_NODE) {
                if (textNodeIsRendered(n)) s += n.textContent;
              }
              else if (n.nodeType === Node.ELEMENT_NODE) {
                const childStyle = cs(n);
                if (n.tagName === 'BR') {
                  if (!subtreeHidden(n, childStyle) && childStyle.visibility === 'visible') s += '\n';
                  return;
                }
                if (subtreeHidden(n, childStyle)) return;
                s += walk(n);
              }
            });
            return s;
          })(cell);
          row.push(transformText(
            withBreaks.split('\n').map(l => l.replace(/\s+/g, ' ').trim())
                      .filter(Boolean).join('\n'),
            cellCs.textTransform));
          const firstText = firstRenderedTextNode(cell);
          const st = runStyle(firstText ? cs(firstText.parentElement) : cellCs);
          const bg = parseColor(cellCs.backgroundColor);
          rowSt.push({ ...st, fill: bg ? bg.hex : null,
                       align: { start: 'left' }[cellCs.textAlign] || cellCs.textAlign });
          representedCells.push(cell);
        });
        if (row.length) {
          rows.push(row);
          cellStyles.push(rowSt);
          representedCellRows.push(representedCells);
        }
      });
      if (rows.length) {
        const colWidths = (representedCellRows[0] || [])
          .map(cell => cell.getBoundingClientRect().width);
        const tableMeta = sourceMeta(el);
        const representedRefs = [tableMeta.sourceRefs];
        representedCellRows.flat().forEach(cell => {
          // The native table represents each included cell and its visible
          // textual descendants, but not hidden or non-text decorations that
          // the table operation discards.
          representedRefs.push(sourceMeta(cell).sourceRefs);
          cell.querySelectorAll('[data-deck-id]').forEach(descendant => {
            if (!visible(descendant, cs(descendant))) return;
            if (!hasRenderedText(descendant)) return;
            representedRefs.push(sourceMeta(descendant).sourceRefs);
          });
        });
        out.items.push({ ...tableMeta, sourceRefs: mergeSourceRefs(...representedRefs),
                         type: 'table', box: { x: r.left, y: r.top, w: r.width, h: r.height },
                         rows, cellStyles, colWidths,
                         fontSizePx: parseFloat(cs(el).fontSize) });
      }
      return;  // never descend into tables
    }

    if (TEXT_TAGS.has(tag) || isInlineOnlyTextBlock(el)) {
      const rot = rotationOf(style);
      const box = boxOf(el, rot);
      const paint = paintOf(el, style, rot, box);
      if (paint) {
        out.items.push(paint.item);  // badge/pill: the box paints under its text
        if (paint.bgUrl) out.items.push({ ...sourceMeta(el), type: 'image', src: paint.bgUrl, box, fit: paint.bgFit });
      }
      const paras = collectRuns(el, style.textTransform);
      if (paras.length)
        out.items.push({ ...sourceMeta(el), type: 'text', box, rotation: rot,
                         paragraphs: paras.map(runs => ({ runs })),
                         vanchor: measureVAnchor(el, style),
                         meta: blockMeta(el, style) });
      return;
    }

    if (tag === 'UL' || tag === 'OL') {
      const rot = rotationOf(style);
      const paragraphs = [];
      el.querySelectorAll(':scope li').forEach(li => {
        let level = 0;
        for (let a = li.parentElement; a && a !== el; a = a.parentElement)
          if (a.tagName === 'UL' || a.tagName === 'OL') level++;
        const liStyle = cs(li);
        const listEl = li.parentElement;
        const ordered = listEl && listEl.tagName === 'OL';
        collectRuns(li, liStyle.textTransform).forEach(runs => {
          // strip hand-typed bullet glyphs; the bullet comes from PPT
          runs[0].text = runs[0].text.replace(/^[•▪▸◦‣–-]\s*/, '');
          paragraphs.push({ runs, bullet: ordered ? 'number' : true, level,
                            lineHeightPx: blockMeta(li, liStyle).lineHeightPx });
        });
      });
      if (paragraphs.length)
        out.items.push({ ...sourceMeta(el), type: 'text', box: boxOf(el, rot), rotation: rot,
                         paragraphs, meta: blockMeta(el, style) });
      return;  // li content fully consumed
    }

    // BOX: anything painting a background or border; children still walked
    {
      const rot = rotationOf(style);
      const paint = paintOf(el, style, rot, boxOf(el, rot));
      if (paint) {
        out.items.push(paint.item);
        if (paint.bgUrl)
          out.items.push({ ...sourceMeta(el), type: 'image', src: paint.bgUrl, box: paint.item.box, fit: paint.bgFit });
        // loose text mixed with block children is invisible to us — warn
        for (const n of el.childNodes)
          if (n.nodeType === Node.TEXT_NODE && n.textContent.trim())
            out.warnings.push(
              'text "' + n.textContent.trim().slice(0, 40) +
              '" sits directly in a styled container with block children; wrap it in <p>/<h*>');
      }
    }
    el.childNodes.forEach(n => { if (n.nodeType === Node.ELEMENT_NODE) emit(n); });
  };

  // the body's own paint is the slide background (back layer, first item)
  {
    const r = { x: 0, y: 0, w: out.body.w, h: out.body.h };
    const paint = paintOf(document.body, bodyStyle, null, r);
    if (paint) {
      if (paint.item.fill || paint.item.gradient) {
        paint.item.border = null;
        paint.item.partialBorders = [];
        paint.item.radiusPx = 0;
        out.items.push(paint.item);
      }
      if (paint.bgUrl)
        out.items.push({ ...sourceMeta(document.body), type: 'image', src: paint.bgUrl, box: r, fit: paint.bgFit });
    }
  }
  document.body.childNodes.forEach(n => { if (n.nodeType === Node.ELEMENT_NODE) emit(n); });
  return out;
}
"""


# Faces whose PowerPoint metrics run widest of the browser's. A re-wrapped
# line is the worst drift there is, so isolated boxes retain a larger cushion.
SERIF_FACES = {
    "georgia", "times", "times new roman", "palatino", "palatino linotype",
    "garamond", "book antiqua", "baskerville", "didot", "cambria",
    "constantia", "hoefler text",
}


def px2in(v):
    return round(v / PX_PER_IN, 3)


def px2pt(v):
    return round(v * PT_PER_PX, 1)


def die(msg):
    sys.stderr.write("html2patch: error: %s\n" % msg)
    sys.exit(1)


def parse_size(s):
    m = re.match(r"^([\d.]+)x([\d.]+)$", str(s))
    if not m:
        die('--size must look like "13.333x7.5" (inches)')
    return float(m.group(1)), float(m.group(2))


def resolve_image(src, html_dir, tmpdir, warnings):
    """Local file path for an image reference; data: URIs are materialized."""
    if src.startswith("data:"):
        m = re.match(r"data:image/(\w+);base64,(.*)", src, re.S)
        if not m:
            return None
        ext = {"jpeg": "jpg", "svg+xml": "svg"}.get(m.group(1), m.group(1))
        p = Path(tempfile.mkstemp(suffix="." + ext, dir=tmpdir)[1])
        p.write_bytes(base64.b64decode(m.group(2)))
        return p
    if src.startswith("file://"):
        p = Path(src[7:].split("?")[0])
    elif re.match(r"^https?://", src):
        warnings.append("remote image %s skipped — download it locally first" % src[:60])
        return None
    else:
        p = (html_dir / src.split("?")[0]).resolve()
    if not p.exists():
        warnings.append("image not found: %s" % p)
        return None
    return p


def run_to_spec(run):
    """deck.py run object carrying the run's FULL resolved style. The textbox
    is brand new (nothing to inherit), so every run is explicit; shape-level
    font keys are never used (they would clobber per-run overrides, since
    add-shape applies style keys after writing text)."""
    st = run["style"]
    spec = {"text": run["text"],
            "font_size": px2pt(st["sizePx"]),
            "color": st["color"]}
    if st["font"]:
        spec["font_name"] = st["font"]
    for k in ("bold", "italic", "underline"):
        if st[k]:
            spec[k] = True
    if st.get("link"):
        spec["link"] = st["link"]
    return spec


def _text_width_clearance(item, items, slide_width_px=None):
    """Directional room for metric drift without changing source layout.

    Clearance is constrained by the slide, every strict containing
    painted box, and half of each gap to a vertically intersecting text peer
    (the peer owns the other half). Source-authored overlap is preserved, but
    receives no additional growth on that side.
    """
    if item.get("rotation"):
        return 0.0, 0.0
    box = item["box"]
    left = max(0.0, float(box["x"]))
    right = float("inf")
    if slide_width_px is not None:
        right = max(
            0.0,
            float(slide_width_px) - float(box["x"]) - float(box["w"]),
        )

    top = float(box["y"])
    bottom = top + float(box["h"])
    x = float(box["x"])
    x2 = x + float(box["w"])

    for candidate in items:
        if candidate is item or candidate.get("type") != "box":
            continue
        outer = candidate.get("box") or {}
        try:
            ox = float(outer["x"])
            oy = float(outer["y"])
            ox2 = ox + float(outer["w"])
            oy2 = oy + float(outer["h"])
        except (KeyError, TypeError, ValueError):
            continue
        strictly_larger = float(outer["w"]) * float(outer["h"]) > float(box["w"]) * float(box["h"]) + 1.0
        if strictly_larger and ox <= x + 0.5 and oy <= top + 0.5 and ox2 >= x2 - 0.5 and oy2 >= bottom - 0.5:
            left = min(left, max(0.0, x - ox))
            right = min(right, max(0.0, ox2 - x2))

    for peer in items:
        if peer is item or peer.get("type") != "text":
            continue
        other = peer.get("box") or {}
        try:
            peer_x = float(other["x"])
            peer_top = float(other["y"])
            peer_x2 = peer_x + float(other["w"])
            peer_bottom = peer_top + float(other["h"])
        except (KeyError, TypeError, ValueError):
            continue
        if min(bottom, peer_bottom) - max(top, peer_top) <= 0.5:
            continue
        if peer.get("rotation"):
            return 0.0, 0.0
        if peer_x2 <= x + 0.5:
            left = min(left, max(0.0, x - peer_x2) / 2.0)
        elif peer_x >= x2 - 0.5:
            right = min(right, max(0.0, peer_x - x2) / 2.0)
        else:
            # The authored text boxes already overlap. Never make that overlap
            # worse, but leave it intact so native lint can report it honestly.
            if peer_x <= x:
                left = 0.0
            if peer_x2 >= x2:
                right = 0.0

    return left, right


def text_block_ops(item, slide_ref, name, warnings, width_clearance=None):
    """One add-shape textbox op for a text/list item."""
    meta = item["meta"]
    box = dict(item["box"])
    paras = item["paragraphs"]

    # Preserve the old PowerPoint metric cushion only where the source layout
    # proves there is room for it. Directional clamping keeps adjacent grid
    # columns and containing cards authoritative while isolated text retains
    # wrap-drift protection.
    fonts = {(r["style"]["font"] or "").lower() for p in paras for r in p["runs"]}
    desired_extra = box["w"] * (0.04 if fonts & SERIF_FACES else 0.02)
    left_room, right_room = width_clearance or (float("inf"), float("inf"))
    if meta["align"] == "center":
        extra = min(desired_extra, 2 * left_room, 2 * right_room)
        box["x"] -= extra / 2
    elif meta["align"] == "right":
        extra = min(desired_extra, left_room)
        box["x"] -= extra
    else:
        extra = min(desired_extra, right_room)
    box["w"] += extra

    if any(r["style"].get("alpha", 1) < 1 for p in paras for r in p["runs"]):
        warnings.append("text alpha < 1 dropped (no transparency in this model)")

    text_items = []
    for p in paras:
        # line spacing must track the LARGEST run on the line, like the browser
        max_px = max(r["style"]["sizePx"] for r in p["runs"])
        lh_px = p.get("lineHeightPx", meta["lineHeightPx"])
        if max_px > meta["fontSizePx"] > 0:
            lh_px = lh_px * max_px / meta["fontSizePx"]
        para = {"alignment": meta["align"].upper(), "line_spacing": px2pt(lh_px),
                "space_before": 0, "space_after": 0}
        if p.get("bullet"):
            para["bullet"] = p["bullet"]  # True or "number"
            if p.get("level"):
                para["level"] = p["level"]
        runs = [run_to_spec(r) for r in p["runs"]]
        if len(runs) == 1:
            # single run: fold its font keys into the paragraph object
            para.update(runs[0])
        else:
            para["runs"] = runs
        text_items.append(para)

    op = {
        "op": "add-shape", "slide": slide_ref, "kind": "textbox", "name": name,
        "at": [px2in(box["x"]), px2in(box["y"])],
        "size": [px2in(box["w"]), px2in(box["h"])],
        "insets": [round(v / PX_PER_IN, 3) for v in meta["padding"]],
        "text": text_items,
    }
    if item.get("rotation"):
        op["rotation"] = item["rotation"]
    if item.get("vanchor"):
        op["anchor"] = item["vanchor"]
    return [op]


def box_ops(item, slide_ref, name, warnings):
    ops = []
    box = item["box"]
    has_face = item["fill"] or item["gradient"] or item["border"]
    if has_face:
        radius_px = item.get("radiusPx") or 0
        op = {
            "op": "add-shape", "slide": slide_ref, "name": name,
            "kind": "rounded_rect" if radius_px > 0 else "rect",
            "at": [px2in(box["x"]), px2in(box["y"])],
            "size": [px2in(box["w"]), px2in(box["h"])],
        }
        if radius_px > 0:
            adj = radius_px / max(min(box["w"], box["h"]), 1)
            op["adjustments"] = [round(min(adj, 0.5), 4)]
        if item["gradient"]:
            g = item["gradient"]
            stops = g["stops"]
            n = len(stops)
            if n > 2:
                warnings.append("gradient has %d stops; keeping first and last" % n)
                stops = [stops[0], stops[-1]]
            positions = [s["pos"] if s["pos"] is not None else float(i)
                         for i, s in enumerate(stops)]
            op["gradient"] = {
                "colors": [s["hex"] for s in stops],
                "positions": positions,
                # CSS: 0deg points up, grows clockwise. python-pptx
                # gradient_angle: 0deg points right, grows counterclockwise.
                "angle": (90 - g["cssDeg"]) % 360,
            }
        elif item["fill"]:
            op["fill"] = item["fill"]
            if item.get("fillAlpha", 1) < 1:
                warnings.append("fill alpha %.2f dropped (solid color emitted)" % item["fillAlpha"])
        else:
            op["fill"] = "none"  # border-only frame stays hollow
        op["shadow"] = False  # browsers don't draw PPT's theme shadow
        if item["border"]:
            op["line_color"] = item["border"]["color"]
            op["line_width"] = px2pt(item["border"]["w"])
            if item["border"]["dashed"]:
                op["line_dash"] = "dash"
        else:
            op["line"] = "none"
        if item.get("rotation"):
            op["rotation"] = item["rotation"]
        ops.append(op)
    # partial borders → centered line shapes per painted side
    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    for pb in item.get("partialBorders", []):
        half = pb["w"] / 2.0
        seg = {
            0: [(x, y + half), (x + w, y + half)],          # top
            1: [(x + w - half, y), (x + w - half, y + h)],  # right
            2: [(x, y + h - half), (x + w, y + h - half)],  # bottom
            3: [(x + half, y), (x + half, y + h)],          # left
        }[pb["side"]]
        line_op = {
            "op": "add-shape", "slide": slide_ref, "kind": "line",
            "from": [px2in(seg[0][0]), px2in(seg[0][1])],
            "to": [px2in(seg[1][0]), px2in(seg[1][1])],
            "line_color": pb["color"], "line_width": px2pt(pb["w"]),
        }
        if pb["dashed"]:
            line_op["line_dash"] = "dash"
        ops.append(line_op)
    return ops


def table_ops(item, slide_ref, name, warnings):
    box = item["box"]
    rows = item["rows"]
    ncols = max(len(r) for r in rows)
    if any(len(r) != ncols for r in rows):
        warnings.append("table rows are ragged; padding short rows with empty cells")
        rows = [r + [""] * (ncols - len(r)) for r in rows]
    # neutralize the theme's banded table style; transparent HTML cells become
    # no-fill cells so the slide background shows through, like the browser
    fill_set = {st.get("fill") for row in item["cellStyles"] for st in row}
    all_styles = [st for row in item["cellStyles"] for st in row]
    base_color = max((st["color"] for st in all_styles),
                     key=[st["color"] for st in all_styles].count)
    op = {
        "op": "add-table", "slide": slide_ref, "name": name,
        "at": [px2in(box["x"]), px2in(box["y"])],
        "size": [px2in(box["w"]), px2in(box["h"])],
        "rows": rows,
        "font_size": px2pt(item["fontSizePx"]),
        "color": base_color,
        "first_row": False, "banding": False,
    }
    if len(fill_set) == 1:
        only = fill_set.pop()
        op["fill"] = only or "none"
    else:
        op["fills"] = [[st.get("fill") or "none" for st in row]
                       for row in item["cellStyles"]]
    if item.get("colWidths") and len(item["colWidths"]) == ncols:
        op["col_widths"] = [px2in(w) for w in item["colWidths"]]
    ops = [op]
    # cells whose style differs from the table default get a set-text follow-up
    base_pt = px2pt(item["fontSizePx"])
    for ri, row_styles in enumerate(item["cellStyles"]):
        for ci, st in enumerate(row_styles):
            overrides = {}
            if st["bold"]:
                overrides["bold"] = True
            if st["italic"]:
                overrides["italic"] = True
            if px2pt(st["sizePx"]) != base_pt:
                overrides["font_size"] = px2pt(st["sizePx"])
            if st["color"] != base_color:
                overrides["color"] = st["color"]
            if st.get("align") and st["align"] not in ("left", "start"):
                overrides["alignment"] = st["align"].upper()
            if overrides and rows[ri][ci]:
                overrides["text"] = rows[ri][ci]
                ops.append({"op": "set-text", "slide": slide_ref, "shape": name,
                            "cell": [ri, ci], "text": [overrides]})
    return ops


def picture_op(path, box, fit, slide_ref, name=None):
    """add-picture op honoring object-fit / background-size semantics."""
    op = {"op": "add-picture", "slide": slide_ref, "image": str(path),
          "at": [px2in(box["x"]), px2in(box["y"])],
          "size": [px2in(box["w"]), px2in(box["h"])]}
    if name:
        op["name"] = name
    if fit in ("cover", "contain"):
        from PIL import Image as PILImage

        nw, nh = PILImage.open(path).size
        nat_ar, box_ar = nw / nh, box["w"] / box["h"]
        if fit == "cover":  # crop the overflowing dimension
            if nat_ar > box_ar:
                c = round((1 - box_ar / nat_ar) / 2, 4)
                op["crop"] = [c, 0, c, 0]
            elif nat_ar < box_ar:
                c = round((1 - nat_ar / box_ar) / 2, 4)
                op["crop"] = [0, c, 0, c]
        else:  # contain: letterbox — shrink the target rect, centered
            if nat_ar > box_ar:
                h = box["w"] / nat_ar
                op["at"] = [px2in(box["x"]), px2in(box["y"] + (box["h"] - h) / 2)]
                op["size"] = [px2in(box["w"]), px2in(h)]
            elif nat_ar < box_ar:
                w = box["h"] * nat_ar
                op["at"] = [px2in(box["x"] + (box["w"] - w) / 2), px2in(box["y"])]
                op["size"] = [px2in(w), px2in(box["h"])]
    return op


def compile_page(extract, slide_ref, html_path, tmpdir, prefix, warnings, source_map):
    """All ops for one extracted page targeting slide_ref."""
    ops = []
    seq = [0]
    source_seq = {}
    selector = f"slide:{slide_ref + 1}"
    slide_map = source_map.setdefault("slides", {}).setdefault(selector, {"elements": {}})

    raw_normalizations = [
        item for item in extract.get("typographyNormalizations") or []
        if isinstance(item, dict)
    ][:MAX_TYPOGRAPHY_NORMALIZATIONS]
    normalization_count = max(
        len(raw_normalizations),
        int(extract.get("typographyNormalizationCount") or 0),
    )
    if normalization_count:
        allowed_keys = {
            "sourceId", "sourceRole", "elementTag", "required", "minimumPx",
            "oldFontPx", "newFontPx", "oldLineHeightPx", "newLineHeightPx",
            "fontChanged", "lineHeightChanged",
        }
        slide_map["typography_normalizations"] = [
            {
                "selector": selector,
                **{key: value for key, value in item.items() if key in allowed_keys},
            }
            for item in raw_normalizations
        ]
        slide_map["typography_normalization_count"] = normalization_count
        slide_map["typography_normalizations_truncated"] = bool(
            extract.get("typographyNormalizationsTruncated")
            or normalization_count > len(raw_normalizations)
        )

    def next_name(kind):
        seq[0] += 1
        return "%s-%s-%d" % (prefix, kind, seq[0])

    def item_name(item, kind):
        source_id = item.get("sourceId")
        if not source_id:
            return next_name(kind)
        key = (source_id, kind)
        source_seq[key] = source_seq.get(key, 0) + 1
        return "%s-%s-%s-%d" % (prefix, source_id, kind, source_seq[key])

    def source_refs(item):
        refs = [ref for ref in item.get("sourceRefs") or [] if isinstance(ref, dict)]
        direct_id = item.get("sourceId")
        if direct_id and not any(ref.get("sourceId") == direct_id for ref in refs):
            refs.insert(0, {
                "sourceId": direct_id,
                "sourceRole": item.get("sourceRole"),
                "sourceRequired": item.get("sourceRequired"),
            })
        unique = []
        seen = set()
        for ref in refs:
            source_id = ref.get("sourceId")
            if not source_id or source_id in seen:
                continue
            seen.add(source_id)
            unique.append(ref)
        return unique

    def record_source(item, emitted):
        refs = source_refs(item)
        if not refs:
            return
        shape_names = []
        for index, op in enumerate(emitted, start=1):
            if op.get("op") not in ("add-shape", "add-picture", "add-table"):
                continue
            if not op.get("name"):
                op["name"] = "%s-part-%d" % (item_name(item, op.get("kind", "shape")), index)
            if op["name"] not in shape_names:
                shape_names.append(op["name"])
        for ref in refs:
            source_id = ref["sourceId"]
            element = slide_map["elements"].setdefault(source_id, {
                "source_role": ref.get("sourceRole"),
                "source_required": bool(ref.get("sourceRequired")),
                "shape_names": [],
            })
            if not element.get("source_role") and ref.get("sourceRole"):
                element["source_role"] = ref["sourceRole"]
            element["source_required"] = bool(
                element.get("source_required") or ref.get("sourceRequired")
            )
            for name in shape_names:
                if name not in element["shape_names"]:
                    element["shape_names"].append(name)

    # the body's own paint arrives as the first item(s) from the extractor
    for item in extract["items"]:
        if item["type"] == "image":
            p = resolve_image(item["src"], html_path.parent, tmpdir, warnings)
            if not p:
                continue
            emitted = [picture_op(p, item["box"], item.get("fit", "fill"), slide_ref, item_name(item, "image"))]
        elif item["type"] == "text":
            slide_width_px = (extract.get("body") or {}).get("w")
            clearance = _text_width_clearance(item, extract["items"], slide_width_px)
            emitted = text_block_ops(
                item,
                slide_ref,
                item_name(item, "text"),
                warnings,
                width_clearance=clearance,
            )
        elif item["type"] == "box":
            emitted = box_ops(item, slide_ref, item_name(item, "box"), warnings)
        elif item["type"] == "table":
            emitted = table_ops(item, slide_ref, item_name(item, "table"), warnings)
        else:
            emitted = []
        record_source(item, emitted)
        ops += emitted
    return ops


def main():
    ap = argparse.ArgumentParser(
        description="Compile HTML slides into a deck.py patch (see deck.py docs).")
    ap.add_argument("html", nargs="+", help="HTML file(s), one per slide")
    ap.add_argument("--deck", help=".pptx to read slide size + count from")
    ap.add_argument("--slide", type=int,
                    help="target EXISTING slide index (single HTML file only)")
    ap.add_argument("--layout", default=None,
                    help="layout for created slides (deck.py add-slide semantics)")
    ap.add_argument("--size", help='slide size in inches, e.g. "13.333x7.5" (no --deck)')
    ap.add_argument("--prefix", default=None,
                    help="shape name prefix (default: h2p-<n>)")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors")
    ap.add_argument("-o", "--out", help="output patch path (default: stdout)")
    ap.add_argument("--source-map", help="optional source-element map JSON path")
    args = ap.parse_args()

    if args.slide is not None and len(args.html) > 1:
        die("--slide targets one existing slide; pass one HTML file")
    if not args.deck and not args.size:
        die("give --deck deck.pptx or --size WxH so geometry can be validated")

    base_count = None
    if args.deck:
        try:
            from pptx import Presentation
        except ImportError:
            die("python-pptx is required for --deck (pip install python-pptx)")
        prs = Presentation(args.deck)
        slide_w = prs.slide_width / 914400
        slide_h = prs.slide_height / 914400
        base_count = len(prs.slides._sldIdLst)
        if args.slide is not None and not (0 <= args.slide < base_count):
            die("--slide %d out of range (deck has %d slides)" % (args.slide, base_count))
    else:
        slide_w, slide_h = parse_size(args.size)
        if args.slide is None:
            die("without --deck, give --slide N (add-slide needs a real deck to count from)")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("playwright is required: pip install playwright && playwright install chromium")

    warnings = []
    all_ops = []
    source_map = {"schema_version": "sophia-deck-source-map/v1", "slides": {}}
    tmpdir = tempfile.mkdtemp(prefix="html2patch-")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": int(slide_w * 96), "height": int(slide_h * 96)})
        for i, html_file in enumerate(args.html):
            html_path = Path(html_file).resolve()
            if not html_path.exists():
                die("no such file: %s" % html_file)
            page.goto(html_path.as_uri())
            extract = page.evaluate(EXTRACT_JS)
            body = extract["body"]

            errs = list(extract.get("errors") or [])
            if abs(body["w"] / PX_PER_IN - slide_w) > 0.05 or abs(body["h"] / PX_PER_IN - slide_h) > 0.05:
                errs.append(
                    "%s: body is %.2fx%.2fin but the slide is %.2fx%.2fin — set "
                    "body {width:%dpx; height:%dpx}" % (
                        html_file, body["w"] / PX_PER_IN, body["h"] / PX_PER_IN,
                        slide_w, slide_h, round(slide_w * 96), round(slide_h * 96)))
            over_w = max(0, body["scrollW"] - body["w"] - 1)
            over_h = max(0, body["scrollH"] - body["h"] - 1)
            if over_w or over_h:
                errs.append("%s: content overflows the body by %dpx horizontally / %dpx "
                            "vertically — fix the HTML before compiling" % (html_file, over_w, over_h))
            if errs:
                die("\n".join(errs))

            if args.slide is not None:
                slide_ref = args.slide
            else:
                slide_ref = base_count + i
                all_ops.append({"op": "add-slide",
                                **({"layout": args.layout} if args.layout else {})})
            prefix = args.prefix or ("h2p-%d" % (i + 1) if len(args.html) > 1 else "h2p")
            for w in extract["warnings"]:
                warnings.append("%s: %s" % (html_file, w))
            all_ops += compile_page(extract, slide_ref, html_path, tmpdir, prefix, warnings, source_map)
        browser.close()

    for w in sorted(set(warnings)):
        sys.stderr.write("html2patch: warning: %s\n" % w)
    if warnings and args.strict:
        die("%d warning(s) with --strict" % len(warnings))

    patch = json.dumps({"ops": all_ops}, indent=1, ensure_ascii=False)
    if args.source_map:
        Path(args.source_map).write_text(
            json.dumps(source_map, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    if args.out:
        Path(args.out).write_text(patch + "\n")
        sys.stderr.write("html2patch: %d op(s) -> %s\n" % (len(all_ops), args.out))
    else:
        print(patch)


if __name__ == "__main__":
    main()
