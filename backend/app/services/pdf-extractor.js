import fs from "node:fs/promises";
import path from "node:path";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  getImageDimensions,
  normalizeImageMimeType,
  pdfImageToPngBuffer,
} from "./image-utils.js";
import { average, median, percentile, round } from "./math-utils.js";
import { normalizeWhitespace } from "./text-utils.js";

const LINE_TOLERANCE = 2.5;
const MIN_IMAGE_DIMENSION = 18;
const MIN_IMAGE_AREA = 550;
const MIN_LINE_SEGMENT_GAP = 18;
const MAX_LINE_SEGMENT_GAP_RATIO = 0.11;
const IMAGE_OBJECT_RESOLVE_TIMEOUT_MS = 750;

function mapTextItem(item) {
  const x = item.transform?.[4] || 0;
  const y = item.transform?.[5] || 0;
  const fontSize = Math.abs(item.height || item.transform?.[0] || 0);

  return {
    text: normalizeWhitespace(item.str),
    x,
    y,
    width: Math.abs(item.width || 0),
    height: Math.abs(item.height || fontSize || 0),
    fontSize: fontSize || 9,
    fontName: item.fontName || "",
    isBold: /bold|black|demi/i.test(item.fontName || ""),
    isItalic: /italic|oblique/i.test(item.fontName || ""),
  };
}

function mergeLineText(items) {
  const sortedItems = [...items].sort((left, right) => left.x - right.x);
  let text = "";
  let previousItem;

  for (const item of sortedItems) {
    if (!item.text) {
      continue;
    }

    const gap = previousItem
      ? item.x - (previousItem.x + previousItem.width)
      : 0;
    const needsSpace =
      text &&
      gap > Math.max(0.8, item.fontSize * 0.12) &&
      !/^[,.;:)\]]/.test(item.text) &&
      !/[(/[-]$/.test(previousItem?.text || "");

    text += `${needsSpace ? " " : ""}${item.text}`;
    previousItem = item;
  }

  return normalizeWhitespace(text);
}

function buildLine(items, pageHeight) {
  const sortedItems = [...items].sort((left, right) => left.x - right.x);
  const x = Math.min(...sortedItems.map((item) => item.x));
  const endX = Math.max(...sortedItems.map((item) => item.x + item.width));
  const y = average(sortedItems.map((item) => item.y));
  const lineFontSize = median(sortedItems.map((item) => item.fontSize));
  const height = Math.max(...sortedItems.map((item) => item.height || item.fontSize));
  const text = mergeLineText(sortedItems);

  return {
    text,
    x: round(x),
    endX: round(endX),
    y: round(y),
    top: round(pageHeight - y),
    fontSize: round(lineFontSize || 9),
    height: round(height || lineFontSize || 9),
    isBold: sortedItems.some((item) => item.isBold),
    isItalic: sortedItems.some((item) => item.isItalic),
    items: sortedItems,
  };
}

function getLineSegmentGap(previousItem, item, pageWidth) {
  return Math.max(
    MIN_LINE_SEGMENT_GAP,
    Math.min(
      pageWidth * MAX_LINE_SEGMENT_GAP_RATIO,
      Math.max(previousItem.fontSize, item.fontSize) * 4.5,
    ),
  );
}

function splitItemsIntoLineSegments(items, pageWidth) {
  const sortedItems = [...items].sort((left, right) => left.x - right.x);
  const segments = [];
  let currentSegment = [];
  let previousItem;

  for (const item of sortedItems) {
    if (!currentSegment.length) {
      currentSegment.push(item);
      previousItem = item;
      continue;
    }

    const gap = item.x - (previousItem.x + previousItem.width);
    if (gap > getLineSegmentGap(previousItem, item, pageWidth)) {
      segments.push(currentSegment);
      currentSegment = [item];
      previousItem = item;
      continue;
    }

    currentSegment.push(item);
    previousItem = item;
  }

  if (currentSegment.length) {
    segments.push(currentSegment);
  }

  return segments;
}

