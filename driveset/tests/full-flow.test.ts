import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { calculateDriveSetOrderTotals } from "../../services/driveset-order.js";
import { createDriveSetBot } from "../bot.js";
import { DriveSetCarImageService } from "../car-images.js";
import { DriveSetDocumentService } from "../documents.js";
import { DriveSetStorage } from "../storage.js";

const BOT_INFO = {
  id: 999,
  is_bot: true as const,
  first_name: "DriveSet Docs",
  username: "driveset_docs_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

type ApiCall = { method: string; payload: Record<string, unknown> };

function createHarness(documents: DriveSetDocumentService) {
  const calls: ApiCall[] = [];
  const bot = createDriveSetBot("999:TEST_TOKEN", documents, { botInfo: BOT_INFO });
  let messageId = 100;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
    return {
      ok: true,
      result: {
        message_id: messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1001, type: "private", first_name: "Тест" },
        from: BOT_INFO,
        text: typeof (payload as { text?: unknown }).text === "string"
          ? (payload as { text: string }).text
          : undefined,
      },
    } as never;
  });

  let updateId = 1;
  let incomingMessageId = 1;
  const user = { id: 1001, is_bot: false as const, first_name: "Иван", username: "ivan" };
  const chat = { id: 1001, type: "private" as const, first_name: "Иван" };

  const text = async (value: string): Promise<void> => {
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: incomingMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: user,
        text: value,
        ...(value.startsWith("/") ? { entities: [{ offset: 0, length: value.length, type: "bot_command" as const }] } : {}),
      },
    });
  };

  const callback = async (data: string): Promise<void> => {
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: "test-chat",
        from: user,
        data,
        message: {
          message_id: incomingMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: BOT_INFO,
          text: "button",
        },
      },
    });
  };

  return { bot, calls, text, callback };
}

async function enterGeelyOrder(
  harness: ReturnType<typeof createHarness>,
  discount = "15",
): Promise<void> {
  await harness.text("/start");
  await harness.text("Создать документ");
  await harness.callback("ds:type:order");
  await harness.text("114");
  await harness.text("Geely Monjaro");
  await harness.text("2022");
  await harness.text("65 000 км");
  await harness.text("Комплекс детейлинг-работ");
  await harness.text("355000");
  await harness.callback("ds:services:add");
  await harness.text("Чернение шин");
  await harness.callback("ds:price:gift");
  await harness.callback("ds:services:next");
  await harness.text(discount);
}

