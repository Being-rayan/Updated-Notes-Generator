import "dotenv/config";
import express from "express";

import { createApiRouter } from "./app/routes/api.js";
import { appConfig } from "./app/config.js";
import { ensureAppReady } from "./app/services/bootstrap-service.js";

async function startServer() {
  await ensureAppReady();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.static(appConfig.paths.staticDir));
  app.use("/exports", express.static(appConfig.paths.exportsDir));
  app.use("/api", createApiRouter());
  app.use((error, request, response, next) => {
    console.error("Unhandled server error");
    console.error(error);

    if (request.path?.startsWith("/api")) {
      response.status(error.status || 500).json({
        ok: false,
        error: error.message || "Internal server error",
      });
      return;
    }

    next(error);
  });

  app.listen(appConfig.port, () => {
    console.log(
      `note-formatter-ai listening on http://localhost:${appConfig.port}`,
    );
  });
}

startServer().catch((error) => {
  console.error("Failed to start note-formatter-ai");
  console.error(error);
  process.exitCode = 1;
});
