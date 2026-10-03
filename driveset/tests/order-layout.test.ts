import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import {
  DRIVESET_ORDER_LAYOUT as L,
  DRIVESET_PX_X as KX,
  DRIVESET_PX_Y as KY,
  generateDriveSetOrderPdf,
  type DriveSetService,
} from "../../services/driveset-order.js";

// Раскладка проверяется на сетке MASTER-рендера DriveSet (1024 × 1536 px → A4): px → pt.
const HAS_POPPLER = ["pdftotext", "pdftoppm", "pdffonts"].every(tool => spawnSync(tool, ["-v"]).status !== null);
const opts = { skip: !HAS_POPPLER };
const topPt = (px: number) => px * KY;

const SERVICES_7: DriveSetService[] = [
  { name: "Оклейка всего кузова в цветной, защитный полиуретан с полным разбором автомобиля", price: 270000 },
  { name: "Антихром всех элементов", price: 75000 },
  { name: "Установка заднего диффузора с насадками и передней губы", price: 10000 },
  { name: "Антидождь на все стекла и панорамную крышу", gift: true },
  { name: "Кондиционер кожи всего салона", gift: true },
  { name: "Оклейка внутренних порогов 4 дверей в защитный, прозрачный полиуретан", gift: true },
  { name: "Оклейка четырех глянцевых дверных стоек в прозрачный, защитный полиуретан", gift: true },
];

/** Кадр 3:2 с белыми полями и тёмным «кузовом» заданного размера (px). */
async function carImage(bodyW: number, bodyH: number): Promise<Buffer> {
  const body = await sharp({ create: { width: bodyW, height: bodyH, channels: 3, background: { r: 20, g: 20, b: 60 } } }).png().toBuffer();
  return sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#ffffff" } })
    .composite([{ input: body, left: 300, top: 250 }])
    .png()
    .toBuffer();
}

async function render(
  overrides: Partial<{ orderNumber: string; services: DriveSetService[]; car: Buffer; discount: number }> = {},
): Promise<string> {
  const bytes = await generateDriveSetOrderPdf({
    orderNumber: overrides.orderNumber ?? "1122",
    date: new Date("2026-10-03T12:00:00Z"),
    makeModel: "Geely Monjaro",
    year: 2022,
    mileage: "46 000 км",
    carImage: overrides.car ?? (await carImage(900, 400)),
    services: overrides.services ?? SERVICES_7,
    discountPercent: overrides.discount ?? 15,
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "driveset-layout-")), "order.pdf");
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
const word = (words: Word[], text: string, index = 0): Word => {
  const found = words.filter(w => w.text === text)[index];
  assert.ok(found, `слово «${text}» не найдено`);
  return found;
};

