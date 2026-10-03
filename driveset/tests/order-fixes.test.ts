import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
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
  assert.ok(text.includes("+7 901 344-77-33"));
  assert.ok(!text.includes("985 125-75-85"), "старый телефон не печатается");
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
  assert.equal(DRIVESET_ORDER_COORDINATES.carImage.x, 283);
  assert.equal(DRIVESET_ORDER_COORDINATES.carImage.width, 282);
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

test("автомобиль крупнее на 15–20%, пропорции сохранены, ничего не перекрывает", async () => {
  const box = DRIVESET_ORDER_COORDINATES.carImage;
  const OLD_HEIGHT = 116;
  const growth = box.height / OLD_HEIGHT - 1;
  assert.ok(growth >= 0.15 && growth <= 0.2, `рост ${(growth * 100).toFixed(1)}%`);
  // Для типичного кадра 3:2 вписывание идёт по высоте, значит и размер растёт на тот же процент без деформации.
  const scale = Math.min(box.width / 1536, box.height / 1024);
  assert.ok(Math.abs((1536 * scale) / (1024 * scale) - 1.5) < 1e-9, "пропорции 3:2 сохраняются");
  assert.ok(1536 * scale <= box.width, "по ширине вписывается в бокс");
  // Низ бокса выше блока «ДАННЫЕ АВТОМОБИЛЯ» / полей (метки до y≈548), верх ниже строк контактов шапки (≈735).
  assert.ok(box.y >= 560, `низ бокса ${box.y}`);
  assert.ok(box.y + box.height <= 725, `верх бокса ${box.y + box.height}`);
  // Слева заголовок «ЗАКАЗ-НАРЯД» заканчивается на x≈250.6, справа поля страницы — на x=565.
  assert.ok(box.x > 251 && box.x + box.width <= 565);
});

test("марка/модель и год — bold (DejaVu Sans Bold), пробег — regular", { skip: !HAS_PDFTOTEXT }, async () => {
  const car = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#fff" } }).png().toBuffer();
  const bytes = await generateDriveSetOrderPdf({
    orderNumber: "114", date: new Date("2026-10-03T12:00:00Z"), makeModel: "Geely Monjaro", year: 2022, mileage: "46 000 км",
    carImage: car, services: [{ name: "Работы", price: 1000 }], discountPercent: 0,
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "driveset-bold-")), "order.pdf");
  fs.writeFileSync(file, bytes);
  const bbox = execFileSync("pdftotext", ["-bbox", file, "-"], { encoding: "utf8" });
  const widthOf = (w: string) => {
    const m = bbox.match(new RegExp(`xMin="([\\d.]+)" yMin="[\\d.]+" xMax="([\\d.]+)" yMax="[\\d.]+">${w}</word>`));
    assert.ok(m, `слово ${w} не найдено`);
    return Number(m[2]) - Number(m[1]);
  };
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fs.readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"));
  const bold = await pdf.embedFont(fs.readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"));
  const size = DRIVESET_ORDER_COORDINATES.makeModel.size;
  for (const [word, font, other] of [["Geely", bold, regular], ["Monjaro", bold, regular], ["2022", bold, regular], ["км", regular, bold]] as const) {
    const measured = widthOf(word);
    assert.ok(Math.abs(measured - font.widthOfTextAtSize(word, size)) < 0.35, `${word}: ожидалась ширина ${font.widthOfTextAtSize(word, size).toFixed(2)}, получено ${measured.toFixed(2)}`);
    assert.ok(Math.abs(measured - other.widthOfTextAtSize(word, size)) > 0.4, `${word}: ширина не должна совпадать с другим начертанием`);
  }
});

async function renderSample(): Promise<string> {
  const car = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#fff" } }).png().toBuffer();
  const bytes = await generateDriveSetOrderPdf({
    orderNumber: "1122", date: new Date("2026-10-03T12:00:00Z"), makeModel: "Geely Monjaro", year: 2022, mileage: "46 000 км",
    carImage: car,
    services: [
      { name: "Оклейка", price: 120000 },
      { name: "Полировка", price: 10000 },
      { name: "Химчистка", gift: true },
      { name: "Крупная работа", price: 1250000 },
    ],
    discountPercent: 0,
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "driveset-align-")), "order.pdf");
  fs.writeFileSync(file, bytes);
  return file;
}

type Word = { text: string; xMin: number; yMin: number; xMax: number; yMax: number };
function wordsOf(file: string): Word[] {
  const bbox = execFileSync("pdftotext", ["-bbox", file, "-"], { encoding: "utf8" });
  return [...bbox.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(m => ({
    xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]), yMax: Number(m[4]), text: m[5],
  }));
}

