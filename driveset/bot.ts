import fs from "node:fs";

import { Bot, Context, InlineKeyboard, InputFile, Keyboard } from "grammy";

import { calculateDriveSetOrderTotals, type DriveSetService } from "../services/driveset-order.js";
import { CarImageGenerationError } from "./car-images.js";
import { DriveSetDocumentService, type DriveSetDraft } from "./documents.js";

type Step = "idle" | "orderNumber" | "makeModel" | "year" | "mileage" | "serviceName" | "servicePrice" | "discount" | "preview";

type Session = Partial<DriveSetDraft> & {
  step: Step;
  currentServiceName?: string;
  reservedDocumentId?: number;
  generating?: boolean;
};

function mainKeyboard(): Keyboard {
  return new Keyboard()
    .text("Создать документ")
    .row()
    .text("История документов")
    .resized();
}

function documentTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Заказ-наряд", "ds:type:order");
}

function priceKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("В подарок", "ds:price:gift");
}

function servicesKeyboard(count: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (count < 7) keyboard.text("Добавить услугу", "ds:services:add").row();
  return keyboard.text("Далее", "ds:services:next");
}

function discountKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Без скидки", "ds:discount:none");
}

function previewKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Сформировать", "ds:generate")
    .row()
    .text("Начать заново", "ds:restart");
}

function fallbackKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Сформировать без изображения", "ds:generate:no-image")
    .row()
    .text("Начать заново", "ds:restart");
}

