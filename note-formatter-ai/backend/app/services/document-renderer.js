import fs from "node:fs";

import PDFDocument from "pdfkit";

import { appConfig } from "../config.js";
import { parseBoldSegments, stripMarkdownBold } from "./text-utils.js";

function getLayout(profile) {
  const pageWidth = profile.paper.width;
  const pageHeight = profile.paper.height;
  const contentWidth =
    pageWidth - profile.layout.marginLeft - profile.layout.marginRight;
  const columnWidth =
    (contentWidth - profile.layout.columnGap) / profile.layout.columns;
  const rightColumnX =
    profile.layout.marginLeft + columnWidth + profile.layout.columnGap;

  return {
    contentWidth,
    columnWidth,
    maxY: pageHeight - profile.layout.marginBottom,
    pageHeight,
    pageWidth,
    rightColumnX,
  };
}

function registerFonts(doc) {
  doc.registerFont("Times-Regular", appConfig.paths.fonts.regular);
  doc.registerFont("Times-Bold", appConfig.paths.fonts.bold);
  doc.registerFont("Times-Italic", appConfig.paths.fonts.italic);
  doc.registerFont("Times-BoldItalic", appConfig.paths.fonts.boldItalic);
}

function createCursor(profile, layout) {
  return {
    column: 0,
    firstPageColumnTop: profile.layout.marginTop,
    layout,
    pageNumber: 1,
    x: profile.layout.marginLeft,
    y: profile.layout.marginTop,
  };
}

function getColumnTopY(cursor, profile) {
  return cursor.pageNumber === 1
    ? cursor.firstPageColumnTop
    : profile.layout.marginTop;
}

function setCursorColumn(cursor, profile, column) {
  cursor.column = column;
  cursor.x =
    column === 0 ? profile.layout.marginLeft : cursor.layout.rightColumnX;
  cursor.y = getColumnTopY(cursor, profile);
}

function moveToNextColumn(doc, cursor, profile) {
  if (cursor.column === 0) {
    setCursorColumn(cursor, profile, 1);
    return;
  }

  doc.addPage({
    compress: true,
    margins: {
      bottom: 0,
      left: 0,
      right: 0,
      top: 0,
    },
    size: [profile.paper.width, profile.paper.height],
  });

  cursor.pageNumber += 1;
  setCursorColumn(cursor, profile, 0);
}

function ensureSpace(doc, cursor, profile, requiredHeight) {
  if (cursor.y + requiredHeight <= cursor.layout.maxY) {
    return;
  }

  moveToNextColumn(doc, cursor, profile);
}

function withFont(doc, fontName, fontSize, callback) {
  doc.font(fontName);
  doc.fontSize(fontSize);
  return callback();
}

function measureText(doc, fontName, fontSize, text) {
  return withFont(doc, fontName, fontSize, () => doc.widthOfString(text));
}

function normalizeSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeBlockText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSegmentIntoTokens(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  if (!normalized) {
    return [];
  }

  return normalized.match(/\S+|\s+/g) || [];
}

function breakTokenToFit(doc, token, availableWidth, fontName, fontSize) {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return [];
  }

  const parts = [];
  let startIndex = 0;

  while (startIndex < cleanToken.length) {
    let candidate = "";
    let endIndex = startIndex;

    while (endIndex < cleanToken.length) {
      const nextCandidate = `${candidate}${cleanToken[endIndex]}`;
      const nextWidth = measureText(doc, fontName, fontSize, nextCandidate);

      if (nextWidth > availableWidth && candidate) {
        break;
      }

      candidate = nextCandidate;
      endIndex += 1;

      if (nextWidth > availableWidth) {
        break;
      }
    }

    parts.push(candidate);
    startIndex = endIndex;
  }

  return parts;
}

function createLine() {
  return {
    parts: [],
    width: 0,
  };
}

function finalizeLine(lines, line) {
  if (line.parts.length) {
    lines.push(line);
  }
}

function appendPartToLine(line, part, width) {
  line.parts.push(part);
  line.width += width;
}

