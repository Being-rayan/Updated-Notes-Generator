import fs from "node:fs/promises";
import crypto from "node:crypto";

import { appConfig } from "../config.js";
import { listPdfFiles } from "./file-store.js";
import { clamp, median, percentile, round } from "./math-utils.js";
import { extractPdfDocument } from "./pdf-extractor.js";

function createDefaultProfile(sampleCount = 0) {
  return {
    name: "default",
    createdAt: new Date().toISOString(),
    sourceSampleCount: sampleCount,
    paper: {
      width: appConfig.defaults.page.width,
      height: appConfig.defaults.page.height,
    },
    layout: { ...appConfig.defaults.layout },
    typography: { ...appConfig.defaults.typography },
    heuristics: { ...appConfig.defaults.heuristics },
  };
}

function analyzeDocuments(documents) {
  const defaults = createDefaultProfile(documents.length);
  const twoColumnPages = documents
    .flatMap((document) => document.pages)
    .filter((page) => page.columnInfo.columns === 2);
  const allLines = documents.flatMap((document) =>
    document.pages.flatMap((page) => page.lines),
  );
  const bodySizeCandidates = allLines
    .filter((line) => line.text && line.text.length >= 24 && !line.isBold)
    .map((line) => line.fontSize);
  const bodySize = clamp(
    percentile(
      bodySizeCandidates.length
        ? bodySizeCandidates
        : allLines.map((line) => line.fontSize),
      0.5,
    ) || defaults.typography.bodySize,
    8.4,
    9.4,
  );
  const largeSizes = allLines
    .map((line) => line.fontSize)
    .filter((size) => size >= bodySize + 0.35);

  const marginLeftValues = twoColumnPages.map((page) => page.columnInfo.marginLeft);
  const marginRightValues = twoColumnPages.map((page) => page.columnInfo.marginRight);
  const columnGapValues = twoColumnPages.map((page) => page.columnInfo.columnGap);

  const lineGapCandidates = [];
  for (const page of documents.flatMap((document) => document.pages)) {
    const ordered = page.readingOrder;
    for (let index = 1; index < ordered.length; index += 1) {
      const currentLine = ordered[index];
      const previousLine = ordered[index - 1];
      const sameColumn =
        page.columnInfo.columns === 1 ||
        (currentLine.x < page.columnInfo.threshold &&
          previousLine.x < page.columnInfo.threshold) ||
        (currentLine.x >= page.columnInfo.threshold &&
          previousLine.x >= page.columnInfo.threshold);

      if (!sameColumn) {
        continue;
      }

      const delta = Math.abs(previousLine.y - currentLine.y);
      const candidate = delta - previousLine.fontSize;
      if (candidate > -1 && candidate < 4) {
        lineGapCandidates.push(candidate);
      }
    }
  }

  const paragraphGap = clamp((median(lineGapCandidates) || 1.3) + 1.9, 3.4, 5.1);
  const headingBase = percentile(largeSizes, 0.5) || bodySize + 1.6;
  const subheadingBase = percentile(largeSizes, 0.25) || bodySize + 0.7;
  const titleBase = percentile(largeSizes, 0.95) || bodySize + 4.8;

  return {
    ...defaults,
    sourceSampleCount: documents.length,
    layout: {
      ...defaults.layout,
      marginLeft: round(
        clamp(percentile(marginLeftValues, 0.5) || defaults.layout.marginLeft, 14, 30),
      ),
      marginRight: round(
        clamp(
          percentile(marginRightValues, 0.5) || defaults.layout.marginRight,
          14,
          30,
        ),
      ),
      columnGap: round(
        clamp(percentile(columnGapValues, 0.5) || defaults.layout.columnGap, 12, 28),
      ),
    },
    typography: {
      ...defaults.typography,
      bodySize: round(bodySize),
      lineGap: round(clamp(median(lineGapCandidates) || 1.3, 1.1, 1.8)),
      paragraphGap: round(paragraphGap),
      headingSize: round(
        clamp(headingBase, bodySize + 1.1, bodySize + 2.4),
      ),
      titleSize: round(
        clamp(titleBase, bodySize + 4, bodySize + 6.2),
      ),
      subheadingSize: round(
        clamp(subheadingBase, bodySize + 0.4, bodySize + 1.3),
      ),
    },
  };
}

export async function saveProfile(profile, profilePath = appConfig.paths.defaultProfilePath) {
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8");
  return profilePath;
}

export async function loadProfile(profilePath = appConfig.paths.defaultProfilePath) {
  const rawProfile = await fs.readFile(profilePath, "utf8");
  return JSON.parse(rawProfile);
}

async function dedupeSamplePaths(samplePaths) {
  const uniquePaths = [];
  const seenHashes = new Set();

  for (const samplePath of samplePaths) {
    const buffer = await fs.readFile(samplePath);
    const hash = crypto.createHash("sha1").update(buffer).digest("hex");

    if (seenHashes.has(hash)) {
      continue;
    }

    seenHashes.add(hash);
    uniquePaths.push(samplePath);
  }

  return uniquePaths;
}

export async function buildProfileFromSampleFiles(samplePaths) {
  const uniqueSamplePaths = await dedupeSamplePaths(samplePaths);
  const documents = [];

  for (const samplePath of uniqueSamplePaths) {
    documents.push(await extractPdfDocument(samplePath, { includeImages: false }));
  }

  return analyzeDocuments(documents);
}

export async function rebuildDefaultProfile() {
  const samplePaths = await listPdfFiles(appConfig.paths.styleSamplesDir);

  if (!samplePaths.length) {
    const profile = createDefaultProfile(0);
    await saveProfile(profile);
    return {
      profile,
      samplePaths: [],
    };
  }

  const profile = await buildProfileFromSampleFiles(samplePaths);
  await saveProfile(profile);
  return {
    profile,
    samplePaths,
  };
}
