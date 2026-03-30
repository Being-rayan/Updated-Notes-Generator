import { appConfig } from "../config.js";

const IMAGE_OCR_BATCH_SIZE = 4;
const OCR_CONTENT_TYPES = new Set([
  "text_screenshot",
  "equation_screenshot",
  "mixed",
  "diagram",
  "unknown",
]);

function buildStructurePrompt({ rawText, profile, fallbackTitle, customInstructions }) {
  return `
You are preparing study notes for a compact A4 double-column PDF.

Target layout:
- Font family: Times New Roman
- Body font size: ${profile.typography.bodySize}
- Compact headings, short paragraphs, crisp bullets
- Use **bold** only for important short phrases or terms
- Preserve the original facts exactly. Do not invent content.
- Keep the output suitable for exam notes, not essay prose.

Return strict JSON with this shape:
{
  "title": "string",
  "blocks": [
    { "type": "heading|subheading|paragraph|bullet", "text": "string" }
  ]
}

Rules:
- Use "heading" for major section titles.
- Use "subheading" for smaller labelled sections.
- Use "bullet" for concise point-wise content.
- Use "paragraph" for normal prose.
- Preserve original section numbering exactly when present, for example "1.2", "1.2.3", "Case-1".
- Prefer more short blocks over fewer long blocks.
- Never merge a heading or subheading into a paragraph or bullet.
- Treat labels like "Case-1", "Case-2", "Problem-1", "Example", "Sample Problem", "Calculation" as headings or subheadings.
- If a line already looks like a numbered section heading, keep it as a heading/subheading instead of prose.
- If a line starts with an arrow, bullet marker, or enumerator, prefer a "bullet" block.
- Keep equations, timing expressions, and line-by-line calculations as separate bullet blocks when possible.
- If one logical point spans multiple sentences, split it into multiple bullets or short paragraphs instead of one long block.
- Keep paragraphs reasonably short for narrow columns.
- Keep each paragraph to at most 2 short sentences when possible.
- Keep each bullet focused on one idea unless it is a multi-line derivation.
- If a line is a definition, formula, rule, or keyword, it can use **bold** around the key phrase.
- Do not wrap the JSON in markdown fences.

Preferred title: ${fallbackTitle}
Additional instructions: ${customInstructions || "none"}

Raw extracted notes text:
${rawText}
`.trim();
}

function buildImageOcrPrompt({ customInstructions, imageIds }) {
  return `
You are transcribing study-note screenshots and scanned note images.

Return strict JSON with this shape:
{
  "images": [
    {
      "id": "string",
      "useAsText": true,
      "keepImage": false,
      "contentType": "text_screenshot|equation_screenshot|mixed|diagram|unknown",
      "transcription": "string"
    }
  ]
}

Rules:
- Include every image id exactly once: ${imageIds.join(", ")}.
- If an image is mainly text, formulas, derivations, code, or tabular note content, set "useAsText" to true.
- If an image should still be preserved visually because it is a diagram, circuit, graph, figure, or mixed visual content, set "keepImage" to true.
- It is allowed for both "useAsText" and "keepImage" to be true when the image contains both readable notes and important visuals.
- If an image has no useful readable note content, set "transcription" to an empty string and "useAsText" to false.
- Preserve equations in readable linear notation using plain text, for example: I_D = k*(V_GS - V_T)^2, x^2, V_out, sqrt(x), (a+b)/c.
- Preserve step-by-step derivations with line breaks.
- Do not summarize. Do not invent missing text. Only correct obvious OCR mistakes when the content is clearly legible.
- Do not wrap the JSON in markdown fences.

Additional instructions: ${customInstructions || "none"}
`.trim();
}

function extractJsonText(responseBody) {
  const text = responseBody?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini response did not include text");
  }

  return text;
}

async function requestGeminiJson({ apiKey, parts, temperature = 0.2 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${appConfig.geminiModel}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
      },
      contents: [
        {
          parts,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const responseBody = await response.json();
  const jsonText = extractJsonText(responseBody)
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(jsonText);
}

function sanitizeOcrTranscription(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeImageOcrEntry(entry, expectedId) {
  const transcription = sanitizeOcrTranscription(entry?.transcription);
  const contentType = OCR_CONTENT_TYPES.has(entry?.contentType)
    ? entry.contentType
    : "unknown";

  return {
    id: expectedId,
    useAsText: Boolean(entry?.useAsText && transcription),
    keepImage: entry?.keepImage !== false,
    contentType,
    transcription,
  };
}

function sanitizeImageOcrResponse(result, expectedIds) {
  const entries = Array.isArray(result?.images)
    ? result.images
    : Array.isArray(result)
      ? result
      : [];
  const byId = new Map(
    entries
      .filter((entry) => entry?.id)
      .map((entry) => [String(entry.id), entry]),
  );

  return expectedIds.map((imageId) =>
    sanitizeImageOcrEntry(byId.get(imageId), imageId),
  );
}

function chunkImages(images, size) {
  const chunks = [];

  for (let index = 0; index < images.length; index += size) {
    chunks.push(images.slice(index, index + size));
  }

  return chunks;
}

export async function structureWithGemini({
  rawText,
  profile,
  fallbackTitle,
  apiKey,
  customInstructions,
}) {
  return requestGeminiJson({
    apiKey,
    temperature: 0.2,
    parts: [
      {
        text: buildStructurePrompt({
          rawText,
          profile,
          fallbackTitle,
          customInstructions,
        }),
      },
    ],
  });
}

export async function extractImageTextWithGemini({
  images,
  apiKey,
  customInstructions,
}) {
  const validImages = (images || []).filter(
    (image) => image?.buffer?.length && image.id,
  );
  if (!validImages.length) {
    return [];
  }

  const results = [];
  const batches = chunkImages(validImages, IMAGE_OCR_BATCH_SIZE);

  for (const batch of batches) {
    const expectedIds = batch.map((image) => image.id);
    const parts = [
      {
        text: buildImageOcrPrompt({
          customInstructions,
          imageIds: expectedIds,
        }),
      },
      ...batch.flatMap((image) => [
        {
          text: `Image id: ${image.id}`,
        },
        {
          inlineData: {
            mimeType: image.mimeType || "image/png",
            data: image.buffer.toString("base64"),
          },
        },
      ]),
    ];

    const result = await requestGeminiJson({
      apiKey,
      temperature: 0.1,
      parts,
    });

    results.push(...sanitizeImageOcrResponse(result, expectedIds));
  }

  return results;
}
