import fs from "node:fs";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import sharp from "sharp";

// Заказ-наряд рисуется целиком кодом по сетке MASTER-рендера DriveSet (1024 × 1536 px), отображённой на A4:
// по горизонтали 1 px = 595.2756 / 1024 pt, по вертикали 1 px = 841.8898 / 1536 pt (A4 ниже, чем 2:3, поэтому
// вертикальные расстояния сжаты пропорционально). Размеры шрифтов подобраны по ширинам текста MASTER, поэтому
// кегль не сжимается. Из прежнего PDF-шаблона нужен только логотип (assets/driveset-logo.png).

const PAGE_W = 595.2756;
const PAGE_H = 841.8898;
const GRID_W = 1024;
const GRID_H = 1536;
/** pt на 1 px MASTER по горизонтали и одинаково для размеров (логотип, шрифты, иконки). */
const KX = PAGE_W / GRID_W;
/** pt на 1 px MASTER по вертикали (расстояния между блоками). */
const KY = PAGE_H / GRID_H;
/** Расстояние от верха страницы (px сетки MASTER) → pt. */
const top = (px: number): number => px * KY;
/** Расстояние от верха страницы (pt) → координата y PDF. */
const pdfY = (fromTopPt: number): number => PAGE_H - fromTopPt;

const LOGO_PATH = path.join(process.cwd(), "assets", "driveset-logo.png");

// Montserrat (SIL OFL, кириллица) лежит в репозитории: в системе сервера его устанавливать не нужно.
const FONT_DIR = path.join(process.cwd(), "assets", "fonts", "montserrat");
const FONT_FILES = {
  regular: "Montserrat_400Regular.ttf", // основной текст
  medium: "Montserrat_500Medium.ttf", // цены, номер заказ-наряда
  semibold: "Montserrat_600SemiBold.ttf", // марка/модель, год, пробег, акценты
  bold: "Montserrat_700Bold.ttf", // ЗАКАЗ-НАРЯД
  extrabold: "Montserrat_800ExtraBold.ttf", // ИТОГО К ОПЛАТЕ и итоговая сумма
} as const;
type FontWeight = keyof typeof FONT_FILES;
type Fonts = Record<FontWeight, PDFFont>;

const MAX_SERVICE_ROWS = 7;
const DRIVESET_PHONE = "+7 901 344-77-33";
const ADDRESS = "Москва, улица Наташи Ковшовой, 4с2";

/**
 * Геометрия документа в px сетки MASTER (x — слева, y — сверху), кегль — в pt (подобран по ширине текста MASTER).
 * Блоки ниже таблицы (итоги, примечания) идут следом за ней и сдвигаются вместе с её нижним краем; подписи — внизу.
 */
