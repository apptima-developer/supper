import { HttpError } from "./request-security";
import { getRequestLimits } from "./env";

const spreadsheetMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function ticketMutationBodyLimit() {
  const limits = getRequestLimits();
  const maximumEncodedImages = Math.ceil(limits.maxInlineImageBytes * 4 / 3) * 4;
  return limits.maxJsonBodyBytes + maximumEncodedImages;
}

function hasXlsxSignature(buffer: Uint8Array) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (
    (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

export function validateSpreadsheetUpload({
  fileName,
  contentType,
  buffer,
  maxBytes,
}: {
  fileName: string;
  contentType: string;
  buffer: Uint8Array;
  maxBytes: number;
}) {
  if (buffer.byteLength > maxBytes) throw new HttpError(413, "FILE_TOO_LARGE", "Spreadsheet exceeds the configured upload limit");
  if (!fileName.toLowerCase().endsWith(".xlsx")) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Only .xlsx workbooks are supported");
  }
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!spreadsheetMimeTypes.has(normalizedType)) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Unsupported spreadsheet MIME type");
  }
  if (!hasXlsxSignature(buffer)) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "File content is not a valid .xlsx container");
  }
}

function hasImageSignature(contentType: string, bytes: Uint8Array) {
  if (contentType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/gif") return bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (contentType === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

export function validateInlineImageDataUrl(dataUrl: string, maxBytes: number) {
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || match[2].length % 4 !== 0) {
    throw new HttpError(415, "INVALID_IMAGE_DATA", "Image must be a valid Base64 data URL");
  }
  const contentType = match[1].toLowerCase();
  if (!imageMimeTypes.has(contentType)) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE_TYPE", "Only PNG, JPEG, GIF, and WebP images are supported");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength > maxBytes) throw new HttpError(413, "IMAGE_TOO_LARGE", "Inline image exceeds the configured size limit");
  if (!hasImageSignature(contentType, bytes)) {
    throw new HttpError(415, "INVALID_IMAGE_DATA", "Image content does not match its MIME type");
  }
  return { contentType, byteLength: bytes.byteLength };
}