test("номер заказ-наряда сдвинут вправо от «№» шаблона: нормальный промежуток, правый край поля не изменился", { skip: !HAS_PDFTOTEXT }, async () => {
  const words = wordsOf(await renderSample());
  const sign = words.find(w => w.text === "№" && w.yMin < 200)!; // «№» шаблона у заголовка
  const number = words.find(w => w.text === "1122")!;
  const gap = number.xMin - sign.xMax;
  assert.ok(gap >= 6 && gap <= 14, `промежуток между «№» и номером ${gap.toFixed(1)} pt`);
  const c = DRIVESET_ORDER_COORDINATES.orderNumber;
  assert.equal(c.x, 54, "было 48");
  assert.equal(c.x + c.width, 208, "правый край (конец линии поля) прежний");
  assert.equal(c.y, 645);
  assert.equal(c.size, 10);
});

test("номера услуг — по центру колонки «№», цены и «В подарок» — по правому краю колонки «СТОИМОСТЬ»", { skip: !HAS_PDFTOTEXT }, async () => {
  const words = wordsOf(await renderSample());
  const COLUMN_CENTER = (29 + 73) / 2; // колонка «№»: от x=29 до линии x=73
  for (const n of ["1", "2", "3", "4"]) {
    const w = words.find(x => x.text === n && x.xMin > 40 && x.xMax < 62 && x.yMin > 250)!;
    assert.ok(w, `номер ${n} найден`);
    assert.ok(Math.abs((w.xMin + w.xMax) / 2 - COLUMN_CENTER) < 0.7, `${n}: центр ${((w.xMin + w.xMax) / 2).toFixed(2)} вместо ${COLUMN_CENTER}`);
  }
  const header = words.find(w => w.text === "СТОИМОСТЬ")!;
  const rights = [
    ...words.filter(w => w.text === "₽" && w.xMin > 500 && w.yMin > 250 && w.yMin < 500).map(w => w.xMax),
    words.find(w => w.text === "подарок")!.xMax,
  ];
  assert.equal(rights.length, 4, "три цены и «В подарок»");
  for (const right of rights) assert.ok(Math.abs(right - header.xMax) < 0.8, `правый край ${right.toFixed(2)} ≠ заголовок ${header.xMax.toFixed(2)}`);
  assert.equal(DRIVESET_ORDER_COORDINATES.serviceCost.right, 551);
  assert.equal(DRIVESET_ORDER_COORDINATES.serviceNumber.center, 51);
});

test("иконка телефона: одна, золотая, тонкая, на оси иконок шапки и того же размера, что Telegram; Telegram не дублируется", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderSample();
  const prefix = file.replace(/\.pdf$/, "");
  execFileSync("pdftoppm", ["-r", "300", "-png", "-singlefile", file, prefix]);
  const { data, info } = await sharp(`${prefix}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = 300 / 72;
  const gold = (i: number) => data[i] > 170 && data[i + 1] > 100 && data[i + 1] < 170 && data[i + 2] < 90;
  const bounds = (yFromPt: number, yToPt: number) => {
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, count = 0;
    for (let y = Math.floor((841.8898 - yToPt) * k); y < Math.ceil((841.8898 - yFromPt) * k); y++)
      for (let x = Math.floor(340 * k); x < Math.ceil(362 * k); x++)
        if (gold((y * info.width + x) * 3)) { count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { count, cx: (x0 + x1) / 2 / k, w: (x1 - x0) / k, h: (y1 - y0) / k, cy: 841.8898 - (y0 + y1) / 2 / k };
  };
  const telegram = bounds(757, 775); // иконка из шаблона
  const phone = bounds(733, 751); // добавленная иконка
  assert.ok(telegram.count > 200 && phone.count > 200, "обе иконки золотые");
  assert.ok(Math.abs(phone.cx - telegram.cx) < 1, `ось x: телефон ${phone.cx.toFixed(2)}, Telegram ${telegram.cx.toFixed(2)}`);
  assert.ok(Math.abs(phone.w - telegram.w) < 1.5 && Math.abs(phone.h - telegram.h) < 1.5, `размер ${phone.w.toFixed(1)}×${phone.h.toFixed(1)} vs ${telegram.w.toFixed(1)}×${telegram.h.toFixed(1)}`);
  assert.equal(bounds(751.5, 756.5).count, 0, "между иконками нет второй Telegram-иконки");
  assert.ok(phone.count < telegram.count * 1.6, "линия тонкая, как у иконок шаблона");
  const text = pdfText(file);
  assert.ok(text.includes("+7 901 344-77-33") && !text.includes("☎"), "номер текстом, без юникод-символа телефона");
  const address = wordsOf(file).find(w => w.text === "Москва,")!;
  const phoneText = wordsOf(file).find(w => w.text === "+7")!;
  assert.equal(phoneText.xMin, address.xMin, "текст телефона начинается на том же x, что адрес");
});
