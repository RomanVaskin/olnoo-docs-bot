import fs from "node:fs";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import sharp from "sharp";

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "driveset-order.pdf");

const REGULAR_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const BOLD_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const MAX_SERVICE_ROWS = 7;

const DRIVESET_PHONE = "+7 985 125-75-85";

const COORDINATES = {
  orderNumber: { x: 48, y: 645, width: 160, size: 10 },
  date: { x: 60, y: 625, width: 148, size: 9 },
  carImage: { x: 283, y: 581, width: 282, height: 116 },
  // Значения подняты над линиями полей (линия на y≈520.5), подписи и линии шаблона не двигаются.
  makeModel: { x: 41, y: 525.5, width: 135, size: 8.5 },
  year: { x: 192, y: 525.5, width: 84, size: 8.5 },
  mileage: { x: 310, y: 525.5, width: 136, size: 8.5 },
  // Третья строка контактов шапки: тот же x и кегль, что у адреса и @driveset, шаг строк 23 pt.
  phone: { x: 364, y: 739.9, width: 192, size: 9.5 },
  serviceRows: [
    460.5,
    427.5,
    394.5,
    361.5,
    328.5,
    295.5,
    262.5,
  ],
  serviceNumber: { x: 29, width: 43, size: 8 },
  serviceName: { x: 82, width: 365, size: 8.5 },
  serviceCost: { x: 457, width: 94, size: 8.5 },
  paidWorksCost: { right: 550, y: 213, size: 9 },
  // «Скидка» уже в шаблоне; шаблонное «(%)» (x 82–95) закрывается белым и вместо него печатается «15%».
  discountPercent: { x: 84, y: 191, width: 60, size: 10 },
  discountPercentCover: { x: 81, y: 189, width: 17, height: 11 },
  discountAmount: { right: 550, y: 191, size: 9 },
  total: { right: 550, y: 147, size: 14 },
} as const;

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

function formatDate(value: string | Date): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Не указана дата заказ-наряда");
    return trimmed;
  }
  if (Number.isNaN(value.getTime())) throw new Error("Некорректная дата заказ-наряда");
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(value);
}

function formatAmount(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)} ₽`;
}

function drawTextFit(
  page: PDFPage,
  text: string,
  font: PDFFont,
  options: { x: number; y: number; width: number; size: number; minSize?: number },
): void {
  let size = options.size;
  const minSize = options.minSize ?? 5;
  while (size > minSize && font.widthOfTextAtSize(text, size) > options.width) size -= 0.2;
  page.drawText(text, { x: options.x, y: options.y, size, font, color: rgb(0.08, 0.08, 0.08) });
}

function drawTextRight(
  page: PDFPage,
  text: string,
  font: PDFFont,
  options: { right: number; y: number; size: number },
): void {
  const width = font.widthOfTextAtSize(text, options.size);
  page.drawText(text, {
    x: options.right - width,
    y: options.y,
    size: options.size,
    font,
    color: rgb(0.08, 0.08, 0.08),
  });
}

async function drawCarImage(page: PDFPage, pdf: PDFDocument, imageBytes: Uint8Array): Promise<void> {
  const pngBytes = await sharp(Buffer.from(imageBytes)).rotate().png().toBuffer();
  const image = await pdf.embedPng(pngBytes);
  const box = COORDINATES.carImage;
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  page.drawImage(image, {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  });
}

/**
 * Загружает фирменный мастер-шаблон DriveSet и наносит на него только
 * динамические данные заказ-наряда.
 */
export async function generateDriveSetOrderPdf(data: DriveSetOrderData): Promise<Uint8Array> {
  validateOrder(data);
  assertRequiredFile(TEMPLATE_PATH, "Мастер-шаблон DriveSet");
  assertRequiredFile(REGULAR_FONT_PATH, "Шрифт DejaVu Sans");
  assertRequiredFile(BOLD_FONT_PATH, "Шрифт DejaVu Sans Bold");

  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const template = await PDFDocument.load(templateBytes);
  if (template.getPageCount() !== 1) {
    throw new Error("Мастер-шаблон DriveSet должен содержать одну страницу");
  }

  // Шаблон становится неизменяемым фоновым слоем. Так его XObject-ресурсы
  // (логотип и иконки) не конфликтуют с добавляемым изображением автомобиля.
  const pdf = await PDFDocument.create();
  const [background] = await pdf.embedPdf(templateBytes, [0]);
  const page = pdf.addPage([background.width, background.height]);
  page.drawPage(background, {
    x: 0,
    y: 0,
    width: background.width,
    height: background.height,
  });

  pdf.registerFontkit(fontkit);
  const [regularFont, boldFont] = await Promise.all([
    pdf.embedFont(fs.readFileSync(REGULAR_FONT_PATH), { subset: true }),
    pdf.embedFont(fs.readFileSync(BOLD_FONT_PATH), { subset: true }),
  ]);
  const totals = calculateDriveSetOrderTotals(data.services, data.discountPercent ?? 0);

  drawTextFit(page, data.orderNumber.trim(), boldFont, COORDINATES.orderNumber);
  drawTextFit(page, formatDate(data.date), regularFont, COORDINATES.date);
  drawTextFit(page, DRIVESET_PHONE, regularFont, COORDINATES.phone);
  await drawCarImage(page, pdf, data.carImage);
  drawTextFit(page, data.makeModel.trim(), regularFont, COORDINATES.makeModel);
  drawTextFit(page, String(data.year).trim(), regularFont, COORDINATES.year);
  drawTextFit(page, String(data.mileage).trim(), regularFont, COORDINATES.mileage);

  data.services.forEach((service, index) => {
    const y = COORDINATES.serviceRows[index];
    drawTextFit(page, String(index + 1), regularFont, { ...COORDINATES.serviceNumber, y });
    drawTextFit(page, service.name.trim(), regularFont, { ...COORDINATES.serviceName, y });
    drawTextFit(
      page,
      service.gift ? "В подарок" : formatAmount(service.price ?? 0),
      service.gift ? boldFont : regularFont,
      { ...COORDINATES.serviceCost, y },
    );
  });

  drawTextRight(page, formatAmount(totals.paidWorksCost), boldFont, COORDINATES.paidWorksCost);
  const cover = COORDINATES.discountPercentCover;
  page.drawRectangle({ x: cover.x, y: cover.y, width: cover.width, height: cover.height, color: rgb(1, 1, 1) });
  drawTextFit(page, `${totals.discountPercent}%`, regularFont, COORDINATES.discountPercent);
  drawTextRight(
    page,
    totals.discountAmount > 0 ? `− ${formatAmount(totals.discountAmount)}` : formatAmount(0),
    boldFont,
    COORDINATES.discountAmount,
  );
  drawTextRight(page, formatAmount(totals.total), boldFont, COORDINATES.total);

  // Старые просмотрщики и установленный в проекте Ghostscript надёжнее
  // обрабатывают классическую таблицу xref, чем object streams PDF 1.7.
  return pdf.save({ useObjectStreams: false });
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

export { COORDINATES as DRIVESET_ORDER_COORDINATES, MAX_SERVICE_ROWS as DRIVESET_MAX_SERVICE_ROWS };
