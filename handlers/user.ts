import {
  Bot,
  Context,
  InlineKeyboard,
  InputFile,
  Keyboard,
} from "grammy";

import { config } from "../config.js";

import type {
  ApplicationType,
  PassportData,
  PolicyPeriod,
} from "../types.js";

import {
  addParticipant,
  createApplication,
  getApplicationById,
  listApplicationParticipants,
  listUserApplications,
  setApplicationPeriod,
} from "../services/applications.js";

import {
  downloadTelegramFile,
  recognizePassport,
} from "../services/recognition.js";

import {
  getTournamentById,
  listActiveTournaments,
} from "../services/tournaments.js";

import {
  getUserByTelegramId,
  isValidEmail,
  setUserEmail,
  upsertUser,
} from "../services/users.js";

import {
  registerRealSuccessfulPayment,
  simulateSuccessfulPayment,
} from "../services/payments.js";

import {
  issuePolicy,
} from "../services/policies.js";

import {
  createYooKassaPayment,
  getYooKassaPayment,
} from "../services/yookassa.js";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

type UserSession = {
  applicationType?: ApplicationType;
  tournamentId?: number;
  applicationId?: number;
  currentPassport?: PassportData;
  waitingForEmail?: boolean;
};

const sessions =
  new Map<
    number,
    UserSession
  >();

// ---------------------------------------------------------------------
// KEYBOARDS
// ---------------------------------------------------------------------

function userMainKeyboard():
  Keyboard {
  return new Keyboard()
    .text("📄 Оформить страховку")
    .row()
    .text("📋 Мои заявки")
    .row()
    .text("📧 Мой email")
    .row()
    .text("ℹ️ Помощь")
    .resized();
}

function applicationTypeKeyboard():
  InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "👤 Один участник",
      "user:type:individual"
    )
    .row()
    .text(
      "👥 Несколько участников",
      "user:type:group"
    )
    .row()
    .text(
      "⬅️ Назад",
      "user:main"
    );
}

function periodKeyboard(
  applicationId: number
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "1 день — 100 ₽",
      `user:period:${applicationId}:day`
    )
    .row()
    .text(
      "1 месяц — 200 ₽",
      `user:period:${applicationId}:month`
    )
    .row()
    .text(
      "1 год — 500 ₽",
      `user:period:${applicationId}:year`
    );
}

function passportConfirmKeyboard():
  InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "✅ Всё верно",
      "user:passport:confirm"
    )
    .row()
    .text(
      "🔄 Загрузить заново",
      "user:passport:retry"
    )
    .row()
    .text(
      "❌ Отмена",
      "user:main"
    );
}

function groupContinueKeyboard(
  applicationId: number
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "➕ Добавить ещё участника",
      `user:group:add:${applicationId}`
    )
    .row()
    .text(
      "✅ Завершить загрузку",
      `user:group:finish:${applicationId}`
    );
}

function paymentKeyboard(
  applicationId: number
): InlineKeyboard {
  const testMode =
    process.env.PAYMENT_TEST_MODE === "true";

  return new InlineKeyboard()
    .text(
      testMode
        ? "✅ Оплачено"
        : "💳 Оплатить через ЮKassa",
      `user:yookassa:create:${applicationId}`
    );
}

// ---------------------------------------------------------------------
// FORMAT PASSPORT
// ---------------------------------------------------------------------