const LAYOUT = {
  // Логотип (370 × 200 px, видимая часть 353 × 181 совпадает с логотипом MASTER один к одному).
  logo: { x: 44, y: 46, width: 370, height: 200 },
  contacts: {
    separator: { x: 572, y0: 49, y1: 192 },
    iconX: 614.5,
    textX: 646,
    size: 9.5,
    // Адрес и @driveset — как в MASTER; телефон — третьей строкой с тем же шагом.
    rows: [
      { centerY: 94, baseline: 100 },
      { centerY: 132, baseline: 138 },
      { centerY: 176, baseline: 182 },
    ],
  },
  title: { x: 50, baseline: 331, size: 26.7 },
  number: { x: 52, baseline: 372, size: 15.4, maxRight: 405 },
  date: { x: 51, baseline: 409.5, size: 12.2, maxRight: 405 },
  // Видимая область автомобиля в MASTER (с тенью): снимок обрезается по белым полям и вписывается в неё.
  car: { x0: 415, x1: 1015, y0: 210, y1: 519 },
  section: { x: 49, baseline: 479, size: 10.06, goldLine: { x0: 49, x1: 87, y: 496 } },
  fields: {
    dividers: [48, 288, 474],
    y0: 521,
    y1: 567,
    labelBaseline: 534.5,
    valueBaseline: 565.5,
    labelSize: 7.65,
    valueSize: 11.8,
    columns: [
      { x: 71, width: 205 },
      { x: 313, width: 150 },
      { x: 499, width: 300 },
    ],
  },
  table: {
    x0: 46,
    x1: 978,
    top: 594,
    headerHeight: 44,
    headerBaseline: 625,
    headerSize: 8.6,
    colNumber: 126,
    colCost: 803,
    nameX: 150,
    /** Ширина колонки названий (pt): длинное название переносится на вторую строку, как в MASTER. */
    nameWidth: 290,
    nameSize: 9.7,
    lineGap: 13.2,
    priceRight: 950,
    priceSize: 10.4,
    /** Высота строки с названием в одну / две строки (pt). */
    row1: 26,
    row2: 35.5,
    /** Нижний край таблицы в MASTER (px): выше него остаётся место для блока итогов. */
    maxBottom: 1040,
  },
  summary: {
    gap: 17,
    x0: 46,
    x1: 978,
    labelX: 73,
    valueRight: 950,
    labelSize: 10.8,
    valueSize: 11.5,
    firstBaseline: 34,
    rowStep: 34.5,
    ruleX: [72, 954],
    totalSize: 18.5,
    totalLabelX: 77,
    totalRight: 946,
    bandX0: 600,
    bandHeight: 64,
    bandBaseline: 43,
  },
  notes: {
    x: 51,
    textX: 67,
    size: 7.8,
    headingOffset: 35,
    lineOffsets: [59.5, 81, 102.5],
  },
  signatures: {
    labelBaseline: 1420,
    lineY: 1434,
    subBaseline: 1458,
    labelSize: 8.7,
    subSize: 7.8,
    separator: { x: 511.5, y0: 1395, y1: 1480 },
    blocks: [
      { x: 50, lineX0: 50, lineX1: 307, dateX0: 331, dateX1: 464 },
      { x: 559, lineX0: 559, lineX1: 815, dateX0: 841, dateX1: 975 },
    ],
  },
} as const;

const COLORS = {
  ink: rgb(0.05, 0.05, 0.06),
  muted: rgb(0.27, 0.27, 0.3),
  soft: rgb(0.36, 0.36, 0.4),
  gold: rgb(0.69, 0.53, 0.3),
  rule: rgb(0.72, 0.59, 0.38),
  frame: rgb(0.91, 0.91, 0.91),
  line: rgb(0.93, 0.93, 0.93),
  header: rgb(0.965, 0.965, 0.965),
  signature: rgb(0.55, 0.55, 0.56),
};

/** Градиент блока итога (слева белый, справа золото), опорные точки сняты с MASTER: [x px, r, g, b]. */
const BAND_STOPS: [number, number, number, number][] = [
  [600, 255, 255, 255],
  [650, 250, 246, 243],
  [700, 242, 227, 207],
  [800, 233, 202, 156],
  [900, 237, 200, 144],
  [960, 229, 181, 122],
  [978, 224, 178, 111],
];

export type DriveSetService = {
  name: string;
  /** Цена услуги в рублях. Для подарочной услуги передайте `gift: true`. */
  price?: number;
  gift?: boolean;
};

export type DriveSetOrderData = {
  orderNumber: string;
  date: string | Date;
  makeModel: string;
  year: string | number;
  mileage: string | number;
  carImage: Uint8Array;
  services: DriveSetService[];
  /** Единая скидка на сумму всех платных работ. */
  discountPercent?: number;
};

export type DriveSetOrderTotals = {
  paidWorksCost: number;
  discountPercent: number;
  discountAmount: number;
  total: number;
};

