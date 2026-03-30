import fs from "node:fs/promises";
import path from "node:path";

import { appConfig } from "../config.js";
import { sanitizeFileSegment } from "./text-utils.js";

export async function ensureDirectories() {
  const directories = [
    appConfig.paths.uploadsDir,
    appConfig.paths.exportsDir,
    appConfig.paths.profilesDir,
    appConfig.paths.rawDir,
    appConfig.paths.styleSamplesDir,
  ];

  await Promise.all(
    directories.map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
}

export async function listPdfFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"),
    )
    .map((entry) => path.join(directory, entry.name));
}

export async function copyIfMissing(sourceFile, targetDirectory) {
  const fileName = path.basename(sourceFile);
  const targetFile = path.join(targetDirectory, fileName);

  try {
    await fs.access(targetFile);
    return targetFile;
  } catch {
    await fs.copyFile(sourceFile, targetFile);
    return targetFile;
  }
}

export async function moveUploadedFiles(files, targetDirectory) {
  const storedPaths = [];

  for (const file of files || []) {
    const extension = path.extname(file.originalname) || ".pdf";
    const baseName = sanitizeFileSegment(path.parse(file.originalname).name);
    const nextName = `${baseName || "sample"}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}${extension}`;
    const targetPath = path.join(targetDirectory, nextName);
    await fs.copyFile(file.path, targetPath);
    storedPaths.push(targetPath);
  }

  return storedPaths;
}

export async function persistStyleSampleUploads(files, targetDirectory) {
  const storedPaths = [];

  for (const file of files || []) {
    const extension = (path.extname(file.originalname) || ".pdf").toLowerCase();
    const baseName = sanitizeFileSegment(path.parse(file.originalname).name) || "sample";
    const stableName = `${baseName}${extension}`;
    const targetPath = path.join(targetDirectory, stableName);

    await fs.copyFile(file.path, targetPath);
    storedPaths.push(targetPath);
  }

  return storedPaths;
}

export async function removeFiles(paths) {
  await Promise.all(
    (paths || []).map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch {
        return undefined;
      }

      return undefined;
    }),
  );
}

export function createTimestampedPdfName(sourceName) {
  const baseName = sanitizeFileSegment(path.parse(sourceName).name) || "notes";
  return `${baseName}-formatted-${Date.now()}.pdf`;
}
