import "dotenv/config";
import path from "node:path";

import { appConfig } from "../app/config.js";
import { ensureAppReady } from "../app/services/bootstrap-service.js";
import { renderStructuredPdf } from "../app/services/document-renderer.js";
import { listPdfFiles } from "../app/services/file-store.js";
import { extractPdfDocument } from "../app/services/pdf-extractor.js";
import { loadProfile } from "../app/services/style-profile-service.js";
import { structureDocument } from "../app/services/structure-service.js";

await ensureAppReady();

const styleSamples = await listPdfFiles(appConfig.paths.styleSamplesDir);
if (!styleSamples.length) {
  throw new Error("No style samples were found for smoke testing");
}

const inputPath = styleSamples[0];
const profile = await loadProfile();
const document = await extractPdfDocument(inputPath);
const structured = await structureDocument({
  document,
  profile,
  apiKey: process.env.GEMINI_API_KEY || "",
  customInstructions: "",
});
const outputPath = path.join(
  appConfig.paths.exportsDir,
  `smoke-${Date.now()}.pdf`,
);

await renderStructuredPdf({
  structure: structured,
  profile,
  outputPath,
});

console.log(
  JSON.stringify(
    {
      inputPath,
      outputPath,
      pageCount: document.pageCount,
      blocks: structured.blocks.length,
      images: structured.meta?.imageCount || 0,
      usedGemini: structured.meta?.usedGemini || false,
    },
    null,
    2,
  ),
);