function assertRequiredFile(filePath: string, description: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${description} не найден: ${filePath}`);
  }
}

function validateOrder(data: DriveSetOrderData): void {
  if (!data.orderNumber.trim()) throw new Error("Не указан номер заказ-наряда");
  if (!data.makeModel.trim()) throw new Error("Не указаны марка и модель автомобиля");
  if (!String(data.year).trim()) throw new Error("Не указан год выпуска автомобиля");
  if (!String(data.mileage).trim()) throw new Error("Не указан пробег автомобиля");
  if (data.carImage.byteLength === 0) throw new Error("Не передано изображение автомобиля");
  if (data.services.length === 0) throw new Error("Не добавлены услуги");
  if (data.services.length > MAX_SERVICE_ROWS) {
    throw new Error(`В шаблоне предусмотрено не более ${MAX_SERVICE_ROWS} услуг`);
  }

  const discountPercent = data.discountPercent ?? 0;
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new Error("Скидка должна быть числом от 0 до 100");
  }

  data.services.forEach((service, index) => {
    if (!service.name.trim()) throw new Error(`Не указано название услуги № ${index + 1}`);
    if (!service.gift && (!Number.isFinite(service.price) || (service.price ?? -1) < 0)) {
      throw new Error(`Не указана корректная стоимость услуги № ${index + 1}`);
    }
  });
}

export function calculateDriveSetOrderTotals(
  services: DriveSetService[],
  discountPercent = 0,
): DriveSetOrderTotals {
  const paidWorksCost = services.reduce(
    (sum, service) => sum + (service.gift ? 0 : (service.price ?? 0)),
    0,
  );
  const discountAmount = Math.round((paidWorksCost * discountPercent) / 100 * 100) / 100;

  return {
    paidWorksCost,
    discountPercent,
    discountAmount,
    total: Math.max(0, paidWorksCost - discountAmount),
  };
}

/** «03 октября 2026», как в MASTER; строка (если передана готовая дата) печатается как есть. */
function formatDate(value: string | Date): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Не указана дата заказ-наряда");
    return trimmed;
  }
  if (Number.isNaN(value.getTime())) throw new Error("Некорректная дата заказ-наряда");
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" })
    .format(value)
    .replace(/\s?г\.$/, "");
}

function formatAmount(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)} ₽`;
}

// ---------- примитивы рисования ----------

type TextStyle = { font: PDFFont; size: number; color?: ReturnType<typeof rgb> };

function fitSize(text: string, font: PDFFont, size: number, maxWidth: number, minSize = 5): number {
  let fitted = size;
  while (fitted > minSize && font.widthOfTextAtSize(text, fitted) > maxWidth) fitted -= 0.1;
  return fitted;
}

/** Текст с базовой линией `baselineTop` (pt от верха страницы); слишком длинный — уменьшается до `maxWidth`. */
function drawText(
  page: PDFPage,
  text: string,
  style: TextStyle,
  at: { x: number; baselineTop: number; maxWidth?: number },
): number {
  const size = at.maxWidth ? fitSize(text, style.font, style.size, at.maxWidth) : style.size;
  page.drawText(text, { x: at.x, y: pdfY(at.baselineTop), size, font: style.font, color: style.color ?? COLORS.ink });
  return style.font.widthOfTextAtSize(text, size);
}

function drawTextRight(
  page: PDFPage,
  text: string,
  style: TextStyle,
  at: { right: number; baselineTop: number; maxWidth?: number },
): void {
  const size = at.maxWidth ? fitSize(text, style.font, style.size, at.maxWidth) : style.size;
  const width = style.font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: at.right - width,
    y: pdfY(at.baselineTop),
    size,
    font: style.font,
    color: style.color ?? COLORS.ink,
  });
}

function drawTextCentered(page: PDFPage, text: string, style: TextStyle, at: { center: number; baselineTop: number }): void {
  const width = style.font.widthOfTextAtSize(text, style.size);
  page.drawText(text, {
    x: at.center - width / 2,
    y: pdfY(at.baselineTop),
    size: style.size,
    font: style.font,
    color: style.color ?? COLORS.ink,
  });
}