function createWrappedLines(doc, text, options) {
  const sourceSegments = parseBoldSegments(text).filter((segment) =>
    normalizeSpaces(segment.text),
  );
  const richSegments = sourceSegments.length
    ? sourceSegments
    : [
        {
          bold: false,
          text: stripMarkdownBold(text),
        },
      ];
  const lines = [];
  let currentLine = createLine();

  for (const segment of richSegments) {
    const fontName = segment.bold ? options.boldFont : options.font;
    const tokens = splitSegmentIntoTokens(segment.text);

    for (const token of tokens) {
      const isWhitespace = /^\s+$/.test(token);
      const nextToken = currentLine.parts.length ? token : token.trimStart();
      if (!nextToken) {
        continue;
      }

      const tokenWidth = measureText(
        doc,
        fontName,
        options.fontSize,
        nextToken,
      );

      if (currentLine.width + tokenWidth <= options.width) {
        appendPartToLine(currentLine, { fontName, text: nextToken }, tokenWidth);
        continue;
      }

      if (isWhitespace) {
        finalizeLine(lines, currentLine);
        currentLine = createLine();
        continue;
      }

      if (!currentLine.parts.length) {
        const tokenParts = breakTokenToFit(
          doc,
          nextToken,
          options.width,
          fontName,
          options.fontSize,
        );

        for (let index = 0; index < tokenParts.length; index += 1) {
          const tokenPart = tokenParts[index];
          const partWidth = measureText(
            doc,
            fontName,
            options.fontSize,
            tokenPart,
          );

          if (index !== 0) {
            finalizeLine(lines, currentLine);
            currentLine = createLine();
          }

          appendPartToLine(currentLine, { fontName, text: tokenPart }, partWidth);
        }

        continue;
      }

      finalizeLine(lines, currentLine);
      currentLine = createLine();

      const retryToken = token.trimStart();
      const retryWidth = measureText(
        doc,
        fontName,
        options.fontSize,
        retryToken,
      );

      if (retryWidth <= options.width) {
        appendPartToLine(currentLine, { fontName, text: retryToken }, retryWidth);
        continue;
      }

      const tokenParts = breakTokenToFit(
        doc,
        retryToken,
        options.width,
        fontName,
        options.fontSize,
      );

      for (let index = 0; index < tokenParts.length; index += 1) {
        const tokenPart = tokenParts[index];
        const partWidth = measureText(
          doc,
          fontName,
          options.fontSize,
          tokenPart,
        );

        if (index !== 0) {
          finalizeLine(lines, currentLine);
          currentLine = createLine();
        }

        appendPartToLine(currentLine, { fontName, text: tokenPart }, partWidth);
      }
    }
  }

  finalizeLine(lines, currentLine);
  return lines;
}

function createWrappedLineGroups(doc, text, options) {
  const cleanText = normalizeBlockText(text);
  if (!cleanText) {
    return [];
  }

  return cleanText
    .split(/\n+/)
    .map((segment) => createWrappedLines(doc, normalizeSpaces(segment), options))
    .filter((group) => group.length);
}

function renderLine(doc, x, y, line, options) {
  let offsetX = 0;

  for (const part of line.parts) {
    withFont(doc, part.fontName, options.fontSize, () => {
      doc.text(part.text, x + offsetX, y, {
        lineBreak: false,
      });
    });
    offsetX += measureText(doc, part.fontName, options.fontSize, part.text);
  }
}

function getLineHeight(options) {
  return options.fontSize + options.lineGap;
}

function getExplicitBreakGap(options) {
  return options.explicitBreakGap || Math.max(1.2, options.lineGap + 0.4);
}

function estimateWrappedBlockHeight(lineGroups, options) {
  const lineHeight = getLineHeight(options);
  const explicitBreakGap = getExplicitBreakGap(options);
  const lineCount = lineGroups.reduce((total, group) => total + group.length, 0);
  const breakCount = Math.max(0, lineGroups.length - 1);

  return (
    (options.before || 0) +
    (options.after || 0) +
    lineCount * lineHeight +
    breakCount * explicitBreakGap
  );
}

