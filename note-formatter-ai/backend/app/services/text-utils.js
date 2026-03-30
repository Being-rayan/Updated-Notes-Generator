import path from "node:path";

export function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function filenameToTitle(filePath) {
  const baseName = path.parse(filePath).name;
  return baseName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeFileSegment(value) {
  return String(value || "")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function toSentenceCase(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) {
    return "";
  }

  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function stripMarkdownBold(text) {
  return String(text || "").replace(/\*\*(.*?)\*\*/g, "$1");
}

export function parseBoldSegments(text) {
  const source = String(text || "");
  const parts = source.split(/(\*\*.*?\*\*)/g).filter(Boolean);

  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return {
        bold: true,
        text: part.slice(2, -2),
      };
    }

    return {
      bold: false,
      text: part,
    };
  });
}
