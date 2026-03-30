import fs from "node:fs/promises";

import { appConfig } from "../config.js";
import {
  copyIfMissing,
  ensureDirectories,
  listPdfFiles,
} from "./file-store.js";
import { rebuildDefaultProfile } from "./style-profile-service.js";

export async function seedReferenceSamples() {
  const copied = [];

  for (const candidate of appConfig.referenceSampleCandidates) {
    try {
      await fs.access(candidate);
      copied.push(await copyIfMissing(candidate, appConfig.paths.styleSamplesDir));
    } catch {
      continue;
    }
  }

  return copied;
}

export async function ensureAppReady() {
  await ensureDirectories();
  await seedReferenceSamples();

  try {
    await fs.access(appConfig.paths.defaultProfilePath);
  } catch {
    await rebuildDefaultProfile();
    return;
  }

  const sampleFiles = await listPdfFiles(appConfig.paths.styleSamplesDir);
  if (sampleFiles.length) {
    const profileStat = await fs.stat(appConfig.paths.defaultProfilePath);
    const newestSampleMtime = Math.max(
      ...(await Promise.all(sampleFiles.map((filePath) => fs.stat(filePath)))).map(
        (stat) => stat.mtimeMs,
      ),
    );

    if (newestSampleMtime > profileStat.mtimeMs) {
      await rebuildDefaultProfile();
    }
  }
}
