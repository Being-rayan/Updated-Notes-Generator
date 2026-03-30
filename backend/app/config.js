import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const appDir = path.dirname(currentFile);
const backendDir = path.resolve(appDir, "..");
const projectRoot = path.resolve(backendDir, "..");
const dataDir = path.join(backendDir, "data");

export const appConfig = {
  port: Number(process.env.PORT || 3000),
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  paths: {
    projectRoot,
    backendDir,
    dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    exportsDir: path.join(dataDir, "exports"),
    profilesDir: path.join(dataDir, "profiles"),
    rawDir: path.join(dataDir, "raw"),
    styleSamplesDir: path.join(dataDir, "style_samples"),
    staticDir: path.join(appDir, "static"),
    defaultProfilePath: path.join(dataDir, "profiles", "default.json"),
    fonts: {
      regular: "C:\\Windows\\Fonts\\times.ttf",
      bold: "C:\\Windows\\Fonts\\timesbd.ttf",
      italic: "C:\\Windows\\Fonts\\timesi.ttf",
      boldItalic: "C:\\Windows\\Fonts\\timesbi.ttf",
    },
  },
  referenceSampleCandidates: [
    "C:\\Users\\rayan\\Downloads\\DSA ! 0.pdf",
    "C:\\Users\\rayan\\Downloads\\System Design ! (2).pdf",
    "C:\\Users\\rayan\\Downloads\\VLSI ! (2).pdf",
    "C:\\Users\\rayan\\Downloads\\Software Engg ! (3).pdf",
  ],
  defaults: {
    page: {
      width: 595.28,
      height: 841.89,
    },
    layout: {
      columns: 2,
      marginTop: 26,
      marginBottom: 24,
      marginLeft: 24,
      marginRight: 24,
      columnGap: 18,
      bulletIndent: 12,
    },
    typography: {
      bodyFont: "Times New Roman",
      bodySize: 9,
      lineGap: 1.4,
      paragraphGap: 4,
      titleSize: 15,
      headingSize: 11.5,
      subheadingSize: 9.8,
      bulletGap: 2,
    },
    heuristics: {
      shortHeadingMaxWords: 10,
      paragraphBreakMultiplier: 1.65,
    },
  },
};
