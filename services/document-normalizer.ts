import path from "node:path";

import convert from "heic-convert";
import sharp from "sharp";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".heic": "image/heic", ".heif": "image/heif", ".pdf": "application/pdf",
};
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", ...HEIC_MIME_TYPES]);

export interface NormalizedDocument { buffer: Buffer; filename: string; mimeType: string }

function mimeFromMagicBytes(buffer: Buffer): string {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = buffer.subarray(8, 32).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx"].some((brand) => brands.includes(brand))) return "image/heic";
    if (["heif", "heim", "heis", "mif1", "msf1"].some((brand) => brands.includes(brand))) return "image/heif";
  }
  return "";
}

function detectMimeType(buffer: Buffer, filename: string, declaredMimeType: string): string {
  return mimeFromMagicBytes(buffer) || MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] || declaredMimeType.split(";", 1)[0].trim().toLowerCase();
}

function safeFilename(filename: string, mimeType: string): string {
  const clean = path.basename(filename || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (clean) return clean;
  if (mimeType === "application/pdf") return "document.pdf";
  if (mimeType === "image/png") return "document.png";
  if (mimeType === "image/webp") return "document.webp";
  if (HEIC_MIME_TYPES.has(mimeType)) return mimeType.includes("heif") ? "document.heif" : "document.heic";
  return "document.jpg";
}

export async function normalizeDocument(buffer: Buffer, filename: string, mimeType: string): Promise<NormalizedDocument> {
  if (!buffer.length) throw new Error("Файл пуст.");
  const detectedMimeType = detectMimeType(buffer, filename, mimeType);
  if (!ALLOWED_MIME_TYPES.has(detectedMimeType)) throw new Error("Поддерживаются JPG, PNG, WEBP, HEIC, HEIF и PDF.");

  const detectedFilename = safeFilename(filename, detectedMimeType);
  if (detectedMimeType === "application/pdf") return { buffer, filename: detectedFilename, mimeType: "application/pdf" };

  let imageBuffer = buffer;
  if (HEIC_MIME_TYPES.has(detectedMimeType)) {
    try { imageBuffer = Buffer.from(await convert({ buffer: imageBuffer, format: "JPEG", quality: 0.9 })); }
    catch { throw new Error("Не удалось прочитать HEIC/HEIF. Попробуйте другое фото или PDF."); }
  }

  try {
    const normalizedBuffer = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 83 })
      .toBuffer();
    return { buffer: normalizedBuffer, filename: `${path.parse(detectedFilename).name || "document"}.jpg`, mimeType: "image/jpeg" };
  } catch {
    throw new Error("Не удалось обработать изображение. Попробуйте другое фото или PDF.");
  }
}
