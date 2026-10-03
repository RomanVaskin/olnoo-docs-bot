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

test("PDF: скидка 15% — «Скидка 15%» в одной строке, сумма справа, без «(%)»", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderPdf({ number: "114", discount: 15 });
  const text = pdfText(file);
  assert.ok(text.includes("− 53 250 ₽"));
  assert.ok(!text.includes("(%)"), "«(%)» нет ни в шаблоне, ни в динамике");
  const words = wordsOf(file);
  const label = words.find(w => w.text === "Скидка")!;
  const percent = words.find(w => w.text === "15%")!;
  assert.ok(Math.abs(percent.yMin - label.yMin) < 1.5 && Math.abs(percent.yMax - label.yMax) < 1.5, "в одной строке со словом «Скидка»");
  const gap = percent.xMin - label.xMax;
  assert.ok(gap >= 2 && gap <= 8, `промежуток «Скидка» → процент ${gap.toFixed(1)} pt`);
  const raster = await rasterize(file);
  assert.ok(inkIn(raster, { x: 480, y: DISCOUNT_ROW.y, width: 70, height: DISCOUNT_ROW.height }) > 0.03, "сумма скидки справа");
});

test("PDF: скидка 0% — «Скидка 0%» и «0 ₽» без минуса", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderPdf({ number: "114", discount: 0 });
  const text = pdfText(file);
  assert.ok(!text.includes("−"), "−0 ₽ не выводится");
  assert.match(text, /(^|\s)0\s*₽/m, "выводится 0 ₽");
  assert.ok(!text.includes("(%)"));
  const words = wordsOf(file);
  const label = words.find(w => w.text === "Скидка")!;
  const percent = words.find(w => w.text === "0%")!;
  assert.ok(Math.abs(percent.yMin - label.yMin) < 1.5, "«0%» в одной строке со словом «Скидка»");
});

