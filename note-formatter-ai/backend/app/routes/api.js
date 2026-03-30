import express from "express";
import multer from "multer";
import path from "node:path";

import { appConfig } from "../config.js";
import {
  createTimestampedPdfName,
  listPdfFiles,
  persistStyleSampleUploads,
  removeFiles,
} from "../services/file-store.js";
import { extractSupportedDocument } from "../services/pdf-extractor.js";
import { renderStructuredPdf } from "../services/document-renderer.js";
import { ensureAppReady } from "../services/bootstrap-service.js";
import {
  buildProfileFromSampleFiles,
  loadProfile,
  rebuildDefaultProfile,
} from "../services/style-profile-service.js";
import { structureDocument } from "../services/structure-service.js";

const upload = multer({
  dest: appConfig.paths.uploadsDir,
  limits: {
    fileSize: 40 * 1024 * 1024,
  },
});

function runMiddleware(middleware, request, response) {
  return new Promise((resolve, reject) => {
    middleware(request, response, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export function createApiRouter() {
  const router = express.Router();

  router.get("/health", async (_request, response) => {
    await ensureAppReady();
    response.json({ ok: true });
  });

  router.get("/profile", async (_request, response) => {
    await ensureAppReady();
    const profile = await loadProfile();
    const samplePaths = await listPdfFiles(appConfig.paths.styleSamplesDir);
    response.json({
      profile,
      sampleFiles: samplePaths.map((samplePath) => path.basename(samplePath)),
    });
  });

  router.post("/profile/rebuild", async (request, response) => {
    try {
      await runMiddleware(upload.array("samplePdfs", 20), request, response);
      await ensureAppReady();

      if (request.files?.length) {
        await persistStyleSampleUploads(request.files, appConfig.paths.styleSamplesDir);
      }

      const { profile, samplePaths } = await rebuildDefaultProfile();
      await removeFiles(request.files?.map((file) => file.path));

      response.json({
        ok: true,
        profile,
        sampleFiles: samplePaths.map((samplePath) => path.basename(samplePath)),
      });
    } catch (error) {
      await removeFiles(request.files?.map((file) => file.path));
      console.error("Profile rebuild failed");
      console.error(error);
      response.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  router.post("/format", async (request, response) => {
    try {
      await runMiddleware(
        upload.fields([
          { name: "notesPdf", maxCount: 1 },
          { name: "samplePdfs", maxCount: 20 },
        ]),
        request,
        response,
      );

      const notesFile = request.files?.notesPdf?.[0];
      const sampleFiles = request.files?.samplePdfs || [];

      if (!notesFile) {
        response.status(400).json({
          ok: false,
          error: "notesPdf is required",
        });
        return;
      }

      await ensureAppReady();

      const profile = sampleFiles.length
        ? await buildProfileFromSampleFiles([
            ...(await listPdfFiles(appConfig.paths.styleSamplesDir)),
            ...sampleFiles.map((file) => file.path),
          ])
        : await loadProfile();
      const document = await extractSupportedDocument(notesFile);
      const structured = await structureDocument({
        document,
        profile,
        apiKey:
          request.body.geminiApiKey?.trim() || process.env.GEMINI_API_KEY || "",
        customInstructions: request.body.customInstructions?.trim() || "",
      });
      const outputName = createTimestampedPdfName(notesFile.originalname);
      const outputPath = path.join(appConfig.paths.exportsDir, outputName);
      await renderStructuredPdf({
        structure: structured,
        profile,
        outputPath,
      });

      await removeFiles([
        notesFile.path,
        ...sampleFiles.map((file) => file.path),
      ]);

      response.json({
        ok: true,
        usedGemini: structured.meta?.usedGemini || false,
        fallbackReason: structured.meta?.fallbackReason || null,
        usedImageOcr: structured.meta?.usedImageOcr || false,
        ocrImagesProcessed: structured.meta?.ocrImagesProcessed || 0,
        ocrTextImages: structured.meta?.ocrTextImages || 0,
        preservedImages: structured.meta?.preservedImages || 0,
        imageOcrWarning: structured.meta?.imageOcrWarning || null,
        blocks: structured.blocks.length,
        images: structured.meta?.imageCount || 0,
        outputName,
        downloadUrl: `/exports/${outputName}`,
        profileSummary: {
          bodySize: profile.typography.bodySize,
          columnGap: profile.layout.columnGap,
          marginLeft: profile.layout.marginLeft,
          marginRight: profile.layout.marginRight,
          sampleCount: profile.sourceSampleCount,
        },
      });
    } catch (error) {
      const notesFile = request.files?.notesPdf?.[0];
      const sampleFiles = request.files?.samplePdfs || [];
      await removeFiles([
        notesFile?.path,
        ...sampleFiles.map((file) => file.path),
      ]);

      console.error("Format request failed");
      console.error(error);
      response.status(error.status || 500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  return router;
}
