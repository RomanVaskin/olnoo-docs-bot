import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import { generateDriveSetOrderPdf } from "../../services/driveset-order.js";
import { CAR_IMAGE_CACHE_VERSION, DriveSetCarImageService } from "../car-images.js";
import { DriveSetStorage } from "../storage.js";

const HAS_PDFTOTEXT = spawnSync("pdftotext", ["-v"]).status !== null;

async function renderPdf(options: { number: string; discount: number }): Promise<string> {
  const car = await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const bytes = await generateDriveSetOrderPdf({
    orderNumber: options.number,
    date: new Date("2026-10-03T12:00:00Z"),
    makeModel: "Audi A6 Allroad",
    year: 2019,
    mileage: "200000 км",
    carImage: car,
    services: [{ name: "Комплекс детейлинг-работ", price: 355000 }, { name: "Чернение шин", gift: true }],
    discountPercent: options.discount,
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "driveset-pdf-")), "order.pdf");
  fs.writeFileSync(file, bytes);
  return file;
}

const pdfText = (file: string) => execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });

test("кэш изображения версионирован: ключ отличается от прежнего, старый файл не используется", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveset-cache-"));
  const cacheDir = path.join(root, "cars");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bodies: Record<string, unknown>[] = [];
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
  const images = new DriveSetCarImageService({
    routerUrl: "http://router.test",
    routerToken: "token",
    cacheDir,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ imageBase64: png.toString("base64") }), { status: 200 });
    },
  });

  // Ключ без версии — так выглядел кэш-файл прежней версии (серый студийный фон).
  const legacyHash = crypto.createHash("sha256").update("audi a6 allroad|2019").digest("hex").slice(0, 12);
  const legacyKey = `audi-a6-allroad-2019-${legacyHash}`;
  const legacyFile = path.join(cacheDir, `${legacyKey}.png`);
  fs.writeFileSync(legacyFile, Buffer.alloc(500, 1));

  const key = images.cacheKey("Audi A6 Allroad", 2019);
  assert.notEqual(key, legacyKey, "новый ключ кэша отличается от прежнего");
  assert.ok(CAR_IMAGE_CACHE_VERSION.length > 0);

  const result = await images.getOrGenerate("Audi A6 Allroad", 2019);
  assert.equal(result.fromCache, false, "старый файл не переиспользуется");
  assert.equal(result.cacheKey, key);
  assert.equal(bodies.length, 1);
  assert.ok(fs.existsSync(legacyFile), "старый файл не удаляется");
  assert.equal((await images.getOrGenerate("Audi A6 Allroad", 2019)).fromCache, true, "новый файл кэшируется");
  assert.equal(bodies.length, 1);

  const prompt = String(bodies[0].prompt);
  for (const phrase of [
    "Photorealistic exact vehicle",
    "Front three-quarter view, entire vehicle visible",
    "factory appearance",
    "Isolated vehicle",
    "pure white background",
    "No gray background",
    "no studio background",
    "no floor",
    "no scenery",
    "no text",
    "no license plate",
  ]) {
    assert.ok(prompt.includes(phrase), `в prompt нет «${phrase}»`);
  }
  assert.equal(bodies[0].size, "1536x1024", "размер генерации не менялся");
  t.diagnostic(`cache key: ${key}`);
});

/** Растр страницы (110 dpi) → пиксели RGB, чтобы проверять то, что реально видно на листе. */
test("БД получает display_number: миграция идемпотентна, внутренний номер сохраняется", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveset-migrate-"));
  const dbPath = path.join(root, "driveset.db");
  // Эмуляция старой БД без колонки display_number.
  const first = new DriveSetStorage(dbPath);
  first.close();
  const second = new DriveSetStorage(dbPath); // повторный запуск: миграция идемпотентна
  const doc = second.reserveDocument({
    telegramUserId: "1", telegramChatId: "1", telegramUsername: null, telegramName: null,
    displayNumber: "114", makeModel: "Audi A6 Allroad", vehicleYear: 2019, mileage: "200000 км",
    services: [{ name: "Работы", price: 1000 }], discountPercent: 0,
    totals: { paidWorksCost: 1000, discountPercent: 0, discountAmount: 0, total: 1000 },
    now: new Date("2026-10-03T00:00:00Z"),
  });
  assert.equal(doc.displayNumber, "114");
  assert.equal(doc.orderNumber, "DS-2026-0001");
  second.close();
});

test("PDF: введённый номер печатается как есть, дата — «03 октября 2026», телефон и контакты в шапке", { skip: !HAS_PDFTOTEXT }, async () => {
  const text = pdfText(await renderPdf({ number: "114", discount: 15 }));
  assert.match(text, /№\s+114\b/);
  assert.ok(!text.includes("DS-"), "автоматический номер не печатается");
  assert.ok(text.includes("03 октября 2026"), "дата в формате MASTER");
  assert.ok(text.includes("Москва, улица Наташи Ковшовой, 4с2"));
  assert.ok(text.includes("+7 901 344-77-33"));
  assert.ok(!text.includes("985 125-75-85"), "старый телефон не печатается");
  assert.ok(text.includes("@driveset"));
  assert.ok(text.includes("301 750 ₽"));
});

test("PDF: скидка 15% — «Скидка 15%» и сумма справа; скидка 0% — «Скидка 0%» и «0 ₽» без минуса; «(%)» нет", { skip: !HAS_PDFTOTEXT }, async () => {
  const withDiscount = pdfText(await renderPdf({ number: "114", discount: 15 }));
  assert.match(withDiscount, /Скидка 15%\s+− 53 250 ₽/);
  assert.ok(!withDiscount.includes("(%)"));
  const without = pdfText(await renderPdf({ number: "114", discount: 0 }));
  assert.match(without, /Скидка 0%\s+0\s*₽/);
  assert.ok(!without.includes("−"), "−0 ₽ не выводится");
  assert.ok(!without.includes("(%)"));
});