function formatAmount(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} ₽`;
}

function parseMoney(text: string): number | null {
  const normalized = text.replace(/[\s₽]/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseDiscount(text: string): number | null {
  const normalized = text.trim().replace(/%$/, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function draftFrom(session: Session): DriveSetDraft {
  if (!session.displayNumber || !session.makeModel || !session.vehicleYear || !session.mileage || !session.services?.length) {
    throw new Error("Черновик заказ-наряда заполнен не полностью");
  }
  return {
    displayNumber: session.displayNumber,
    makeModel: session.makeModel,
    vehicleYear: session.vehicleYear,
    mileage: session.mileage,
    services: session.services,
    discountPercent: session.discountPercent ?? 0,
  };
}

function previewText(draft: DriveSetDraft): string {
  const totals = calculateDriveSetOrderTotals(draft.services, draft.discountPercent);
  const services = draft.services.map((service, index) =>
    `${index + 1}. ${service.name} — ${service.gift ? "В подарок" : formatAmount(service.price ?? 0)}`,
  );
  return [
    "Предпросмотр заказ-наряда",
    "",
    `Номер заказ-наряда: № ${draft.displayNumber}`,
    `Автомобиль: ${draft.makeModel}`,
    `Год: ${draft.vehicleYear}`,
    `Пробег: ${draft.mileage}`,
    "",
    ...services,
    "",
    `Стоимость платных работ: ${formatAmount(totals.paidWorksCost)}`,
    `Скидка: ${draft.discountPercent}% (− ${formatAmount(totals.discountAmount)})`,
    `Итого к оплате: ${formatAmount(totals.total)}`,
  ].join("\n");
}

async function showMain(ctx: Context, sessions: Map<number, Session>): Promise<void> {
  if (ctx.from) sessions.set(ctx.from.id, { step: "idle" });
  await ctx.reply("DriveSet Docs Bot\n\nВыберите действие:", { reply_markup: mainKeyboard() });
}

export function createDriveSetBot(
  token: string,
  documents: DriveSetDocumentService,
  options: NonNullable<ConstructorParameters<typeof Bot>[1]> = {},
): Bot {
  const bot = new Bot(token, options);
  const sessions = new Map<number, Session>();

  bot.command("start", ctx => showMain(ctx, sessions));
  bot.command("menu", ctx => showMain(ctx, sessions));

  bot.hears("Создать документ", async ctx => {
    if (!ctx.from) return;
    sessions.set(ctx.from.id, { step: "idle" });
    await ctx.reply("Выберите тип документа:", { reply_markup: documentTypeKeyboard() });
  });

  bot.hears("История документов", async ctx => {
    if (!ctx.from) return;
    const history = documents.storage.listUserDocuments(String(ctx.from.id));
    if (history.length === 0) {
      await ctx.reply("История документов пока пуста.", { reply_markup: mainKeyboard() });
      return;
    }
    const keyboard = new InlineKeyboard();
    history.forEach(item => keyboard.text(`${item.displayNumber ?? item.orderNumber} · ${item.makeModel}`, `ds:history:${item.id}`).row());
    await ctx.reply("Последние заказ-наряды:", { reply_markup: keyboard });
  });

  bot.callbackQuery("ds:type:order", async ctx => {
    sessions.set(ctx.from.id, { step: "orderNumber", services: [] });
    await ctx.answerCallbackQuery();
    await ctx.reply("Введите номер заказ-наряда");
  });

  bot.callbackQuery("ds:price:gift", async ctx => {
    const session = sessions.get(ctx.from.id);
    if (!session || session.step !== "servicePrice" || !session.currentServiceName) return ctx.answerCallbackQuery();
    session.services ??= [];
    session.services.push({ name: session.currentServiceName, gift: true });
    session.currentServiceName = undefined;
    session.step = "idle";
    await ctx.answerCallbackQuery();
    await ctx.reply("Услуга добавлена. Добавить ещё одну или перейти далее?", {
      reply_markup: servicesKeyboard(session.services.length),
    });
  });

  bot.callbackQuery("ds:services:add", async ctx => {
    const session = sessions.get(ctx.from.id);
    if (!session) return ctx.answerCallbackQuery();
    session.step = "serviceName";
    await ctx.answerCallbackQuery();
    await ctx.reply("Введите наименование следующей услуги:");
  });

  bot.callbackQuery("ds:services:next", async ctx => {
    const session = sessions.get(ctx.from.id);
    if (!session?.services?.length) {
      await ctx.answerCallbackQuery({ text: "Добавьте хотя бы одну услугу" });
      return;
    }
    session.step = "discount";
    await ctx.answerCallbackQuery();
    await ctx.reply("Введите скидку в процентах:", { reply_markup: discountKeyboard() });
  });

  bot.callbackQuery("ds:discount:none", async ctx => {
    const session = sessions.get(ctx.from.id);
    if (!session) return ctx.answerCallbackQuery();
    session.discountPercent = 0;
    session.step = "preview";
    await ctx.answerCallbackQuery();
    await ctx.reply(previewText(draftFrom(session)), { reply_markup: previewKeyboard() });
  });

  bot.callbackQuery("ds:restart", async ctx => {
    await ctx.answerCallbackQuery();
    await showMain(ctx, sessions);
  });

  const generate = async (ctx: Context, withImage: boolean): Promise<void> => {
    if (!ctx.from || !ctx.chat) return;
    const session = sessions.get(ctx.from.id);
    if (!session || session.generating) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Документ уже формируется" });
      return;
    }
    session.generating = true;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(withImage ? "Формирую заказ-наряд и изображение автомобиля…" : "Формирую заказ-наряд без изображения…");
    try {
      let documentId = session.reservedDocumentId;
      if (!documentId) {
        const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || null;
        const reserved = documents.reserve(draftFrom(session), {
          id: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          username: ctx.from.username ?? null,
          name: userName,
        });
        documentId = reserved.id;
        session.reservedDocumentId = documentId;
      }
      const result = await documents.generate(documentId, withImage);
      if (!result.pdfPath || !fs.existsSync(result.pdfPath)) throw new Error("Готовый PDF не найден");
      await ctx.replyWithDocument(new InputFile(result.pdfPath, `${result.orderNumber}.pdf`), {
        caption: `${result.displayNumber ?? result.orderNumber} · ${result.makeModel} ${result.vehicleYear}`,
      });
      sessions.set(ctx.from.id, { step: "idle" });
      await ctx.reply("Документ готов.", { reply_markup: mainKeyboard() });
    } catch (error) {
      session.generating = false;
      if (withImage && error instanceof CarImageGenerationError) {
        await ctx.reply("Не удалось получить изображение автомобиля от Router.", {
          reply_markup: fallbackKeyboard(),
        });
        return;
      }
      console.error("DriveSet document generation failed", error);
      await ctx.reply("Не удалось сформировать документ. Попробуйте ещё раз.", {
        reply_markup: withImage ? previewKeyboard() : fallbackKeyboard(),
      });
    }
  };

  bot.callbackQuery("ds:generate", ctx => generate(ctx, true));
  bot.callbackQuery("ds:generate:no-image", ctx => generate(ctx, false));

  bot.callbackQuery(/^ds:history:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    const document = documents.storage.getDocument(id);
    if (document.telegramUserId !== String(ctx.from.id) || !document.pdfPath || !fs.existsSync(document.pdfPath)) {
      await ctx.reply("Документ не найден.");
      return;
    }
    await ctx.replyWithDocument(new InputFile(document.pdfPath, `${document.orderNumber}.pdf`));
  });

  bot.on("message:text", async ctx => {
    if (ctx.message.text.startsWith("/")) return;
    const session = sessions.get(ctx.from.id);
    if (!session) return;
    const text = ctx.message.text.trim();
    if (!text) return;

    if (session.step === "orderNumber") {
      if (text.length > 30) {
        await ctx.reply("Номер заказ-наряда слишком длинный (не более 30 символов).");
        return;
      }
      session.displayNumber = text;
      session.step = "makeModel";
      await ctx.reply("Введите марку и модель автомобиля:");
      return;
    }
    if (session.step === "makeModel") {
      session.makeModel = text;
      session.step = "year";
      await ctx.reply("Введите год выпуска автомобиля:");
      return;
    }
    if (session.step === "year") {
      const year = Number(text);
      const maxYear = new Date().getUTCFullYear() + 1;
      if (!/^\d{4}$/.test(text) || year < 1886 || year > maxYear) {
        await ctx.reply(`Введите корректный год от 1886 до ${maxYear}.`);
        return;
      }
      session.vehicleYear = year;
      session.step = "mileage";
      await ctx.reply("Введите пробег автомобиля:");
      return;
    }
    if (session.step === "mileage") {
      if (text.length > 40) {
        await ctx.reply("Пробег указан слишком длинно.");
        return;
      }
      session.mileage = text;
      session.step = "serviceName";
      await ctx.reply("Введите наименование услуги:");
      return;
    }
    if (session.step === "serviceName") {
      session.currentServiceName = text;
      session.step = "servicePrice";
      await ctx.reply("Введите стоимость услуги или выберите «В подарок»:", { reply_markup: priceKeyboard() });
      return;
    }
    if (session.step === "servicePrice") {
      const price = parseMoney(text);
      if (price === null) {
        await ctx.reply("Введите стоимость числом, например 25000, или выберите «В подарок».", {
          reply_markup: priceKeyboard(),
        });
        return;
      }
      if (!session.currentServiceName) return;
      session.services ??= [];
      session.services.push({ name: session.currentServiceName, price });
      session.currentServiceName = undefined;
      session.step = "idle";
      await ctx.reply("Услуга добавлена. Добавить ещё одну или перейти далее?", {
        reply_markup: servicesKeyboard(session.services.length),
      });
      return;
    }
    if (session.step === "discount") {
      const discount = parseDiscount(text);
      if (discount === null) {
        await ctx.reply("Введите скидку числом от 0 до 100.", { reply_markup: discountKeyboard() });
        return;
      }
      session.discountPercent = discount;
      session.step = "preview";
      await ctx.reply(previewText(draftFrom(session)), { reply_markup: previewKeyboard() });
    }
  });

  bot.catch(error => {
    console.error("DriveSet Docs bot error", error.error);
  });

  return bot;
}

export { parseDiscount, parseMoney, previewText };