test("PDF: марка, год и пробег — под своими подписями, без наложения на них", { skip: !HAS_PDFTOTEXT }, async () => {
  const file = await renderPdf({ number: "114", discount: 0 });
  const words = wordsOf(file);
  const find = (t: string) => words.find(w => w.text === t)!;
  for (const [value, label] of [["Audi", "Марка"], ["2019", "Год"], ["200000", "Пробег"]] as const) {
    assert.ok(find(value).yMin > find(label).yMax, `${value} не налезает на подпись «${label}»`);
  }
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

test("автомобиль ещё крупнее на 15–20%, пропорции сохранены, ничего не перекрывает", async () => {
  const box = DRIVESET_ORDER_COORDINATES.carImage;
  const PREVIOUS = { x: 283, y: 570.5, width: 282, height: 137 }; // область до этой правки
  const growth = box.height / PREVIOUS.height - 1;
  assert.ok(growth >= 0.15 && growth <= 0.2, `рост ${(growth * 100).toFixed(1)}%`);
  assert.equal(box.x, PREVIOUS.x);
  assert.equal(box.width, PREVIOUS.width);
  assert.equal(box.y + box.height / 2, PREVIOUS.y + PREVIOUS.height / 2, "центр области прежний");
  // Для кадра 3:2 вписывание идёт по высоте: снимок растёт на тот же процент, без искажения и обрезки.
  const scale = Math.min(box.width / 1536, box.height / 1024);
  assert.ok(Math.abs((1536 * scale) / (1024 * scale) - 1.5) < 1e-9, "пропорции 3:2 сохраняются");
  assert.ok(1536 * scale <= box.width && 1024 * scale <= box.height, "кадр целиком в области");
  // Низ области выше блока «ДАННЫЕ АВТОМОБИЛЯ» / подписей полей (≈544), верх ниже строк контактов шапки (≈736).
  assert.ok(box.y >= 550, `низ области ${box.y}`);
  assert.ok(box.y + box.height <= 725, `верх области ${box.y + box.height}`);
  // Слева заголовок «ЗАКАЗ-НАРЯД» (Montserrat Bold) заканчивается на x≈241, справа поля страницы — на x=565.
  assert.ok(box.x > 245 && box.x + box.width <= 565);
});

test("марка/модель, год и пробег — Montserrat SemiBold (600), а не Regular", { skip: !HAS_PDFTOTEXT }, async () => {
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
  const regular = await pdf.embedFont(fs.readFileSync("assets/fonts/montserrat/Montserrat_400Regular.ttf"));
  const semibold = await pdf.embedFont(fs.readFileSync("assets/fonts/montserrat/Montserrat_600SemiBold.ttf"));
  const size = DRIVESET_ORDER_COORDINATES.makeModel.size;
  for (const [word, font, other] of [["Geely", semibold, regular], ["Monjaro", semibold, regular], ["2022", semibold, regular], ["км", semibold, regular]] as const) {
    const measured = widthOf(word);
    assert.ok(Math.abs(measured - font.widthOfTextAtSize(word, size)) < 0.35, `${word}: ожидалась ширина ${font.widthOfTextAtSize(word, size).toFixed(2)}, получено ${measured.toFixed(2)}`);
    assert.ok(Math.abs(measured - other.widthOfTextAtSize(word, size)) > 0.15, `${word}: ширина не должна совпадать с другим начертанием`);
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
  assert.equal(DRIVESET_ORDER_COORDINATES.serviceCost.right, 553);
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
  assert.ok(Math.abs(phoneText.xMin - address.xMin) < 1.5, "текст телефона начинается на том же x (±боковой зазор глифов), что адрес");
});

const pdffonts = (file: string) => execFileSync("pdffonts", [file], { encoding: "utf8" });
const HAS_PDFFONTS = spawnSync("pdffonts", ["-v"]).status !== null;

test("Montserrat и в статическом шаблоне, и в динамическом тексте; DejaVu больше не используется", { skip: !HAS_PDFFONTS || !HAS_PDFTOTEXT }, async () => {
  const template = pdffonts(path.join(process.cwd(), "templates", "driveset-order-montserrat.pdf"));
  for (const name of ["Montserrat-Regular", "Montserrat-SemiBold", "Montserrat-Bold", "Montserrat-ExtraBold"]) {
    assert.ok(template.includes(name), `шаблон: ${name}`);
  }
  assert.ok(!/DejaVu/i.test(template), "в шаблоне нет DejaVu");
  const order = pdffonts(await renderSample());
  for (const name of ["Montserrat-Regular", "Montserrat-Medium", "Montserrat-SemiBold", "Montserrat-Bold", "Montserrat-ExtraBold"]) {
    assert.ok(order.includes(name), `готовый заказ-наряд: ${name}`);
  }
  assert.ok(!/DejaVu/i.test(order), "в заказ-наряде нет DejaVu");
});

test("подчёркивания под номером, датой, маркой/моделью, годом и пробегом убраны; остальные линии на месте", { skip: !HAS_PDFTOTEXT }, async () => {
  // Растр самого шаблона (300 dpi): проверяем, что видно на листе.
  const prefix = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "driveset-tpl-")), "tpl");
  execFileSync("pdftoppm", ["-r", "300", "-png", "-singlefile", path.join(process.cwd(), "templates", "driveset-order-montserrat.pdf"), prefix]);
  const { data, info } = await sharp(`${prefix}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = 300 / 72;
  const ink = (box: { x: number; y: number; width: number; height: number }) => {
    let n = 0, total = 0;
    for (let y = Math.floor((841.8898 - box.y - box.height) * k); y < Math.ceil((841.8898 - box.y) * k); y++)
      for (let x = Math.floor(box.x * k); x < Math.ceil((box.x + box.width) * k); x++) {
        const i = (y * info.width + x) * 3;
        total++;
        if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) n++;
      }
    return n / total;
  };
  // Прежние подчёркивания (y в pt от низа страницы): номер 643.9, дата 623.9, марка/год/пробег 519.9.
  const removed: [string, { x: number; y: number; width: number; height: number }][] = [
    ["номер", { x: 52, y: 643, width: 150, height: 1.8 }],
    ["дата", { x: 64, y: 623, width: 140, height: 1.8 }],
    ["марка и модель", { x: 45, y: 519, width: 110, height: 1.8 }],
    ["год выпуска", { x: 196, y: 519, width: 76, height: 1.8 }],
    ["пробег", { x: 314, y: 519, width: 128, height: 1.8 }],
  ];
  for (const [name, box] of removed) assert.ok(ink(box) < 0.002, `подчёркивание под «${name}» убрано`);
  const kept: [string, { x: number; y: number; width: number; height: number }][] = [
    ["вертикальный разделитель перед «Год выпуска»", { x: 179.4, y: 520, width: 1.2, height: 24 }],
    ["вертикальный разделитель перед «Пробег»", { x: 297.4, y: 520, width: 1.2, height: 24 }],
    ["золотая линия под «ДАННЫЕ АВТОМОБИЛЯ»", { x: 32, y: 557.3, width: 24, height: 1.2 }],
    ["линия таблицы", { x: 80, y: 477.3, width: 300, height: 1.2 }],
    ["линия подписи «Заказчик»", { x: 40, y: 33.5, width: 120, height: 1 }],
    ["линия подписи «Исполнитель»", { x: 340, y: 33.5, width: 120, height: 1 }],
  ];
  for (const [name, box] of kept) assert.ok(ink(box) > 0.3, `${name} на месте`);
});
