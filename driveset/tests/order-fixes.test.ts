import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import { generateDriveSetOrderPdf, DRIVESET_ORDER_COORDINATES } from "../../services/driveset-order.js";
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
async function rasterize(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  const prefix = file.replace(/\.pdf$/, "");
  execFileSync("pdftoppm", ["-r", "110", "-png", "-singlefile", file, prefix]);
  const { data, info } = await sharp(`${prefix}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Доля «чернил» (не белых пикселей) в прямоугольнике, заданном в pt от левого нижнего угла страницы. */
function inkIn(raster: { data: Buffer; width: number; height: number }, box: { x: number; y: number; width: number; height: number }): number {
  const k = 110 / 72;
  const x0 = Math.floor(box.x * k), x1 = Math.ceil((box.x + box.width) * k);
  const y0 = Math.floor((841.8898 - box.y - box.height) * k), y1 = Math.ceil((841.8898 - box.y) * k);
  let ink = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * raster.width + x) * 3;
    total++;
    if (raster.data[i] < 200 || raster.data[i + 1] < 200 || raster.data[i + 2] < 200) ink++;
  }
  return ink / total;
}

const DISCOUNT_ROW = { y: 186, height: 16 };

test("PDF: введённый номер печатается как есть, телефон в шапке", { skip: !HAS_PDFTOTEXT }, async () => {
  const text = pdfText(await renderPdf({ number: "114", discount: 15 }));
  assert.match(text, /№\s+114\b/);
  assert.ok(!text.includes("DS-"), "автоматический номер не печатается");
  assert.ok(text.includes("Москва, улица Наташи Ковшовой, 4с2"));
  assert.ok(text.includes("+7 985 125-75-85"));
  assert.ok(text.includes("@driveset"));
  assert.ok(text.includes("301 750 ₽"));
});

test("PDF: скидка 15% — «Скидка 15%» в одной строке, «(%)» закрыто, сумма справа", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderPdf({ number: "114", discount: 15 });
  const text = pdfText(file);
  assert.ok(text.includes("15%"));
  assert.ok(text.includes("− 53 250 ₽"));
  const raster = await rasterize(file);
  // На месте шаблонного «(%)» (x 82–95) остаётся только новый «15%» — а не наложение двух надписей.
  const percent = DRIVESET_ORDER_COORDINATES.discountPercent;
  assert.ok(inkIn(raster, { x: percent.x, y: DISCOUNT_ROW.y, width: 24, height: DISCOUNT_ROW.height }) > 0.03, "«15%» напечатано рядом со словом «Скидка»");
  assert.ok(inkIn(raster, { x: 106, y: DISCOUNT_ROW.y, width: 110, height: DISCOUNT_ROW.height }) < 0.005, "после процента строка пуста");
  assert.ok(inkIn(raster, { x: 480, y: DISCOUNT_ROW.y, width: 70, height: DISCOUNT_ROW.height }) > 0.03, "сумма скидки справа");
});

test("PDF: скидка 0% — «Скидка 0%» и «0 ₽» без минуса", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderPdf({ number: "114", discount: 0 });
  const text = pdfText(file);
  assert.ok(!text.includes("−"), "−0 ₽ не выводится");
  assert.match(text, /(^|\s)0\s*₽/m, "выводится 0 ₽");
  const raster = await rasterize(file);
  const percent = DRIVESET_ORDER_COORDINATES.discountPercent;
  assert.ok(inkIn(raster, { x: percent.x, y: DISCOUNT_ROW.y, width: 16, height: DISCOUNT_ROW.height }) > 0.03, "«0%» напечатано");
  assert.ok(inkIn(raster, { x: 106, y: DISCOUNT_ROW.y, width: 110, height: DISCOUNT_ROW.height }) < 0.005, "после процента строка пуста");
});

test("шаблонное «(%)» целиком закрыто белым прямоугольником под новым процентом", { skip: !HAS_PDFTOTEXT }, () => {
  const bbox = execFileSync("pdftotext", ["-bbox", path.join(process.cwd(), "templates", "driveset-order.pdf"), "-"], { encoding: "utf8" });
  const m = bbox.match(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">\(%\)<\/word>/);
  assert.ok(m, "в шаблоне есть «(%)»");
  const [xMin, yMin, xMax, yMax] = m.slice(1).map(Number);
  const cover = DRIVESET_ORDER_COORDINATES.discountPercentCover;
  const PAGE_HEIGHT = 841.8898;
  assert.ok(cover.x <= xMin && cover.x + cover.width >= xMax, "по горизонтали");
  assert.ok(cover.y <= PAGE_HEIGHT - yMax && cover.y + cover.height >= PAGE_HEIGHT - yMin, "по вертикали");
  assert.ok(cover.x >= 80.7, "«Скидка» (до x=80.6) не закрывается");
});

test("PDF: марка, год и пробег стоят выше линий полей (подписи и линии не двигались)", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderPdf({ number: "114", discount: 0 });
  const bbox = execFileSync("pdftotext", ["-bbox", file, "-"], { encoding: "utf8" });
  const word = (w: string) => {
    const m = bbox.match(new RegExp(`yMin="([\\d.]+)" xMax="[\\d.]+" yMax="([\\d.]+)">${w}</word>`));
    assert.ok(m, `слово ${w} не найдено`);
    return { yMin: Number(m[1]), yMax: Number(m[2]) };
  };
  const PAGE_HEIGHT = 841.8898;
  const lineTop = PAGE_HEIGHT - 520.5; // линия поля Марка/Год/Пробег в координатах «сверху»
  for (const w of ["Audi", "2019", "200000"]) {
    const { yMax } = word(w);
    assert.ok(lineTop - yMax >= 2, `${w}: нижняя часть текста должна быть выше линии минимум на 2 pt (отступ ${(lineTop - yMax).toFixed(1)})`);
  }
  const label = word("Марка");
  assert.ok(word("Audi").yMin > label.yMax, "значение не налезает на подпись поля");
  assert.equal(DRIVESET_ORDER_COORDINATES.carImage.width, 282);
  assert.equal(DRIVESET_ORDER_COORDINATES.carImage.height, 116, "область автомобиля не менялась");
});

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