function drawWrappedBlock(doc, cursor, profile, lineGroups, options) {
  if (!lineGroups.length) {
    return;
  }

  const lineHeight = getLineHeight(options);
  const explicitBreakGap = getExplicitBreakGap(options);
  let beforeApplied = false;

  for (let groupIndex = 0; groupIndex < lineGroups.length; groupIndex += 1) {
    const group = lineGroups[groupIndex];

    for (let lineIndex = 0; lineIndex < group.length; lineIndex += 1) {
      if (!beforeApplied && options.before) {
        ensureSpace(doc, cursor, profile, lineHeight + options.before);
        cursor.y += options.before;
        beforeApplied = true;
      } else if (!beforeApplied) {
        beforeApplied = true;
      }

      if (cursor.y + lineHeight > cursor.layout.maxY) {
        moveToNextColumn(doc, cursor, profile);
      }

      const currentLine = group[lineIndex];
      const textX =
        cursor.x +
        (options.indent || 0) +
        (options.indentFirstLine && groupIndex === 0 && lineIndex === 0
          ? options.indentFirstLine
          : 0);

      if (options.bullet && groupIndex === 0 && lineIndex === 0) {
        withFont(doc, options.bulletFont || options.boldFont, options.fontSize, () => {
          doc.text(options.bullet, cursor.x, cursor.y, {
            lineBreak: false,
          });
        });
      }

      renderLine(doc, textX, cursor.y, currentLine, options);
      cursor.y += lineHeight;
    }

    if (groupIndex < lineGroups.length - 1) {
      if (cursor.y + explicitBreakGap > cursor.layout.maxY) {
        moveToNextColumn(doc, cursor, profile);
      } else {
        cursor.y += explicitBreakGap;
      }
    }
  }

  cursor.y += options.after || 0;
}

function estimateTextBlockHeight(doc, text, options) {
  const lineGroups = createWrappedLineGroups(doc, text, options);
  if (!lineGroups.length) {
    return 0;
  }

  return estimateWrappedBlockHeight(lineGroups, options);
}

function renderPlainBlock(doc, cursor, profile, text, options) {
  const lineGroups = createWrappedLineGroups(doc, text, options);
  if (!lineGroups.length) {
    return;
  }

  drawWrappedBlock(doc, cursor, profile, lineGroups, options);
}

function renderTitle(doc, cursor, profile, title, options) {
  const lineGroups = createWrappedLineGroups(doc, title, {
    ...options,
    width: cursor.layout.contentWidth,
  });
  if (!lineGroups.length) {
    return;
  }

  const lines = lineGroups.flat();
  const lineHeight = getLineHeight(options);
  const totalHeight = estimateWrappedBlockHeight(lineGroups, {
    ...options,
    before: 0,
    width: cursor.layout.contentWidth,
  });
  ensureSpace(doc, cursor, profile, totalHeight);

  for (const line of lines) {
    const startX =
      profile.layout.marginLeft +
      Math.max(0, (cursor.layout.contentWidth - line.width) / 2);
    renderLine(doc, startX, cursor.y, line, options);
    cursor.y += lineHeight;
  }

  cursor.y += options.after;
  cursor.firstPageColumnTop = cursor.y;
  setCursorColumn(cursor, profile, 0);
}

function createBlockOptions(block, profile, layout, paragraphGap, bodyLineGap) {
  if (block.type === "heading") {
    return {
      after: paragraphGap,
      before: 2.4,
      boldFont: "Times-Bold",
      font: "Times-Bold",
      fontSize: profile.typography.headingSize,
      lineGap: 0.8,
      width: layout.columnWidth,
    };
  }

  if (block.type === "subheading") {
    return {
      after: Math.max(2, paragraphGap - 0.4),
      before: 1.8,
      boldFont: "Times-Bold",
      font: "Times-Bold",
      fontSize: profile.typography.subheadingSize,
      lineGap: 0.7,
      width: layout.columnWidth,
    };
  }

  if (block.type === "bullet") {
    const marker = block.marker || "\u2022";
    const markerIndent = Math.max(
      profile.layout.bulletIndent,
      Math.min(20, 4 + marker.length * profile.typography.bodySize * 0.32),
    );

    return {
      after: Math.max(1.4, paragraphGap - 0.8),
      boldFont: "Times-Bold",
      bullet: marker,
      bulletFont: "Times-Bold",
      explicitBreakGap: Math.max(1.2, bodyLineGap - 0.1),
      font: "Times-Regular",
      fontSize: profile.typography.bodySize,
      indent: markerIndent,
      lineGap: bodyLineGap,
      width: layout.columnWidth - markerIndent,
    };
  }

  return {
    after: paragraphGap,
    boldFont: "Times-Bold",
    explicitBreakGap: Math.max(1.2, bodyLineGap),
    font: "Times-Regular",
    fontSize: profile.typography.bodySize,
    lineGap: bodyLineGap,
    width: layout.columnWidth,
  };
}