function groupItemsIntoLines(items, pageHeight, pageWidth) {
  const filtered = items
    .map(mapTextItem)
    .filter((item) => item.text && item.width > 0);
  const sorted = filtered.sort((left, right) => {
    const yDelta = Math.abs(left.y - right.y);
    if (yDelta <= LINE_TOLERANCE) {
      return left.x - right.x;
    }

    return right.y - left.y;
  });

  const lines = [];

  for (const item of sorted) {
    const existingLine = lines.findLast(
      (line) => Math.abs(line.anchorY - item.y) <= LINE_TOLERANCE,
    );

    if (!existingLine) {
      lines.push({
        anchorY: item.y,
        items: [item],
      });
      continue;
    }

    existingLine.items.push(item);
    existingLine.anchorY = average(
      existingLine.items.map((lineItem) => lineItem.y),
    );
  }

  return lines
    .flatMap((line) =>
      splitItemsIntoLineSegments(line.items, pageWidth).map((segment) =>
        buildLine(segment, pageHeight),
      ),
    )
    .filter((line) => line.text)
    .sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });
}

function detectColumns(lines, pageWidth) {
  const candidateLines = lines.filter(
    (line) => line.text.length > 3 && line.endX - line.x < pageWidth * 0.72,
  );

  const leftLines = candidateLines.filter((line) => line.x < pageWidth / 2);
  const rightLines = candidateLines.filter((line) => line.x >= pageWidth / 2);

  if (leftLines.length < 12 || rightLines.length < 12) {
    const marginLeft = percentile(candidateLines.map((line) => line.x), 0.1) || 24;
    const marginRight =
      pageWidth - percentile(candidateLines.map((line) => line.endX), 0.9) || 24;
    return {
      columns: 1,
      threshold: pageWidth / 2,
      marginLeft: round(marginLeft),
      marginRight: round(marginRight),
      columnGap: 0,
    };
  }

  const leftMargin = percentile(leftLines.map((line) => line.x), 0.1);
  const rightMargin = pageWidth - percentile(rightLines.map((line) => line.endX), 0.9);
  const leftEnd = percentile(leftLines.map((line) => line.endX), 0.9);
  const rightStart = percentile(rightLines.map((line) => line.x), 0.1);
  const threshold = average([leftEnd, rightStart]);

  return {
    columns: 2,
    threshold: round(threshold),
    marginLeft: round(leftMargin),
    marginRight: round(rightMargin),
    columnGap: round(Math.max(12, rightStart - leftEnd)),
  };
}

function sortLinesForReadingOrder(lines, columnInfo) {
  if (columnInfo.columns === 1) {
    return [...lines].sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });
  }

  const leftColumn = lines
    .filter((line) => line.x < columnInfo.threshold)
    .sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });

  const rightColumn = lines
    .filter((line) => line.x >= columnInfo.threshold)
    .sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });

  return [...leftColumn, ...rightColumn];
}

function transformPoint(x, y, transform) {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  };
}

function getBoundsFromTransform(transform) {
  const corners = [
    transformPoint(0, 0, transform),
    transformPoint(1, 0, transform),
    transformPoint(0, 1, transform),
    transformPoint(1, 1, transform),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function getItemColumn(item, columnInfo) {
  if (columnInfo.columns === 1) {
    return 0;
  }

  const centerX = (item.x + item.endX) / 2;
  return centerX < columnInfo.threshold ? 0 : 1;
}

function sortReadingItemsForReadingOrder(items, columnInfo) {
  if (columnInfo.columns === 1) {
    return [...items].sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });
  }

  const leftColumn = items
    .filter((item) => getItemColumn(item, columnInfo) === 0)
    .sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });

  const rightColumn = items
    .filter((item) => getItemColumn(item, columnInfo) === 1)
    .sort((left, right) => {
      const delta = Math.abs(left.y - right.y);
      if (delta <= LINE_TOLERANCE) {
        return left.x - right.x;
      }

      return right.y - left.y;
    });

  return [...leftColumn, ...rightColumn];
}

function buildPlainText(pages) {
  const pageSections = pages.map((page) => {
    const orderedLines = sortLinesForReadingOrder(page.lines, page.columnInfo);
    const parts = [];
    let previousLine;

    for (const line of orderedLines) {
      if (!line.text) {
        continue;
      }

      if (!previousLine) {
        parts.push(line.text);
        previousLine = line;
        continue;
      }

      const verticalGap = Math.abs(previousLine.y - line.y);
      const paragraphBreak = verticalGap > previousLine.fontSize * 1.65;
      parts.push(paragraphBreak ? `\n\n${line.text}` : `\n${line.text}`);
      previousLine = line;
    }

    return normalizeWhitespace(parts.join(""));
  });

  return normalizeWhitespace(pageSections.join("\n\n"));
}