test("полный Telegram flow создаёт Geely Monjaro 2022, PDF и историю", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveset-flow-"));
  const storage = new DriveSetStorage(path.join(root, "driveset.db"));
  t.after(() => storage.close());

  const sourceImage = await sharp({
    create: { width: 1200, height: 700, channels: 3, background: { r: 85, g: 90, b: 95 } },
  }).png().toBuffer();
  let routerCalls = 0;
  const images = new DriveSetCarImageService({
    routerUrl: "http://router.test",
    routerToken: "router-token",
    cacheDir: path.join(root, "cars"),
    fetchImpl: async () => {
      routerCalls += 1;
      return new Response(JSON.stringify({
        imageBase64: sourceImage.toString("base64"),
        mimeType: "image/png",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const documents = new DriveSetDocumentService(storage, images, path.join(root, "exports"));
  const harness = createHarness(documents);

  await enterGeelyOrder(harness);
  const asked = harness.calls
    .filter(call => call.method === "sendMessage")
    .map(call => String(call.payload.text ?? ""));
  assert.ok(asked.includes("Введите номер заказ-наряда"), "первый вопрос — номер заказ-наряда");
  assert.ok(
    asked.indexOf("Введите номер заказ-наряда") < asked.indexOf("Введите марку и модель автомобиля:"),
    "номер спрашивается до данных автомобиля",
  );
  const preview = harness.calls
    .filter(call => call.method === "sendMessage")
    .map(call => String(call.payload.text ?? ""))
    .find(text => text.includes("Предпросмотр заказ-наряда"));
  assert.ok(preview?.includes("355 000 ₽"));
  assert.ok(preview?.includes("15%"));
  assert.ok(preview?.includes("301 750 ₽"));

  await harness.callback("ds:generate");

  const history = storage.listUserDocuments("1001");
  assert.equal(history.length, 1);
  assert.match(history[0].orderNumber, /^DS-\d{4}-0001$/);
  assert.equal(history[0].displayNumber, "114", "номер, введённый пользователем, сохраняется как есть");
  assert.equal(history[0].makeModel, "Geely Monjaro");
  assert.equal(history[0].vehicleYear, 2022);
  assert.equal(history[0].totals.paidWorksCost, 355000);
  assert.equal(history[0].totals.discountAmount, 53250);
  assert.equal(history[0].totals.total, 301750);
  assert.ok(history[0].pdfPath && fs.existsSync(history[0].pdfPath));
  assert.ok(history[0].imagePath && fs.existsSync(history[0].imagePath));
  assert.equal(routerCalls, 1);

  const pdf = await PDFDocument.load(fs.readFileSync(history[0].pdfPath!));
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 595.2756, height: 841.8898 });
  assert.ok(harness.calls.some(call => call.method === "sendDocument"));

  await harness.text("История документов");
  const historyMessage = harness.calls
    .filter(call => call.method === "sendMessage")
    .map(call => String(call.payload.text ?? ""))
    .find(text => text === "Последние заказ-наряды:");
  assert.equal(historyMessage, "Последние заказ-наряды:");

  const second = documents.reserve({
    displayNumber: "115",
    makeModel: "  geely   monjaro ",
    vehicleYear: 2022,
    mileage: "70 000 км",
    services: [{ name: "Мойка", price: 1000 }],
    discountPercent: 0,
  }, { id: "1001", chatId: "1001", username: null, name: null });
  await documents.generate(second.id, true);
  assert.equal(routerCalls, 1, "одинаковые модель и год должны использовать кэш");
});

test("при недоступном Router flow предлагает и формирует PDF без изображения", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveset-fallback-"));
  const storage = new DriveSetStorage(path.join(root, "driveset.db"));
  t.after(() => storage.close());
  const images = new DriveSetCarImageService({
    routerUrl: "http://router.test",
    routerToken: "router-token",
    cacheDir: path.join(root, "cars"),
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  const documents = new DriveSetDocumentService(storage, images, path.join(root, "exports"));
  const harness = createHarness(documents);

  await enterGeelyOrder(harness, "0");
  await harness.callback("ds:generate");
  assert.ok(harness.calls.some(call =>
    call.method === "sendMessage" && String(call.payload.text).includes("Не удалось получить изображение"),
  ));
  await harness.callback("ds:generate:no-image");

  const history = storage.listUserDocuments("1001");
  assert.equal(history.length, 1);
  assert.ok(history[0].pdfPath && fs.existsSync(history[0].pdfPath));
  assert.equal(history[0].imagePath, null);
  assert.ok(harness.calls.some(call => call.method === "sendDocument"));
});

test("годовая нумерация независима по годам и расчёт скидки точен", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveset-numbering-"));
  const storage = new DriveSetStorage(path.join(root, "driveset.db"));
  try {
    const totals = calculateDriveSetOrderTotals([{ name: "Работы", price: 355000 }], 15);
    assert.deepEqual(totals, {
      paidWorksCost: 355000,
      discountPercent: 15,
      discountAmount: 53250,
      total: 301750,
    });
    const base = {
      telegramUserId: "1",
      telegramChatId: "1",
      telegramUsername: null,
      telegramName: null,
      displayNumber: "1",
      makeModel: "Geely Monjaro",
      vehicleYear: 2022,
      mileage: "1 км",
      services: [{ name: "Работы", price: 355000 }],
      discountPercent: 15,
      totals,
    };
    assert.equal(storage.reserveDocument({ ...base, now: new Date("2026-01-01T00:00:00Z") }).orderNumber, "DS-2026-0001");
    assert.equal(storage.reserveDocument({ ...base, now: new Date("2026-12-31T23:59:59Z") }).orderNumber, "DS-2026-0002");
    assert.equal(storage.reserveDocument({ ...base, now: new Date("2027-01-01T00:00:00Z") }).orderNumber, "DS-2027-0001");
  } finally {
    storage.close();
  }
});