function estimateKeepWithNextHeight(
  doc,
  block,
  nextBlock,
  profile,
  layout,
  paragraphGap,
  bodyLineGap,
) {
  const currentOptions = createBlockOptions(
    block,
    profile,
    layout,
    paragraphGap,
    bodyLineGap,
  );
  const currentHeight = estimateTextBlockHeight(doc, block.text, currentOptions);

  if (!nextBlock?.text) {
    return currentHeight;
  }

  const nextOptions = createBlockOptions(
    nextBlock,
    profile,
    layout,
    paragraphGap,
    bodyLineGap,
  );
  const nextHeight = estimateTextBlockHeight(doc, nextBlock.text, nextOptions);
  const nextPreview = Math.min(
    nextHeight,
    getLineHeight(nextOptions) * 3 + (nextOptions.after || 0),
  );

  return currentHeight + nextPreview;
}

function fitBox(sourceWidth, sourceHeight, maxWidth, maxHeight) {
  if (!sourceWidth || !sourceHeight) {
    return {
      height: 0,
      width: 0,
    };
  }

  const widthScale = maxWidth / sourceWidth;
  const heightScale = maxHeight / sourceHeight;
  const scale = Math.min(widthScale, heightScale);

  return {
    height: sourceHeight * scale,
    width: sourceWidth * scale,
  };
}

function renderImageBlock(doc, cursor, profile, image, options) {
  if (!image?.buffer || !image.width || !image.height) {
    return;
  }

  const maxWidth = options.width || cursor.layout.columnWidth;
  const maxHeight =
    options.maxHeight || Math.min(cursor.layout.pageHeight * 0.32, 220);
  const size = fitBox(image.width, image.height, maxWidth, maxHeight);

  if (!size.width || !size.height) {
    return;
  }

  const totalHeight = (options.before || 0) + size.height + (options.after || 0);
  ensureSpace(doc, cursor, profile, totalHeight);

  cursor.y += options.before || 0;
  doc.image(
    image.buffer,
    cursor.x + Math.max(0, (maxWidth - size.width) / 2),
    cursor.y,
    {
      height: size.height,
      width: size.width,
    },
  );
  cursor.y += size.height + (options.after || 0);
}

export async function renderStructuredPdf({ structure, profile, outputPath }) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      compress: true,
      margins: {
        bottom: 0,
        left: 0,
        right: 0,
        top: 0,
      },
      size: [profile.paper.width, profile.paper.height],
    });
    const stream = fs.createWriteStream(outputPath);
    const layout = getLayout(profile);
    const cursor = createCursor(profile, layout);
    const bodyLineGap = Math.max(
      0.8,
      Math.min(1.35, (profile.typography.lineGap || 1.2) - 0.35),
    );
    const paragraphGap = Math.max(
      2.2,
      Math.min(3.6, (profile.typography.paragraphGap || 4) - 1.2),
    );

    doc.pipe(stream);
    registerFonts(doc);

    if (structure.title?.trim()) {
      renderTitle(doc, cursor, profile, structure.title, {
        after: paragraphGap + 4,
        boldFont: "Times-Bold",
        font: "Times-Bold",
        fontSize: profile.typography.titleSize,
        lineGap: 0.8,
        width: layout.contentWidth,
      });
    }

    for (let index = 0; index < structure.blocks.length; index += 1) {
      const block = structure.blocks[index];

      if (block.type === "image") {
        renderImageBlock(doc, cursor, profile, block.image, {
          after: paragraphGap + 1.2,
          before: 1.8,
          maxHeight: Math.min(profile.paper.height * 0.32, 220),
          width: layout.columnWidth,
        });
        continue;
      }

      const options = createBlockOptions(
        block,
        profile,
        layout,
        paragraphGap,
        bodyLineGap,
      );
      const nextTextBlock = structure.blocks
        .slice(index + 1)
        .find((candidate) => candidate.type !== "image");

      if (block.type === "heading" || block.type === "subheading") {
        ensureSpace(
          doc,
          cursor,
          profile,
          estimateKeepWithNextHeight(
            doc,
            block,
            nextTextBlock,
            profile,
            layout,
            paragraphGap,
            bodyLineGap,
          ),
        );
      }

      renderPlainBlock(doc, cursor, profile, block.text, options);
    }

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return outputPath;
}
