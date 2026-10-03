import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

export type CachedCarImage = {
  bytes: Uint8Array;
  cacheKey: string;
  filePath: string;
  fromCache: boolean;
};

type RouterImageResponse = {
  imageBase64?: unknown;
  mimeType?: unknown;
};

/**
 * Part of the cache key: bump it when the prompt changes so images generated with an older prompt
 * (e.g. with a gray studio background) are not reused. Old cache files are left untouched.
 */
export const CAR_IMAGE_CACHE_VERSION = "white-bg-v2";

export class CarImageGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CarImageGenerationError";
  }
}

function safeSlug(value: string): string {
  const transliterated = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return transliterated || "car";
}

export class DriveSetCarImageService {
  private readonly inFlight = new Map<string, Promise<CachedCarImage>>();

  constructor(
    private readonly options: {
      routerUrl: string;
      routerToken: string;
      cacheDir?: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  cacheKey(makeModel: string, year: number): string {
    const normalized = `${CAR_IMAGE_CACHE_VERSION}|${makeModel.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ")}|${year}`;
    const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    return `${safeSlug(makeModel)}-${year}-${hash}`;
  }

  async getOrGenerate(makeModel: string, year: number): Promise<CachedCarImage> {
    const cacheKey = this.cacheKey(makeModel, year);
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const task = this.getOrGenerateUnlocked(makeModel, year, cacheKey).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, task);
    return task;
  }

  private async getOrGenerateUnlocked(
    makeModel: string,
    year: number,
    cacheKey: string,
  ): Promise<CachedCarImage> {
    const cacheDir = this.options.cacheDir ?? path.join(process.cwd(), "data", "driveset", "cars");
    const filePath = path.join(cacheDir, `${cacheKey}.png`);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 100) {
      return { bytes: fs.readFileSync(filePath), cacheKey, filePath, fromCache: true };
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.options.routerUrl.replace(/\/$/, "")}/v1/images/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.routerToken}`,
        },
        body: JSON.stringify({
          prompt: [
            `Photorealistic exact vehicle: ${makeModel}, model year ${year}, factory appearance.`,
            "Front three-quarter view, entire vehicle visible.",
            "Isolated vehicle on a pure white background (#FFFFFF).",
            "No gray background, no studio background, no floor, no scenery, no text, no license plate, no people, no watermark, no logo.",
          ].join(" "),
          size: "1536x1024",
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CarImageGenerationError("Router недоступен", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new CarImageGenerationError(
        `Router вернул HTTP ${response.status}${details ? `: ${details.slice(0, 200)}` : ""}`,
      );
    }

    const payload = await response.json().catch(() => null) as RouterImageResponse | null;
    if (!payload || typeof payload.imageBase64 !== "string" || !payload.imageBase64) {
      throw new CarImageGenerationError("Router не вернул изображение");
    }

    let normalized: Buffer;
    try {
      const source = Buffer.from(payload.imageBase64, "base64");
      normalized = await sharp(source).rotate().png().toBuffer();
    } catch (error) {
      throw new CarImageGenerationError("Router вернул повреждённое изображение", { cause: error });
    }

    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, normalized);
    fs.renameSync(temporaryPath, filePath);
    return { bytes: normalized, cacheKey, filePath, fromCache: false };
  }
}

export async function transparentCarImage(): Promise<Uint8Array> {
  return sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  }).png().toBuffer();
}