const DPI = 288;
const PPT = DPI / 72; // px растра на pt
type Raster = { data: Buffer; width: number; height: number };
async function raster(file: string): Promise<Raster> {
  const prefix = file.replace(/\.pdf$/, "");
  execFileSync("pdftoppm", ["-r", String(DPI), "-png", "-singlefile", file, prefix]);
  const { data, info } = await sharp(`${prefix}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const pixel = (r: Raster, xPt: number, topPtY: number): [number, number, number] => {
  const i = (Math.round(topPtY * PPT) * r.width + Math.round(xPt * PPT)) * 3;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
};
const lum = (p: [number, number, number]) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
/** Ограничивающий прямоугольник пикселей, подходящих под условие, внутри области (pt от верха страницы). */
function boundsOf(r: Raster, area: { x0: number; x1: number; y0: number; y1: number }, match: (p: [number, number, number]) => boolean) {
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, count = 0;
  for (let y = Math.floor(area.y0 * PPT); y < Math.ceil(area.y1 * PPT); y++)
    for (let x = Math.floor(area.x0 * PPT); x < Math.ceil(area.x1 * PPT); x++) {
      const i = (y * r.width + x) * 3;
      if (match([r.data[i], r.data[i + 1], r.data[i + 2]])) { count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
  return { count, left: x0 / PPT, right: (x1 + 1) / PPT, top: y0 / PPT, bottom: (y1 + 1) / PPT };
}
/** Самая длинная горизонтальная «залитая» полоса (pt) в строках области: признак линии, а не букв. */
function longestRun(r: Raster, area: { x0: number; x1: number; y0: number; y1: number }, thr = 235): number {
  let best = 0;
  for (let y = Math.floor(area.y0 * PPT); y < Math.ceil(area.y1 * PPT); y++) {
    let run = 0;
    for (let x = Math.floor(area.x0 * PPT); x < Math.ceil(area.x1 * PPT); x++) {
      const i = (y * r.width + x) * 3;
      if (lum([r.data[i], r.data[i + 1], r.data[i + 2]]) < thr) { run++; best = Math.max(best, run); } else run = 0;
    }
  }
  return best / PPT;
}

test("автомобиль: область и размер как в MASTER (x 415–1015 px, низ 519 px), пропорции не искажаются", opts, async () => {
  const dark = (p: [number, number, number]) => lum(p) < 90 && p[2] - p[0] > 25; // «кузов» синеватый: чёрный текст заголовка не в счёт
  const area = { x0: 200, x1: PAGE_RIGHT, y0: 100, y1: 300 };
  const left = L.car.x0 * KX;
  const right = L.car.x1 * KX;
  const bottom = topPt(L.car.y1);

  // Широкий автомобиль (2.25:1): ограничен шириной области, стоит на её нижнем крае.
  const wide = boundsOf(await raster(await render({ car: await carImage(900, 400) })), area, dark);
  assert.ok(Math.abs(wide.left - left) < 1.3 && Math.abs(wide.right - right) < 1.3, `x ${wide.left.toFixed(1)}–${wide.right.toFixed(1)} вместо ${left.toFixed(1)}–${right.toFixed(1)}`);
  assert.ok(Math.abs(wide.bottom - bottom) < 1.3, `низ ${wide.bottom.toFixed(1)} вместо ${bottom.toFixed(1)}`);
  assert.ok(Math.abs((wide.right - wide.left) / (wide.bottom - wide.top) - 2.25) < 0.05, "пропорции 900:400 сохранены");

  // Высокий автомобиль (1.4:1): ограничен высотой области (в масштабе по горизонтали, как у MASTER), по центру.
  const tall = boundsOf(await raster(await render({ car: await carImage(700, 500) })), area, dark);
  const boxHeight = (L.car.y1 - L.car.y0) * KX;
  assert.ok(Math.abs(tall.bottom - tall.top - boxHeight) < 1.3, `высота ${(tall.bottom - tall.top).toFixed(1)} вместо ${boxHeight.toFixed(1)}`);
  assert.ok(Math.abs((tall.left + tall.right) / 2 - (left + right) / 2) < 1.5, "по центру области");
  assert.ok(Math.abs((tall.right - tall.left) / (tall.bottom - tall.top) - 1.4) < 0.05, "пропорции 700:500 сохранены");
});

const PAGE_RIGHT = 595.2756;

test("автомобиль крупный, но заголовок «ЗАКАЗ-НАРЯД» и блок «ДАННЫЕ АВТОМОБИЛЯ» ничем не перекрыты", opts, async () => {
  const words = wordsOf(await render());
  const title = word(words, "ЗАКАЗ-НАРЯД");
  assert.ok(title.xMax <= L.car.x0 * KX + 0.5, `заголовок заканчивается на ${title.xMax.toFixed(1)} pt, область автомобиля начинается с ${(L.car.x0 * KX).toFixed(1)} pt`);
  const carBottom = topPt(L.car.y1);
  const label = word(words, "Пробег");
  assert.ok(label.yMin >= carBottom - 0.5, "подпись «Пробег» ниже области автомобиля");
  const phone = word(words, "+7");
  assert.ok(phone.yMax <= topPt(L.car.y1) - (L.car.y1 - L.car.y0) * KX + 4, "телефон не заходит на область автомобиля");
});

test("Montserrat везде: в готовом документе только Montserrat (нет DejaVu), веса соответствуют ролям", opts, async () => {
  const file = await render();
  const fonts = execFileSync("pdffonts", [file], { encoding: "utf8" });
  for (const name of ["Montserrat-Regular", "Montserrat-Medium", "Montserrat-SemiBold", "Montserrat-Bold", "Montserrat-ExtraBold"]) assert.ok(fonts.includes(name), name);
  assert.ok(!/DejaVu/i.test(fonts), "DejaVu не используется");

  const words = wordsOf(file);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const load = async (name: string) => pdf.embedFont(fs.readFileSync(`assets/fonts/montserrat/Montserrat_${name}.ttf`));
  const weights = { regular: await load("400Regular"), semibold: await load("600SemiBold"), bold: await load("700Bold"), extrabold: await load("800ExtraBold") };
  const cases: [string, keyof typeof weights, keyof typeof weights, number][] = [
    ["ЗАКАЗ-НАРЯД", "bold", "extrabold", L.title.size], // Bold 700
    ["Geely", "semibold", "regular", L.fields.valueSize], // SemiBold 600
    ["2022", "semibold", "regular", L.fields.valueSize],
    ["ИТОГО", "extrabold", "bold", L.summary.totalSize], // ExtraBold 800
    ["Заказчик", "semibold", "regular", L.signatures.labelSize],
  ];
  for (const [text, expected, other, size] of cases) {
    const measured = word(words, text).xMax - word(words, text).xMin;
    const want = weights[expected].widthOfTextAtSize(text, size);
    assert.ok(Math.abs(measured - want) < 0.4, `${text}: ширина ${measured.toFixed(2)}, ожидалась ${want.toFixed(2)} (${expected})`);
    assert.ok(Math.abs(measured - weights[other].widthOfTextAtSize(text, size)) > 0.3, `${text}: не должна совпадать с весом ${other}`);
  }
});

test("подчёркиваний под номером, датой, маркой/моделью, годом и пробегом нет; вертикальные разделители, золотая линия, таблица и подписи на месте", opts, async () => {
  const r = await raster(await render());
  // Под значением: строки от базовой линии + 3 pt (ниже самых длинных выносных элементов) на 8 pt вниз.
  const under = (baselinePx: number, x0Px: number, x1Px: number) => ({ x0: x0Px * KX, x1: x1Px * KX, y0: topPt(baselinePx) + 3.2, y1: topPt(baselinePx) + 8 });
  for (const [name, area] of [
    ["номер", under(L.number.baseline, 52, 400)],
    ["дата", under(L.date.baseline, 51, 400)],
    ["марка и модель", under(L.fields.valueBaseline, 71, 280)],
    ["год выпуска", under(L.fields.valueBaseline, 313, 470)],
    ["пробег", under(L.fields.valueBaseline, 499, 700)],
  ] as const) {
    assert.ok(longestRun(r, area, 245) < 30, `под «${name}» нет горизонтальной линии (полоса ${longestRun(r, area, 245).toFixed(1)} pt)`);
  }
  // Что должно остаться.
  const inkRatio = (area: { x0: number; x1: number; y0: number; y1: number }, thr = 245) => {
    let n = 0, total = 0;
    for (let y = Math.floor(area.y0 * PPT); y < Math.ceil(area.y1 * PPT); y++)
      for (let x = Math.floor(area.x0 * PPT); x < Math.ceil(area.x1 * PPT); x++) { total++; const i = (y * r.width + x) * 3; if (lum([r.data[i], r.data[i + 1], r.data[i + 2]]) < thr) n++; }
    return n / total;
  };
  for (const x of L.fields.dividers) {
    assert.ok(inkRatio({ x0: x * KX - 0.8, x1: x * KX + 0.8, y0: topPt(L.fields.y0 + 8), y1: topPt(L.fields.y1 - 8) }) > 0.25, `вертикальный разделитель x=${x}`);
  }
  assert.ok(longestRun(r, { x0: L.section.goldLine.x0 * KX, x1: L.section.goldLine.x1 * KX, y0: topPt(L.section.goldLine.y) - 1, y1: topPt(L.section.goldLine.y) + 1 }, 235) > 20, "золотая линия под «ДАННЫЕ АВТОМОБИЛЯ»");
  assert.ok(longestRun(r, { x0: 40, x1: 560, y0: topPt(L.table.top + L.table.headerHeight) - 1, y1: topPt(L.table.top + L.table.headerHeight) + 1 }, 245) > 400, "линия под шапкой таблицы");
  for (const b of L.signatures.blocks) {
    assert.ok(longestRun(r, { x0: b.lineX0 * KX, x1: b.lineX1 * KX, y0: topPt(L.signatures.lineY) - 1, y1: topPt(L.signatures.lineY) + 1 }, 235) > 140, "линия подписи");
  }
});

test("таблица: номера по центру колонки «№», цены и «В подарок» по правому краю, длинные названия в две строки", opts, async () => {
  const words = wordsOf(await render());
  const columnCenter = ((L.table.x0 + L.table.colNumber) / 2) * KX;
  const firstRowWords = words.filter(w => /^[1-7]$/.test(w.text) && w.xMin > 40 && w.xMax < 62 && w.yMin > topPt(L.table.top + L.table.headerHeight));
  assert.equal(firstRowWords.length, 7, "семь номеров строк");
  for (const w of firstRowWords) assert.ok(Math.abs((w.xMin + w.xMax) / 2 - columnCenter) < 0.8, `номер ${w.text}: центр ${((w.xMin + w.xMax) / 2).toFixed(2)} вместо ${columnCenter.toFixed(2)}`);
  const right = L.table.priceRight * KX;
  const priceEdges = [
    ...words.filter(w => w.text === "₽" && w.xMin > 470 && w.yMin > topPt(L.table.top + L.table.headerHeight) && w.yMin < topPt(L.table.maxBottom)).map(w => w.xMax),
    ...words.filter(w => w.text === "подарок").map(w => w.xMax),
  ];
  assert.equal(priceEdges.length, 7, "три цены и четыре «В подарок»");
  for (const edge of priceEdges) assert.ok(Math.abs(edge - right) < 1, `правый край ${edge.toFixed(2)} вместо ${right.toFixed(2)}`);
  // Длинное название переносится на вторую строку, короткое — нет.
  assert.ok(word(words, "полным").yMin - word(words, "Оклейка").yMin > 10, "первое название в две строки");
  assert.ok(Math.abs(word(words, "всех").yMin - word(words, "Антихром").yMin) < 1, "второе название в одну строку");
  // Все семь строк помещаются до нижнего края таблицы MASTER.
  const lastRow = word(words, "стоек");
  assert.ok(lastRow.yMax < topPt(L.table.maxBottom), "таблица не выходит за границу MASTER");
});

test("блоки итогов и примечаний идут следом за таблицей, подписи остаются внизу", opts, async () => {
  const full = wordsOf(await render());
  const short = wordsOf(await render({ services: SERVICES_7.slice(0, 2) }));
  assert.ok(word(short, "ИТОГО").yMin < word(full, "ИТОГО").yMin - 60, "при двух услугах итоги выше");
  assert.equal(word(short, "Заказчик").yMin, word(full, "Заказчик").yMin, "подписи на месте");
  assert.ok(word(full, "Примечания:").yMin > word(full, "ИТОГО").yMax, "примечания ниже итогов");
  assert.ok(word(full, "Заказчик").yMin > word(full, "Примечания:").yMax, "подписи ниже примечаний");
});

test("шапка: три иконки на одной оси (адрес, @driveset, телефон), тот же размер и золото; текст телефона с того же x, что адрес", opts, async () => {
  const file = await render();
  const r = await raster(file);
  const gold = (p: [number, number, number]) => p[0] > 140 && p[0] - p[2] > 50 && p[1] > 90 && p[1] < 175;
  const iconX = L.contacts.iconX * KX;
  const icons = L.contacts.rows.map(row => boundsOf(r, { x0: iconX - 10, x1: iconX + 10, y0: topPt(row.centerY) - 10, y1: topPt(row.centerY) + 10 }, gold));
  for (const [i, icon] of icons.entries()) assert.ok(icon.count > 60, `иконка ${i + 1} золотая`);
  const centers = icons.map(icon => (icon.left + icon.right) / 2);
  assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `ось x иконок: ${centers.map(c => c.toFixed(2)).join(", ")}`);
  assert.ok(Math.abs(centers[0] - iconX) < 1, "ось иконок как в MASTER");
  for (const icon of icons) assert.ok(Math.abs(icon.right - icon.left - (icons[1].right - icons[1].left)) < 2.2 && Math.abs(icon.bottom - icon.top - (icons[1].bottom - icons[1].top)) < 2.5, "одинаковый размер");
  const words = wordsOf(file);
  assert.ok(Math.abs(word(words, "+7").xMin - word(words, "Москва,").xMin) < 1.6, "телефон начинается с того же x, что адрес");
  assert.ok(Math.abs(word(words, "@driveset").xMin - word(words, "Москва,").xMin) < 1.6, "@driveset — с того же x");
  const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
  assert.ok(text.includes("+7 901 344-77-33") && !text.includes("☎"), "номер текстом, без юникод-символа телефона");
});

test("итог: градиентная полоса белая слева и золотая справа, длинный номер заказ-наряда не заходит под автомобиль", opts, async () => {
  const file = await render({ orderNumber: "ДС-2026-ОЧЕНЬ-ДЛИННЫЙ-НОМЕР-ЗАКАЗ-НАРЯДА-1234567890" });
  const r = await raster(file);
  const words = wordsOf(file);
  const total = word(words, "ИТОГО");
  const y = (total.yMin + total.yMax) / 2;
  const [lr, lg, lb] = pixel(r, 560 * KX, y);
  const [rr, rg, rb] = pixel(r, 965 * KX, y - 14);
  assert.ok(lr > 245 && lg > 245 && lb > 245, "слева полоса белая");
  assert.ok(rr > 200 && rb < 160 && rr - rb > 60, `справа золото (${rr},${rg},${rb})`);
  const number = words.filter(w => w.yMin > topPt(340) && w.yMax < topPt(380) && w.xMin > 30 && w.xMin < 300);
  assert.ok(Math.max(...number.map(w => w.xMax)) <= L.number.maxRight * KX + 0.8, "номер уменьшен и остаётся левее автомобиля");
});