function isMeaningfulImage(image) {
  return (
    image.displayWidth >= MIN_IMAGE_DIMENSION &&
    image.displayHeight >= MIN_IMAGE_DIMENSION &&
    image.displayWidth * image.displayHeight >= MIN_IMAGE_AREA
  );
}

function dedupeImages(images) {
  const seen = new Set();

  return images.filter((image) => {
    const key = [
      image.name,
      Math.round(image.x),
      Math.round(image.top),
      Math.round(image.displayWidth),
      Math.round(image.displayHeight),
    ].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function getNamedImageObject(page, cache, imageName) {
  if (!imageName) {
    return null;
  }

  if (!cache.has(imageName)) {
    cache.set(
      imageName,
      (async () => {
        if (page.objs.has(imageName)) {
          try {
            return page.objs.get(imageName);
          } catch {
            return null;
          }
        }

        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            console.warn(
              `Skipping unresolved PDF image object "${imageName}" on page ${page.pageNumber}.`,
            );
            resolve(null);
          }, IMAGE_OBJECT_RESOLVE_TIMEOUT_MS);

          try {
            page.objs.get(imageName, (value) => {
              clearTimeout(timer);
              resolve(value || null);
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      })(),
    );
  }

  return cache.get(imageName);
}

async function extractPageImages(page, pageNumber, pageWidth, pageHeight) {
  const opList = await page.getOperatorList();
  const images = [];
  const imageObjectCache = new Map();
  const markedContentStack = [];
  const stack = [];
  let currentTransform = [1, 0, 0, 1, 0, 0];

  for (let index = 0; index < opList.fnArray.length; index += 1) {
    const fn = opList.fnArray[index];
    const args = opList.argsArray[index];

    if (fn === pdfjs.OPS.save) {
      stack.push({
        transform: [...currentTransform],
        markedDepth: markedContentStack.length,
      });
      continue;
    }

    if (fn === pdfjs.OPS.restore) {
      const previousState = stack.pop();
      currentTransform = previousState?.transform || [1, 0, 0, 1, 0, 0];
      if (previousState) {
        markedContentStack.length = previousState.markedDepth;
      }
      continue;
    }

    if (fn === pdfjs.OPS.transform) {
      currentTransform = pdfjs.Util.transform(currentTransform, args);
      continue;
    }

    if (fn === pdfjs.OPS.beginMarkedContent) {
      markedContentStack.push(args?.[0]?.name || args?.[0] || "");
      continue;
    }

    if (fn === pdfjs.OPS.beginMarkedContentProps) {
      markedContentStack.push(args?.[0] || "");
      continue;
    }

    if (fn === pdfjs.OPS.endMarkedContent) {
      markedContentStack.pop();
      continue;
    }

    if (fn !== pdfjs.OPS.paintImageXObject) {
      continue;
    }

    const imageName = args?.[0];
    const imageObject = await getNamedImageObject(page, imageObjectCache, imageName);

    if (!imageObject?.data || !imageObject.width || !imageObject.height) {
      continue;
    }

    const bounds = getBoundsFromTransform(currentTransform);
    const displayWidth = round(bounds.maxX - bounds.minX);
    const displayHeight = round(bounds.maxY - bounds.minY);

    const image = {
      type: "image",
      id: `image-${pageNumber}-${images.length + 1}`,
      name: imageName,
      pageNumber,
      x: round(bounds.minX),
      endX: round(bounds.maxX),
      y: round(bounds.maxY),
      top: round(pageHeight - bounds.maxY),
      displayWidth,
      displayHeight,
      width: imageObject.width,
      height: imageObject.height,
      markedTag: String(markedContentStack.at(-1) || ""),
      relativeWidth: round(displayWidth / pageWidth, 3),
    };

    if (!isMeaningfulImage(image)) {
      continue;
    }

    image.buffer = pdfImageToPngBuffer(imageObject);
    images.push(image);
  }

  return dedupeImages(images);
}

function createUnsupportedInputError() {
  const error = new Error("Only PDF, PNG, and JPEG notes files are supported");
  error.status = 400;
  return error;
}

function detectUploadType({ filePath, fileName, mimeType }) {
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  const extension = path.extname(fileName || filePath || "").toLowerCase();

  if (normalizedMimeType === "application/pdf" || extension === ".pdf") {
    return "pdf";
  }

  if (normalizeImageMimeType(normalizedMimeType, fileName || filePath)) {
    return "image";
  }

  return "";
}

function createSingleImageDocument({
  buffer,
  fileName,
  filePath,
  height,
  mimeType,
  width,
}) {
  const image = {
    type: "image",
    id: "image-1-1",
    name: path.basename(fileName || filePath),
    pageNumber: 1,
    x: 0,
    endX: round(width),
    y: round(height),
    top: 0,
    displayWidth: round(width),
    displayHeight: round(height),
    width: round(width),
    height: round(height),
    markedTag: "",
    relativeWidth: 1,
    mimeType,
    buffer,
  };

  const page = {
    pageNumber: 1,
    width: round(width),
    height: round(height),
    lines: [],
    images: [image],
    columnInfo: {
      columns: 1,
      threshold: round(width / 2),
      marginLeft: 0,
      marginRight: 0,
      columnGap: 0,
    },
    readingOrder: [],
    readingItems: [image],
  };

  return {
    filePath,
    fileName: path.basename(fileName || filePath),
    pageCount: 1,
    pages: [page],
    images: [image],
    readingItems: [image],
    plainText: "",
    stats: {
      imageCount: 1,
      medianFontSize: 9,
      headingCandidateSize: 11,
    },
  };
}

export async function extractImageDocument(filePath, options = {}) {
  const fileName = options.fileName || path.basename(filePath);
  const mimeType = normalizeImageMimeType(options.mimeType, fileName);
  if (!mimeType) {
    throw createUnsupportedInputError();
  }

  const buffer = await fs.readFile(filePath);
  const { width, height } = getImageDimensions(buffer, mimeType);

  return createSingleImageDocument({
    buffer,
    fileName,
    filePath,
    height,
    mimeType,
    width,
  });
}

export async function extractPdfDocument(filePath, options = {}) {
  const { includeImages = true } = options;
  const rawBytes = await fs.readFile(filePath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(rawBytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const lines = groupItemsIntoLines(
      textContent.items,
      viewport.height,
      viewport.width,
    );
    const columnInfo = detectColumns(lines, viewport.width);
    const readingOrder = sortLinesForReadingOrder(lines, columnInfo);
    const images = includeImages
      ? await extractPageImages(page, pageNumber, viewport.width, viewport.height)
      : [];
    const readingItems = sortReadingItemsForReadingOrder(
      [
        ...readingOrder.map((line) => ({
          ...line,
          pageNumber,
          type: "line",
        })),
        ...images,
      ],
      columnInfo,
    );

    pages.push({
      pageNumber,
      width: round(viewport.width),
      height: round(viewport.height),
      lines,
      images,
      columnInfo,
      readingOrder,
      readingItems,
    });
  }

  const allFontSizes = pages.flatMap((page) =>
    page.lines.map((line) => line.fontSize).filter(Boolean),
  );
  const images = pages.flatMap((page) => page.images);
  const readingItems = pages.flatMap((page) => page.readingItems);

  return {
    filePath,
    fileName: path.basename(filePath),
    pageCount: pdf.numPages,
    pages,
    images,
    readingItems,
    plainText: buildPlainText(pages),
    stats: {
      imageCount: images.length,
      medianFontSize: round(median(allFontSizes) || 9),
      headingCandidateSize: round(percentile(allFontSizes, 0.9) || 11),
    },
  };
}

export async function extractSupportedDocument(input) {
  const filePath = input?.filePath || input?.path;
  const fileName = input?.fileName || input?.originalName || input?.originalname;
  const mimeType = input?.mimeType || input?.mimetype || "";
  const uploadType = detectUploadType({
    filePath,
    fileName,
    mimeType,
  });

  if (uploadType === "pdf") {
    return extractPdfDocument(filePath);
  }

  if (uploadType === "image") {
    return extractImageDocument(filePath, {
      fileName,
      mimeType,
    });
  }

  throw createUnsupportedInputError();
}