/** Перенос по словам не более чем на `maxLines` строк; при нехватке места кегль уменьшается, затем строка обрезается «…». */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): { lines: string[]; size: number } {
  const normalized = text.replace(/\s+/g, " ").trim();
  for (let s = size; s >= 6.5; s -= 0.25) {
    const lines: string[] = [];
    let current = "";
    for (const word of normalized.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, s) <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
    if (lines.length <= maxLines && lines.every(line => font.widthOfTextAtSize(line, s) <= maxWidth)) return { lines, size: s };
  }
  // Не поместилось и в самом мелком кегле: две строки, вторая обрезана.
  const s = 6.5;
  const words = normalized.split(" ");
  let first = "";
  let index = 0;
  while (index < words.length && font.widthOfTextAtSize(first ? `${first} ${words[index]}` : words[index], s) <= maxWidth) {
    first = first ? `${first} ${words[index]}` : words[index];
    index++;
  }
  let second = words.slice(index).join(" ");
  while (second.length > 1 && font.widthOfTextAtSize(`${second}…`, s) > maxWidth) second = second.slice(0, -1);
  return { lines: [first || second, ...(first && second ? [`${second}…`] : [])], size: s };
}

/** Прямоугольник со скруглёнными углами в координатах «от верха страницы» (pt). */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number, roundBottom = true): string {
  const bottomR = roundBottom ? r : 0;
  return [
    `M ${x + r} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h - bottomR}`,
    bottomR ? `A ${bottomR} ${bottomR} 0 0 1 ${x + w - bottomR} ${y + h}` : `L ${x + w} ${y + h}`,
    `H ${x + bottomR}`,
    bottomR ? `A ${bottomR} ${bottomR} 0 0 1 ${x} ${y + h - bottomR}` : `L ${x} ${y + h}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

function drawHLine(page: PDFPage, x0: number, x1: number, yTop: number, color: ReturnType<typeof rgb>, thickness: number): void {
  page.drawLine({ start: { x: x0, y: pdfY(yTop) }, end: { x: x1, y: pdfY(yTop) }, color, thickness });
}

function drawVLine(page: PDFPage, x: number, y0Top: number, y1Top: number, color: ReturnType<typeof rgb>, thickness: number): void {
  page.drawLine({ start: { x, y: pdfY(y0Top) }, end: { x, y: pdfY(y1Top) }, color, thickness });
}

// ---------- иконки (контур, золото) ----------

const ICON_SCALE = 0.53; // 24 px viewBox → ≈ 12.7 pt, как иконки MASTER (~22 px)
const ICON_STROKE = 1; // pt на странице
const PIN_PATH = "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M15 10a3 3 0 1 1-6 0a3 3 0 0 1 6 0z";
const PLANE_PATH = "M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z";
// Контур трубки (Feather «phone», MIT).
const PHONE_PATH =
  "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z";

function drawIcon(page: PDFPage, svgPath: string, centerXPx: number, centerYPx: number): void {
  const cx = centerXPx * KX;
  const cy = top(centerYPx);
  page.drawSvgPath(svgPath, {
    x: cx - 12 * ICON_SCALE,
    y: pdfY(cy - 12 * ICON_SCALE),
    scale: ICON_SCALE,
    borderColor: COLORS.gold,
    borderWidth: ICON_STROKE / ICON_SCALE, // pdf-lib масштабирует и толщину линии
  });
}

// ---------- автомобиль ----------

/** Обрезает однотонные белые поля снимка (если они есть), чтобы автомобиль занимал область MASTER, а не кадр. */
async function prepareCarImage(imageBytes: Uint8Array): Promise<Buffer> {
  const rotated = await sharp(Buffer.from(imageBytes)).rotate().png().toBuffer();
  try {
    const meta = await sharp(rotated).metadata();
    const trimmed = await sharp(rotated).trim({ background: "#ffffff", threshold: 14 }).png().toBuffer();
    const after = await sharp(trimmed).metadata();
    const keeps = (after.width ?? 0) >= (meta.width ?? 0) * 0.2 && (after.height ?? 0) >= (meta.height ?? 0) * 0.2;
    return keeps ? trimmed : rotated;
  } catch {
    // Однотонный снимок (например, прозрачная заглушка без изображения): рисуем как есть.
    return rotated;
  }
}

async function drawCarImage(page: PDFPage, pdf: PDFDocument, imageBytes: Uint8Array): Promise<void> {
  const image = await pdf.embedPng(await prepareCarImage(imageBytes));
  const box = LAYOUT.car;
  const boxX = box.x0 * KX;
  const boxW = (box.x1 - box.x0) * KX;
  // Высота области — в масштабе по горизонтали (как у MASTER), чтобы снимок не сжимался по вертикали вместе с A4.
  const boxH = (box.y1 - box.y0) * KX;
  const boxBottom = top(box.y1);
  const scale = Math.min(boxW / image.width, boxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, {
    x: boxX + (boxW - width) / 2,
    y: pdfY(boxBottom), // автомобиль «стоит» на нижнем крае области
    width,
    height,
  });
}

// ---------- сборка страницы ----------

/** Рисует документ на белой странице A4 по сетке MASTER; PDF собирается только из кода, шрифтов и логотипа. */
export async function generateDriveSetOrderPdf(data: DriveSetOrderData): Promise<Uint8Array> {
  validateOrder(data);
  assertRequiredFile(LOGO_PATH, "Логотип DriveSet");
  for (const file of Object.values(FONT_FILES)) assertRequiredFile(path.join(FONT_DIR, file), `Шрифт ${file}`);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const entries = await Promise.all(
    (Object.entries(FONT_FILES) as [FontWeight, string][]).map(
      async ([weight, file]) =>
        [weight, await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, file)), { subset: true })] as const,
    ),
  );
  const f = Object.fromEntries(entries) as Fonts;
  const totals = calculateDriveSetOrderTotals(data.services, data.discountPercent ?? 0);

  // Автомобиль — первым: его (белый) фон не должен ложиться поверх текста.
  await drawCarImage(page, pdf, data.carImage);

  // Логотип.
  const logo = await pdf.embedPng(fs.readFileSync(LOGO_PATH));
  page.drawImage(logo, {
    x: LAYOUT.logo.x * KX,
    y: pdfY(top(LAYOUT.logo.y) + LAYOUT.logo.height * KX),
    width: LAYOUT.logo.width * KX,
    height: LAYOUT.logo.height * KX,
  });

  // Контакты: вертикальный разделитель, иконки, адрес / @driveset / телефон.
  const c = LAYOUT.contacts;
  drawVLine(page, c.separator.x * KX, top(c.separator.y0), top(c.separator.y1), COLORS.frame, 0.7);
  const contactLines: [string, string][] = [
    [PIN_PATH, ADDRESS],
    [PLANE_PATH, "@driveset"],
    [PHONE_PATH, DRIVESET_PHONE],
  ];
  contactLines.forEach(([icon, text], index) => {
    const row = c.rows[index];
    drawIcon(page, icon, c.iconX, row.centerY);
    drawText(page, text, { font: f.regular, size: c.size }, { x: c.textX * KX, baselineTop: top(row.baseline) });
  });

  // Заголовок, номер и дата.
  drawText(page, "ЗАКАЗ-НАРЯД", { font: f.bold, size: LAYOUT.title.size }, { x: LAYOUT.title.x * KX, baselineTop: top(LAYOUT.title.baseline) });
  const numberStyle = { font: f.medium, size: LAYOUT.number.size };
  const numberX = LAYOUT.number.x * KX;
  const signWidth = drawText(page, "№ ", numberStyle, { x: numberX, baselineTop: top(LAYOUT.number.baseline) });
  drawText(page, data.orderNumber.trim(), numberStyle, {
    x: numberX + signWidth,
    baselineTop: top(LAYOUT.number.baseline),
    maxWidth: LAYOUT.number.maxRight * KX - numberX - signWidth,
  });
  drawText(
    page,
    formatDate(data.date),
    { font: f.regular, size: LAYOUT.date.size, color: COLORS.soft },
    { x: LAYOUT.date.x * KX, baselineTop: top(LAYOUT.date.baseline), maxWidth: (LAYOUT.date.maxRight - LAYOUT.date.x) * KX },
  );

  // ДАННЫЕ АВТОМОБИЛЯ.
  const s = LAYOUT.section;
  drawText(page, "ДАННЫЕ АВТОМОБИЛЯ", { font: f.regular, size: s.size }, { x: s.x * KX, baselineTop: top(s.baseline) });
  drawHLine(page, s.goldLine.x0 * KX, s.goldLine.x1 * KX, top(s.goldLine.y), COLORS.rule, 1.3);
  const fl = LAYOUT.fields;
  for (const x of fl.dividers) drawVLine(page, x * KX, top(fl.y0), top(fl.y1), COLORS.frame, 0.7);
  const fieldTexts: [string, string][] = [
    ["Марка и модель", data.makeModel.trim()],
    ["Год выпуска", String(data.year).trim()],
    ["Пробег", String(data.mileage).trim()],
  ];
  fieldTexts.forEach(([label, value], index) => {
    const col = fl.columns[index];
    drawText(page, label, { font: f.regular, size: fl.labelSize, color: COLORS.muted }, { x: col.x * KX, baselineTop: top(fl.labelBaseline) });
    drawText(page, value, { font: f.semibold, size: fl.valueSize }, { x: col.x * KX, baselineTop: top(fl.valueBaseline), maxWidth: col.width * KX });
  });

  // Таблица услуг: строки по содержимому (одна / две строки названия).
  const t = LAYOUT.table;
  const tx0 = t.x0 * KX;
  const tx1 = t.x1 * KX;
  const tTop = top(t.top);
  const headerH = top(t.headerHeight);
  const wrapped = data.services.map(service => wrapText(service.name, f.regular, t.nameSize, t.nameWidth, 2));
  const twoLine = wrapped.filter(w => w.lines.length > 1).length;
  const budget = top(t.maxBottom) - tTop - headerH;
  const row2 = Math.min(t.row2, twoLine ? (budget - (wrapped.length - twoLine) * t.row1) / twoLine : t.row2);
  const rowHeights = wrapped.map(w => (w.lines.length > 1 ? row2 : t.row1));
  const tBottom = tTop + headerH + rowHeights.reduce((sum, h) => sum + h, 0);

  page.drawSvgPath(roundedRectPath(tx0, tTop, tx1 - tx0, headerH, 5, false), { x: 0, y: PAGE_H, color: COLORS.header });
  page.drawSvgPath(roundedRectPath(tx0, tTop, tx1 - tx0, tBottom - tTop, 5), { x: 0, y: PAGE_H, borderColor: COLORS.frame, borderWidth: 0.7 });
  const colNumberX = t.colNumber * KX;
  const colCostX = t.colCost * KX;
  drawHLine(page, tx0, tx1, tTop + headerH, COLORS.line, 0.6); // линия под шапкой, как в MASTER
  drawVLine(page, colNumberX, tTop + headerH, tBottom, COLORS.line, 0.6);
  drawVLine(page, colCostX, tTop + headerH, tBottom, COLORS.line, 0.6);
  const headStyle = { font: f.regular, size: t.headerSize, color: COLORS.ink };
  drawTextCentered(page, "№", headStyle, { center: ((t.x0 + t.colNumber) / 2) * KX, baselineTop: top(t.headerBaseline) });
  drawText(page, "НАИМЕНОВАНИЕ РАБОТ / УСЛУГ", headStyle, { x: t.nameX * KX, baselineTop: top(t.headerBaseline) });
  drawTextRight(page, "СТОИМОСТЬ", headStyle, { right: t.priceRight * KX, baselineTop: top(t.headerBaseline) });

  let rowTop = tTop + headerH;
  data.services.forEach((service, index) => {
    const height = rowHeights[index];
    if (index > 0) drawHLine(page, tx0, tx1, rowTop, COLORS.line, 0.6);
    const cap = 0.7 * t.nameSize;
    const lines = wrapped[index].lines;
    const blockHeight = cap + (lines.length - 1) * t.lineGap;
    const firstBaseline = rowTop + (height - blockHeight) / 2 + cap;
    lines.forEach((line, lineIndex) =>
      drawText(page, line, { font: f.regular, size: wrapped[index].size }, { x: t.nameX * KX, baselineTop: firstBaseline + lineIndex * t.lineGap }),
    );
    const mid = rowTop + height / 2 + (0.7 * t.nameSize) / 2;
    drawTextCentered(page, String(index + 1), { font: f.regular, size: t.nameSize }, { center: ((t.x0 + t.colNumber) / 2) * KX, baselineTop: mid });
    drawTextRight(
      page,
      service.gift ? "В подарок" : formatAmount(service.price ?? 0),
      { font: f.medium, size: t.priceSize },
      { right: t.priceRight * KX, baselineTop: rowTop + height / 2 + (0.7 * t.priceSize) / 2, maxWidth: (t.priceRight - t.colCost - 14) * KX },
    );
    rowTop += height;
  });

  // Блок итогов (две строки: платные работы и скидка), затем градиентная полоса «ИТОГО К ОПЛАТЕ».
  const sm = LAYOUT.summary;
  const cardTop = tBottom + top(sm.gap);
  const rows = [
    { label: "Стоимость платных работ", value: formatAmount(totals.paidWorksCost) },
    {
      label: `Скидка ${totals.discountPercent}%`,
      value: totals.discountAmount > 0 ? `− ${formatAmount(totals.discountAmount)}` : formatAmount(0),
    },
  ];
  const lastBaselinePx = sm.firstBaseline + sm.rowStep * (rows.length - 1);
  const rulePx = lastBaselinePx + 23;
  const bandTopPx = rulePx + 5;
  const cardHeight = top(bandTopPx + sm.bandHeight);
  const bandTop = cardTop + top(bandTopPx);
  const bandBottom = cardTop + cardHeight;
  const stripCount = Math.round(sm.x1 - sm.bandX0);
  for (let i = 0; i < stripCount; i++) {
    const xPx = sm.bandX0 + i;
    const [r, g, b] = gradientAt(xPx);
    page.drawRectangle({
      x: xPx * KX,
      y: pdfY(bandBottom),
      width: KX * 1.05,
      height: bandBottom - bandTop,
      color: rgb(r / 255, g / 255, b / 255),
    });
  }
  page.drawSvgPath(roundedRectPath(sm.x0 * KX, cardTop, (sm.x1 - sm.x0) * KX, cardHeight, 5), { x: 0, y: PAGE_H, borderColor: COLORS.frame, borderWidth: 0.7 });
  rows.forEach((row, index) => {
    const baseline = cardTop + top(sm.firstBaseline + sm.rowStep * index);
    drawText(page, row.label, { font: f.regular, size: sm.labelSize }, { x: sm.labelX * KX, baselineTop: baseline });
    drawTextRight(page, row.value, { font: f.medium, size: sm.valueSize }, { right: sm.valueRight * KX, baselineTop: baseline });
  });
  drawHLine(page, sm.ruleX[0] * KX, sm.ruleX[1] * KX, cardTop + top(rulePx), COLORS.rule, 1);
  const totalBaseline = bandTop + top(sm.bandBaseline);
  drawText(page, "ИТОГО К ОПЛАТЕ", { font: f.extrabold, size: sm.totalSize }, { x: sm.totalLabelX * KX, baselineTop: totalBaseline });
  drawTextRight(page, formatAmount(totals.total), { font: f.extrabold, size: sm.totalSize }, { right: sm.totalRight * KX, baselineTop: totalBaseline, maxWidth: (sm.totalRight - sm.bandX0 - 60) * KX });

  // Примечания (следуют за блоком итогов).
  const n = LAYOUT.notes;
  const cardBottom = cardTop + cardHeight;
  drawText(page, "Примечания:", { font: f.regular, size: n.size }, { x: n.x * KX, baselineTop: cardBottom + top(n.headingOffset) });
  [
    "Срок выполнения работ согласовывается отдельно.",
    "Гарантия на выполненные работы и материалы предоставляется.",
    "Используются только сертифицированные материалы и профессиональное оборудование.",
  ].forEach((line, index) => {
    const baseline = cardBottom + top(n.lineOffsets[index]);
    page.drawCircle({ x: (n.x + 2.2) * KX, y: pdfY(baseline - 0.33 * n.size), size: 1.15, color: COLORS.muted });
    drawText(page, line, { font: f.regular, size: n.size, color: COLORS.muted }, { x: n.textX * KX, baselineTop: baseline });
  });

  // Подписи — внизу страницы, как в MASTER.
  const sg = LAYOUT.signatures;
  drawVLine(page, sg.separator.x * KX, top(sg.separator.y0), top(sg.separator.y1), COLORS.frame, 0.7);
  const subStyle = { font: f.regular, size: sg.subSize, color: COLORS.soft };
  sg.blocks.forEach((block, index) => {
    if (index === 0) drawText(page, "Заказчик", { font: f.semibold, size: sg.labelSize }, { x: block.x * KX, baselineTop: top(sg.labelBaseline) });
    else {
      const width = drawText(page, "Исполнитель", { font: f.semibold, size: sg.labelSize }, { x: block.x * KX, baselineTop: top(sg.labelBaseline) });
      drawText(page, " (DriveSet)", { font: f.regular, size: sg.labelSize }, { x: block.x * KX + width, baselineTop: top(sg.labelBaseline) });
    }
    drawHLine(page, block.lineX0 * KX, block.lineX1 * KX, top(sg.lineY), COLORS.signature, 0.8);
    drawHLine(page, block.dateX0 * KX, block.dateX1 * KX, top(sg.lineY), COLORS.signature, 0.8);
    drawText(page, "ФИО / подпись", subStyle, { x: block.x * KX, baselineTop: top(sg.subBaseline) });
    drawText(page, "Дата", subStyle, { x: block.dateX0 * KX, baselineTop: top(sg.subBaseline) });
  });

  // Старые просмотрщики и установленный в проекте Ghostscript надёжнее
  // обрабатывают классическую таблицу xref, чем object streams PDF 1.7.
  return pdf.save({ useObjectStreams: false });
}

function gradientAt(xPx: number): [number, number, number] {
  for (let i = 1; i < BAND_STOPS.length; i++) {
    const [x1, r1, g1, b1] = BAND_STOPS[i];
    const [x0, r0, g0, b0] = BAND_STOPS[i - 1];
    if (xPx <= x1) {
      const k = (xPx - x0) / (x1 - x0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  const last = BAND_STOPS[BAND_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

export async function saveDriveSetOrderPdf(
  data: DriveSetOrderData,
  outputPath: string,
): Promise<DriveSetOrderTotals> {
  const pdfBytes = await generateDriveSetOrderPdf(data);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, pdfBytes);
  return calculateDriveSetOrderTotals(data.services, data.discountPercent ?? 0);
}

export { LAYOUT as DRIVESET_ORDER_LAYOUT, MAX_SERVICE_ROWS as DRIVESET_MAX_SERVICE_ROWS, KX as DRIVESET_PX_X, KY as DRIVESET_PX_Y };
