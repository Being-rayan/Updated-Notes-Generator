import zlib from "node:zlib";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function createChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(calculateCrc32(typeBuffer, data), 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function calculateCrc32(...parts) {
  let crc = 0xffffffff;

  for (const part of parts) {
    for (const byte of part) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function toRgbaBuffer(image) {
  const data = Buffer.from(image.data);

  if (image.kind === pdfjs.ImageKind.RGBA_32BPP) {
    return data;
  }

  if (image.kind === pdfjs.ImageKind.RGB_24BPP) {
    const rgba = Buffer.alloc(image.width * image.height * 4);

    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < data.length; sourceIndex += 3) {
      rgba[targetIndex] = data[sourceIndex];
      rgba[targetIndex + 1] = data[sourceIndex + 1];
      rgba[targetIndex + 2] = data[sourceIndex + 2];
      rgba[targetIndex + 3] = 0xff;
      targetIndex += 4;
    }

    return rgba;
  }

  if (image.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = Math.ceil(image.width / 8);
    const rgba = Buffer.alloc(image.width * image.height * 4);

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const byte = data[y * rowBytes + Math.floor(x / 8)];
        const bit = (byte >> (7 - (x % 8))) & 1;
        const value = bit ? 0xff : 0x00;
        const targetIndex = (y * image.width + x) * 4;
        rgba[targetIndex] = value;
        rgba[targetIndex + 1] = value;
        rgba[targetIndex + 2] = value;
        rgba[targetIndex + 3] = 0xff;
      }
    }

    return rgba;
  }

  throw new Error(`Unsupported PDF image kind: ${image.kind}`);
}

export function pdfImageToPngBuffer(image) {
  if (!image?.width || !image?.height || !image?.data) {
    throw new Error("Incomplete PDF image data");
  }

  const rgba = toRgbaBuffer(image);
  const rowLength = image.width * 4;
  const raw = Buffer.alloc((rowLength + 1) * image.height);

  for (let row = 0; row < image.height; row += 1) {
    const rawRowStart = row * (rowLength + 1);
    const imageRowStart = row * rowLength;
    raw[rawRowStart] = 0;
    rgba.copy(raw, rawRowStart + 1, imageRowStart, imageRowStart + rowLength);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    createChunk("IHDR", header),
    createChunk("IDAT", zlib.deflateSync(raw)),
    createChunk("IEND"),
  ]);
}

export function normalizeImageMimeType(mimeType, fileName = "") {
  const normalized = String(mimeType || "").toLowerCase().trim();
  if (normalized === "image/png") {
    return "image/png";
  }

  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "image/jpeg";
  }

  const extension = String(fileName || "").toLowerCase().split(".").pop();
  if (extension === "png") {
    return "image/png";
  }

  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }

  return "";
}

function readPngDimensions(buffer) {
  if (buffer.length < 24 || buffer.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    throw new Error("Invalid PNG image");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("Invalid JPEG image");
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) {
      offset += 1;
    }

    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= buffer.length) {
      break;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    if (offset + 2 > buffer.length) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  throw new Error("JPEG dimensions could not be determined");
}

export function getImageDimensions(buffer, mimeType) {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  if (!normalizedMimeType) {
    throw new Error("Unsupported image type");
  }

  if (normalizedMimeType === "image/png") {
    return readPngDimensions(buffer);
  }

  if (normalizedMimeType === "image/jpeg") {
    return readJpegDimensions(buffer);
  }

  throw new Error("Unsupported image type");
}