function formatPassport(
  data: PassportData
): string {
  return [
    "📄 Распознанные данные",
    "",
    `Фамилия: ${data.lastName || "—"}`,
    `Имя: ${data.firstName || "—"}`,
    `Отчество: ${data.middleName || "—"}`,
    "",
    `Дата рождения: ${data.birthDate || "—"}`,
    `Место рождения: ${data.birthPlace || "—"}`,
    `Пол: ${data.gender || "—"}`,
    "",
    `Серия: ${data.passportSeries || "—"}`,
    `Номер: ${data.passportNumber || "—"}`,
    "",
    `Дата выдачи: ${data.issueDate || "—"}`,
    `Кем выдан: ${data.issuedBy || "—"}`,
    `Код подразделения: ${data.departmentCode || "—"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------
// USER REGISTER
// ---------------------------------------------------------------------

function ensureUser(
  ctx: Context
): string | null {
  if (!ctx.from) {
    return null;
  }

  const telegramUserId =
    String(ctx.from.id);

  const telegramUsername =
    ctx.from.username || null;

  const telegramName =
    [
      ctx.from.first_name,
      ctx.from.last_name,
    ]
      .filter(Boolean)
      .join(" ") || null;

  upsertUser(
    telegramUserId,
    telegramUsername,
    telegramName
  );

  return telegramUserId;
}

// ---------------------------------------------------------------------
// MAIN MENU
// ---------------------------------------------------------------------

async function showMainMenu(
  ctx: Context
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  sessions.delete(
    ctx.from.id
  );

  await ctx.reply(
    [
      "🛡 OLNOO Страхование",
      "",
      "Выберите действие:",
    ].join("\n"),
    {
      reply_markup:
        userMainKeyboard(),
    }
  );
}

// ---------------------------------------------------------------------
// TOURNAMENTS
// ---------------------------------------------------------------------

async function showTournaments(
  ctx: Context
): Promise<void> {
  const tournaments =
    listActiveTournaments();

  if (
    tournaments.length === 0
  ) {
    await ctx.reply(
      "Сейчас нет активных турниров."
    );

    return;
  }

  const keyboard =
    new InlineKeyboard();

  for (
    const tournament
    of tournaments
  ) {
    const label =
      tournament.eventDate
        ? `${tournament.name} — ${tournament.eventDate}`
        : tournament.name;

    keyboard
      .text(
        label,
        `user:tournament:${tournament.id}`
      )
      .row();
  }

  keyboard.text(
    "⬅️ Назад",
    "user:main"
  );

  await ctx.reply(
    "🏆 Выберите турнир:",
    {
      reply_markup:
        keyboard,
    }
  );
}

// ---------------------------------------------------------------------
// START APPLICATION
// ---------------------------------------------------------------------

async function startApplication(
  ctx: Context,
  applicationType:
    ApplicationType
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  sessions.set(
    ctx.from.id,
    {
      applicationType,
    }
  );

  await showTournaments(
    ctx
  );
}

// ---------------------------------------------------------------------
// SELECT TOURNAMENT
// ---------------------------------------------------------------------

async function selectTournament(
  ctx: Context,
  tournamentId: number
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const telegramUserId =
    ensureUser(ctx);

  if (!telegramUserId) {
    return;
  }

  const session =
    sessions.get(
      ctx.from.id
    );

  if (
    !session?.applicationType
  ) {
    await ctx.reply(
      "Начните оформление заново."
    );

    return;
  }

  const tournament =
    getTournamentById(
      tournamentId
    );

  if (
    !tournament ||
    !tournament.isActive
  ) {
    await ctx.reply(
      "Этот турнир недоступен."
    );

    return;
  }

  const application =
    createApplication(
      telegramUserId,
      tournamentId,
      session.applicationType
    );

  sessions.set(
    ctx.from.id,
    {
      ...session,
      tournamentId,
      applicationId:
        application.id,
    }
  );

  await ctx.reply(
    [
      `🏆 Турнир: ${tournament.name}`,
      "",
      session.applicationType ===
      "individual"
        ? "👤 Загрузите паспорт участника."
        : "👥 Загрузите паспорт первого участника.",
      "",
      "Поддерживаются JPG, PNG, WEBP и PDF.",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// DOCUMENT UPLOAD
// ---------------------------------------------------------------------

async function handleDocumentUpload(
  ctx: Context
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const session =
    sessions.get(
      ctx.from.id
    );

  if (
    !session?.applicationId
  ) {
    await ctx.reply(
      "Сначала нажмите «📄 Оформить страховку»."
    );

    return;
  }

  let fileId:
    string | null = null;

  if (
    ctx.message?.photo?.length
  ) {
    fileId =
      ctx.message.photo[
        ctx.message.photo.length - 1
      ].file_id;
  }

  if (
    ctx.message?.document
  ) {
    fileId =
      ctx.message.document.file_id;
  }

  if (!fileId) {
    return;
  }

  const statusMessage =
    await ctx.reply(
      "🔍 Распознаю документ..."
    );

  try {
    const file =
      await downloadTelegramFile(
        ctx.api,
        fileId
      );

    const passport =
      await recognizePassport(
        file.buffer,
        file.mimeType,
        file.filename
      );

    sessions.set(
      ctx.from.id,
      {
        ...session,
        currentPassport:
          passport,
      }
    );

    if (!ctx.chat) {
      return;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      formatPassport(
        passport
      ),
      {
        reply_markup:
          passportConfirmKeyboard(),
      }
    );
  } catch (error) {
    console.error(
      "Document recognition error:",
      error
    );

    if (!ctx.chat) {
      return;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `❌ ${error instanceof Error ? error.message : "Не удалось распознать документ."}`
    );
  }
}

// ---------------------------------------------------------------------
// CONFIRM PASSPORT
// ---------------------------------------------------------------------

async function confirmPassport(
  ctx: Context
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const session =
    sessions.get(
      ctx.from.id
    );

  if (
    !session?.applicationId ||
    !session.currentPassport
  ) {
    await ctx.answerCallbackQuery({
      text:
        "Данные не найдены",
    });

    return;
  }

  addParticipant(
    session.applicationId,
    session.currentPassport
  );

  const application =
    getApplicationById(
      session.applicationId
    );

  if (!application) {
    throw new Error(
      "Заявка не найдена"
    );
  }

  sessions.set(
    ctx.from.id,
    {
      ...session,
      currentPassport:
        undefined,
    }
  );

  await ctx.answerCallbackQuery();

  if (
    application.applicationType ===
    "individual"
  ) {
    await ctx.editMessageText(
      [
        "✅ Данные участника сохранены.",
        "",
        "Выберите период страхования:",
      ].join("\n"),
      {
        reply_markup:
          periodKeyboard(
            application.id
          ),
      }
    );

    return;
  }

  const participants =
    listApplicationParticipants(
      application.id
    );

  await ctx.editMessageText(
    [
      "✅ Участник добавлен.",
      "",
      `Сейчас участников: ${participants.length}`,
    ].join("\n"),
    {
      reply_markup:
        groupContinueKeyboard(
          application.id
        ),
    }
  );
}

// ---------------------------------------------------------------------
// GROUP FINISH
// ---------------------------------------------------------------------

async function finishGroup(
  ctx: Context,
  applicationId: number
): Promise<void> {
  const participants =
    listApplicationParticipants(
      applicationId
    );

  if (
    participants.length < 2
  ) {
    await ctx.answerCallbackQuery({
      text:
        "Для группового полиса нужно минимум 2 участника",
      show_alert:
        true,
    });

    return;
  }

  const lines =
    participants.map(
      (
        participant,
        index
      ) => {
        const fio =
          [
            participant.lastName,
            participant.firstName,
            participant.middleName,
          ]
            .filter(Boolean)
            .join(" ");

        return `${index + 1}. ${fio} — ${participant.birthDate}`;
      }
    );

  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    [
      "👥 Участники группы",
      "",
      ...lines,
      "",
      `Всего: ${participants.length}`,
      "",
      "Выберите период страхования:",
    ].join("\n"),
    {
      reply_markup:
        periodKeyboard(
          applicationId
        ),
    }
  );
}

// ---------------------------------------------------------------------
// PERIOD
// ---------------------------------------------------------------------

async function selectPeriod(
  ctx: Context,
  applicationId: number,
  period: PolicyPeriod
): Promise<void> {
  const application =
    setApplicationPeriod(
      applicationId,
      period
    );

  if (!ctx.from) {
    return;
  }

  const user =
    getUserByTelegramId(
      String(
        ctx.from.id
      )
    );

  await ctx.answerCallbackQuery();

  if (
    !user?.email
  ) {
    const session =
      sessions.get(
        ctx.from.id
      ) || {};

    sessions.set(
      ctx.from.id,
      {
        ...session,
        applicationId,
        waitingForEmail:
          true,
      }
    );

    await ctx.editMessageText(
      [
        "📧 Перед оплатой нужен ваш email.",
        "",
        "Он понадобится для электронного чека.",
        "",
        "Отправьте email обычным сообщением.",
      ].join("\n")
    );

    return;
  }

  await showPayment(
    ctx,
    application.id
  );
}

// ---------------------------------------------------------------------
// SHOW PAYMENT
// ---------------------------------------------------------------------

async function showPayment(
  ctx: Context,
  applicationId: number
): Promise<void> {
  const application =
    getApplicationById(
      applicationId
    );

  if (!application) {
    throw new Error(
      "Заявка не найдена"
    );
  }

  const periodLabel =
    application.policyPeriod ===
    "day"
      ? "1 день"
      : application.policyPeriod ===
        "month"
      ? "1 месяц"
      : "1 год";

  await ctx.reply(
    [
      "💳 Оплата",
      "",
      `Участников: ${application.participantsCount}`,
      `Период: ${periodLabel}`,
      `Цена за человека: ${application.pricePerPerson} ₽`,
      "",
      `Итого: ${application.totalAmount} ₽`,
      "",
      process.env.PAYMENT_TEST_MODE === "true"
        ? "Тестовый режим: нажмите «✅ Оплачено»."
        : "Оплата через ЮKassa:",
    ].join("\n"),
    {
      reply_markup:
        paymentKeyboard(
          application.id
        ),
    }
  );
}

// ---------------------------------------------------------------------
// CREATE YOOKASSA PAYMENT
// ---------------------------------------------------------------------

async function startYooKassaPayment(
  ctx: Context,
  applicationId: number
): Promise<void> {
  try {
    const application =
      getApplicationById(
        applicationId
      );

    if (!application) {
      throw new Error(
        "Заявка не найдена"
      );
    }

    if (
      application.totalAmount <= 0
    ) {
      throw new Error(
        "Некорректная сумма заявки"
      );
    }

    if (
      process.env.PAYMENT_TEST_MODE ===
      "true"
    ) {
      const payment =
        simulateSuccessfulPayment(
          applicationId
        );

      await ctx.answerCallbackQuery({
        text:
          "Оплата подтверждена",
      });

      await ctx.editMessageText(
        [
          "✅ Оплата получена",
          "",
          `Сумма: ${payment.amount} ₽`,
          "",
          "⏳ Формирую полис...",
        ].join("\n")
      );

      const policy =
        await issuePolicy(
          applicationId
        );

      await ctx.replyWithDocument(
        new InputFile(
          policy.filePath
        ),
        {
          caption: [
            "✅ Полис оформлен",
            "",
            `Номер: ${policy.policyNumber}`,
            `Участников: ${policy.participantsCount}`,
            `Начало: ${payment.policyStartDate}`,
            `Окончание: ${payment.policyEndDate}`,
          ].join("\n"),
        }
      );

      await sendPolicyCopyToManager(
        ctx,
        applicationId,
        policy,
        payment.policyStartDate,
        payment.policyEndDate
      );

      if (ctx.from) {
        sessions.delete(
          ctx.from.id
        );
      }

      await ctx.reply(
        "Готово. Полис сохранён в разделе «📋 Мои заявки».",
        {
          reply_markup:
            userMainKeyboard(),
        }
      );

      return;
    }

    const user =
      ctx.from
        ? getUserByTelegramId(
            String(
              ctx.from.id
            )
          )
        : null;

    const payment =
      await createYooKassaPayment({
        applicationId,
        amount:
          application.totalAmount,
        email:
          user?.email || null,
      });

    const keyboard =
      new InlineKeyboard()
        .url(
          "💳 Перейти к оплате",
          payment.confirmationUrl
        )
        .row()
        .text(
          "✅ Проверить оплату",
          `user:yookassa:check:${applicationId}:${payment.paymentId}`
        );

    await ctx.answerCallbackQuery({
      text:
        "Платёж создан",
    });

    await ctx.editMessageText(
      [
        "💳 Платёж ЮKassa создан",
        "",
        `Сумма: ${payment.amount} ₽`,
        "",
        "1. Нажмите «Перейти к оплате».",
        "2. Завершите тестовую оплату.",
        "3. Вернитесь в Telegram.",
        "4. Нажмите «Проверить оплату».",
      ].join("\n"),
      {
        reply_markup:
          keyboard,
      }
    );
  } catch (error) {
    console.error(
      "YooKassa create payment error:",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : "Неизвестная ошибка";

    try {
      await ctx.answerCallbackQuery({
        text:
          "Ошибка создания платежа",
        show_alert:
          true,
      });
    } catch {
      // ignore
    }

    await ctx.reply(
      `❌ Не удалось создать платёж.\n\n${message}`
    );
  }
}

// ---------------------------------------------------------------------
// SEND POLICY COPY TO MANAGER
// ---------------------------------------------------------------------

async function sendPolicyCopyToManager(
  ctx: Context,
  applicationId: number,
  policy: {
    policyNumber: string;
    policyType:
      | "individual"
      | "group";
    filePath: string;
    participantsCount: number;
  },
  policyStartDate: string | null,
  policyEndDate: string | null
): Promise<void> {
  try {
    const application =
      getApplicationById(
        applicationId
      );

    const tournament =
      application
        ? getTournamentById(
            application.tournamentId
          )
        : null;

    const userLabel =
      ctx.from?.username
        ? `@${ctx.from.username}`
        : ctx.from
          ? [
              ctx.from.first_name,
              ctx.from.last_name,
            ]
              .filter(Boolean)
              .join(" ")
          : "неизвестно";

    await ctx.api.sendDocument(
      config.managerChatId,
      new InputFile(
        policy.filePath
      ),
      {
        caption: [
          "🛡 Новый выданный полис",
          "",
          `Номер: ${policy.policyNumber}`,
          `Тип: ${
            policy.policyType ===
            "individual"
              ? "VI — индивидуальный"
              : "VK — групповой"
          }`,
          `Заявка: #${applicationId}`,
          `Турнир: ${
            tournament?.name ||
            "—"
          }`,
          `Участников: ${policy.participantsCount}`,
          `Начало: ${policyStartDate || "—"}`,
          `Окончание: ${policyEndDate || "—"}`,
          `Пользователь: ${userLabel || "—"}`,
          ctx.from
            ? `Telegram ID: ${ctx.from.id}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      }
    );
  } catch (error) {
    console.error(
      "Manager policy copy error:",
      error
    );
  }
}

// ---------------------------------------------------------------------
// CHECK YOOKASSA PAYMENT + AUTOMATIC POLICY
// ---------------------------------------------------------------------

async function checkYooKassaPayment(
  ctx: Context,
  applicationId: number,
  paymentId: string
): Promise<void> {
  try {
    const status =
      await getYooKassaPayment(
        paymentId
      );

    if (
      status.status ===
      "canceled"
    ) {
      await ctx.answerCallbackQuery({
        text:
          "Платёж отменён",
        show_alert:
          true,
      });

      return;
    }

    if (
      status.status !==
        "succeeded" ||
      !status.paid
    ) {
      await ctx.answerCallbackQuery({
        text:
          "Оплата пока не подтверждена",
        show_alert:
          true,
      });

      return;
    }

    const user =
      ctx.from
        ? getUserByTelegramId(
            String(
              ctx.from.id
            )
          )
        : null;

    const payment =
      registerRealSuccessfulPayment({
        applicationId,
        externalPaymentId:
          paymentId,
        amount:
          status.amount,
        receiptEmail:
          user?.email || undefined,
        paidAt:
          status.capturedAt || undefined,
      });

    await ctx.answerCallbackQuery({
      text:
        "Оплата подтверждена",
    });

    await ctx.editMessageText(
      [
        "✅ Оплата получена",
        "",
        `Сумма: ${payment.amount} ₽`,
        "",
        "⏳ Формирую полис...",
      ].join("\n")
    );

    const policy =
      await issuePolicy(
        applicationId
      );

    await ctx.replyWithDocument(
      new InputFile(
        policy.filePath
      ),
      {
        caption: [
          "✅ Полис оформлен",
          "",
          `Номер: ${policy.policyNumber}`,
          `Участников: ${policy.participantsCount}`,
          `Начало: ${payment.policyStartDate}`,
          `Окончание: ${payment.policyEndDate}`,
        ].join("\n"),
      }
    );

    await sendPolicyCopyToManager(
      ctx,
      applicationId,
      policy,
      payment.policyStartDate,
      payment.policyEndDate
    );

    if (
      ctx.from
    ) {
      sessions.delete(
        ctx.from.id
      );
    }

    await ctx.reply(
      "Готово. Полис сохранён в разделе «📋 Мои заявки».",
      {
        reply_markup:
          userMainKeyboard(),
      }
    );
  } catch (error) {
    console.error(
      "YooKassa payment check error:",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : "Неизвестная ошибка";

    try {
      await ctx.reply(
        [
          "❌ Не удалось завершить оформление.",
          "",
          message,
        ].join("\n")
      );
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// MY APPLICATIONS
// ---------------------------------------------------------------------

async function showMyApplications(
  ctx: Context
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const applications =
    listUserApplications(
      String(
        ctx.from.id
      ),
      10
    );

  if (
    applications.length === 0
  ) {
    await ctx.reply(
      "У вас пока нет заявок."
    );

    return;
  }

  const lines =
    applications.map(
      application => {
        const type =
          application.applicationType ===
          "individual"
            ? "VI"
            : "VK";

        const payment =
          application.paymentStatus ===
          "paid"
            ? "✅ оплачено"
            : "⏳ ожидает оплаты";

        const policy =
          application.policyNumber
            ? `📄 ${application.policyNumber}`
            : "полис ещё не выдан";

        return [
          `#${application.id}`,
          type,
          `${application.participantsCount} чел.`,
          payment,
          policy,
        ].join(" · ");
      }
    );

  await ctx.reply(
    [
      "📋 Мои заявки",
      "",
      ...lines,
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// EMAIL
// ---------------------------------------------------------------------

async function showEmail(
  ctx: Context
): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const user =
    getUserByTelegramId(
      String(
        ctx.from.id
      )
    );

  const session =
    sessions.get(
      ctx.from.id
    ) || {};

  sessions.set(
    ctx.from.id,
    {
      ...session,
      waitingForEmail:
        true,
    }
  );

  await ctx.reply(
    user?.email
      ? [
          "📧 Ваш email:",
          "",
          user.email,
          "",
          "Отправьте новый email, если хотите его изменить.",
        ].join("\n")
      : [
          "📧 Email пока не указан.",
          "",
          "Отправьте его обычным сообщением.",
        ].join("\n")
  );
}

// ---------------------------------------------------------------------
// TEXT
// ---------------------------------------------------------------------

async function handleText(
  ctx: Context
): Promise<void> {
  if (
    !ctx.from ||
    !ctx.message?.text
  ) {
    return;
  }

  const text =
    ctx.message.text.trim();

  if (
    text ===
    "📄 Оформить страховку"
  ) {
    await ctx.reply(
      "Выберите тип оформления:",
      {
        reply_markup:
          applicationTypeKeyboard(),
      }
    );

    return;
  }

  if (
    text ===
    "📋 Мои заявки"
  ) {
    await showMyApplications(
      ctx
    );

    return;
  }

  if (
    text ===
    "📧 Мой email"
  ) {
    await showEmail(
      ctx
    );

    return;
  }

  if (
    text ===
    "ℹ️ Помощь"
  ) {
    await ctx.reply(
      [
        "ℹ️ Как оформить страховку",
        "",
        "1. Нажмите «📄 Оформить страховку».",
        "2. Выберите одного или нескольких участников.",
        "3. Выберите турнир.",
        "4. Загрузите паспорт.",
        "5. Проверьте данные.",
        "6. Выберите период.",
        "7. Оплатите через ЮKassa.",
        "8. Получите полис PDF.",
      ].join("\n")
    );

    return;
  }

  const session =
    sessions.get(
      ctx.from.id
    );

  if (
    session?.waitingForEmail
  ) {
    if (
      !isValidEmail(
        text
      )
    ) {
      await ctx.reply(
        "❌ Некорректный email. Попробуйте ещё раз."
      );

      return;
    }

    setUserEmail(
      String(
        ctx.from.id
      ),
      text
    );

    sessions.set(
      ctx.from.id,
      {
        ...session,
        waitingForEmail:
          false,
      }
    );

    await ctx.reply(
      `✅ Email сохранён: ${text.toLowerCase()}`
    );

    if (
      session.applicationId
    ) {
      await showPayment(
        ctx,
        session.applicationId
      );
    }

    return;
  }
}

// ---------------------------------------------------------------------
// REGISTER
// ---------------------------------------------------------------------

export function registerUserHandlers(
  bot: Bot
): void {
  bot.command(
    "start",
    async ctx => {
      ensureUser(ctx);

      await showMainMenu(
        ctx
      );
    }
  );

  bot.command(
    "menu",
    async ctx => {
      ensureUser(ctx);

      await showMainMenu(
        ctx
      );
    }
  );

  bot.callbackQuery(
    "user:main",
    async ctx => {
      await ctx.answerCallbackQuery();

      await showMainMenu(
        ctx
      );
    }
  );

  bot.callbackQuery(
    "user:type:individual",
    async ctx => {
      await ctx.answerCallbackQuery();

      await startApplication(
        ctx,
        "individual"
      );
    }
  );

  bot.callbackQuery(
    "user:type:group",
    async ctx => {
      await ctx.answerCallbackQuery();

      await startApplication(
        ctx,
        "group"
      );
    }
  );

  bot.callbackQuery(
    /^user:tournament:(\d+)$/,
    async ctx => {
      await ctx.answerCallbackQuery();

      await selectTournament(
        ctx,
        Number(
          ctx.match[1]
        )
      );
    }
  );

  bot.callbackQuery(
    "user:passport:confirm",
    confirmPassport
  );

  bot.callbackQuery(
    "user:passport:retry",
    async ctx => {
      if (
        ctx.from
      ) {
        const session =
          sessions.get(
            ctx.from.id
          );

        if (session) {
          sessions.set(
            ctx.from.id,
            {
              ...session,
              currentPassport:
                undefined,
            }
          );
        }
      }

      await ctx.answerCallbackQuery();

      await ctx.editMessageText(
        "Загрузите документ ещё раз."
      );
    }
  );

  bot.callbackQuery(
    /^user:group:add:(\d+)$/,
    async ctx => {
      if (!ctx.from) {
        return;
      }

      const applicationId =
        Number(
          ctx.match[1]
        );

      const session =
        sessions.get(
          ctx.from.id
        ) || {};

      sessions.set(
        ctx.from.id,
        {
          ...session,
          applicationId,
          currentPassport:
            undefined,
        }
      );

      await ctx.answerCallbackQuery();

      await ctx.editMessageText(
        "📄 Загрузите паспорт следующего участника."
      );
    }
  );

  bot.callbackQuery(
    /^user:group:finish:(\d+)$/,
    async ctx => {
      await finishGroup(
        ctx,
        Number(
          ctx.match[1]
        )
      );
    }
  );

  bot.callbackQuery(
    /^user:period:(\d+):(day|month|year)$/,
    async ctx => {
      await selectPeriod(
        ctx,
        Number(
          ctx.match[1]
        ),
        ctx.match[2] as
          PolicyPeriod
      );
    }
  );

  bot.callbackQuery(
    /^user:yookassa:create:(\d+)$/,
    async ctx => {
      await startYooKassaPayment(
        ctx,
        Number(
          ctx.match[1]
        )
      );
    }
  );

  bot.callbackQuery(
    /^user:yookassa:check:(\d+):(.+)$/,
    async ctx => {
      await checkYooKassaPayment(
        ctx,
        Number(
          ctx.match[1]
        ),
        ctx.match[2]
      );
    }
  );

  bot.on(
    [
      "message:photo",
      "message:document",
    ],
    handleDocumentUpload
  );

  bot.on(
    "message:text",
    handleText
  );
}
