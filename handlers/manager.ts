import {
  Bot,
  Context,
  InlineKeyboard,
  InputFile,
  Keyboard,
  NextFunction,
} from "grammy";

import { config } from "../config.js";

import {
  createTournament,
  listActiveTournaments,
  listClosedTournaments,
  closeTournament,
  reopenTournament,
  getTournamentStats,
} from "../services/tournaments.js";

import {
  getOverallAnalytics,
  formatOverallAnalytics,
  getTodayAnalytics,
} from "../services/analytics.js";

import {
  getPolicyNumberStats,
  importPolicyNumbers,
} from "../services/policy-numbers.js";

import {
  getManagerEmail,
  isValidEmail,
  setManagerEmail,
} from "../services/users.js";

import {
  listPaidApplications,
  listIssuedApplications,
} from "../services/applications.js";

import {
  generateInsurerExcel,
} from "../services/excel.js";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

type ManagerSession = {
  mode?:
    | "create_tournament"
    | "set_manager_email"
    | "import_vi"
    | "import_vk"
    | "import_sys";
};

const sessions =
  new Map<
    number,
    ManagerSession
  >();

// ---------------------------------------------------------------------
// ACCESS
// ---------------------------------------------------------------------

function isManager(
  ctx: Context
): boolean {
  if (!ctx.from) {
    return false;
  }

  return (
    String(ctx.from.id) ===
    String(config.managerChatId)
  );
}

// ---------------------------------------------------------------------
// MAIN KEYBOARD
// ---------------------------------------------------------------------

function managerKeyboard():
  Keyboard {
  return new Keyboard()
    .text("🏆 Турниры")
    .text("📋 Заявки")
    .row()
    .text("💰 Оплаты")
    .text("✅ Выданные полисы")
    .row()
    .text("🎫 Номера полисов")
    .text("📊 Excel для страховой")
    .row()
    .text("📈 Аналитика")
    .text("⚙️ Настройки")
    .resized();
}

// ---------------------------------------------------------------------
// MAIN MENU
// ---------------------------------------------------------------------

async function showManagerMenu(
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
      "🛡 OLNOO Docs — менеджер",
      "",
      "Выберите раздел:",
    ].join("\n"),
    {
      reply_markup:
        managerKeyboard(),
    }
  );
}

// ---------------------------------------------------------------------
// TOURNAMENTS
// ---------------------------------------------------------------------

async function showTournaments(
  ctx: Context
): Promise<void> {
  const active =
    listActiveTournaments();

  const closed =
    listClosedTournaments();

  const keyboard =
    new InlineKeyboard()
      .text(
        "➕ Создать турнир",
        "manager:tournament:create"
      )
      .row();

  for (
    const tournament
    of active
  ) {
    keyboard
      .text(
        `✅ ${tournament.name}`,
        `manager:tournament:view:${tournament.id}`
      )
      .row();
  }

  for (
    const tournament
    of closed.slice(0, 10)
  ) {
    keyboard
      .text(
        `⛔ ${tournament.name}`,
        `manager:tournament:view:${tournament.id}`
      )
      .row();
  }

  await ctx.reply(
    [
      "🏆 Турниры",
      "",
      `Активных: ${active.length}`,
      `Завершённых: ${closed.length}`,
    ].join("\n"),
    {
      reply_markup:
        keyboard,
    }
  );
}

// ---------------------------------------------------------------------
// TOURNAMENT
// ---------------------------------------------------------------------

async function showTournament(
  ctx: Context,
  tournamentId: number
): Promise<void> {
  const active =
    listActiveTournaments().find(
      item =>
        item.id ===
        tournamentId
    );

  const closed =
    listClosedTournaments().find(
      item =>
        item.id ===
        tournamentId
    );

  const tournament =
    active || closed;

  if (!tournament) {
    await ctx.reply(
      "Турнир не найден."
    );

    return;
  }

  const stats =
    getTournamentStats(
      tournamentId
    );

  const keyboard =
    new InlineKeyboard();

  if (
    tournament.isActive
  ) {
    keyboard.text(
      "⛔ Завершить турнир",
      `manager:tournament:close:${tournamentId}`
    );
  } else {
    keyboard.text(
      "✅ Открыть снова",
      `manager:tournament:reopen:${tournamentId}`
    );
  }

  await ctx.reply(
    [
      `🏆 ${tournament.name}`,
      "",
      `Статус: ${
        tournament.isActive
          ? "активный"
          : "завершён"
      }`,
      `Дата: ${
        tournament.eventDate ||
        "не указана"
      }`,
      "",
      `Заявок: ${stats.applications}`,
      `Участников: ${stats.participants}`,
      `Оплачено заявок: ${stats.paidApplications}`,
      `Оплачено участников: ${stats.paidParticipants}`,
      `Выдано полисов: ${stats.issuedApplications}`,
      `Выдано участникам: ${stats.issuedParticipants}`,
      `Выручка: ${stats.revenue} ₽`,
    ].join("\n"),
    {
      reply_markup:
        keyboard,
    }
  );
}

// ---------------------------------------------------------------------
// APPLICATIONS
// ---------------------------------------------------------------------

async function showApplications(
  ctx: Context
): Promise<void> {
  const paid =
    listPaidApplications();

  const issued =
    listIssuedApplications();

  await ctx.reply(
    [
      "📋 Заявки",
      "",
      `Оплачено заявок: ${paid.length}`,
      `Выдано полисов: ${issued.length}`,
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// PAYMENTS
// ---------------------------------------------------------------------

async function showPayments(
  ctx: Context
): Promise<void> {
  const applications =
    listPaidApplications();

  const amount =
    applications.reduce(
      (
        total,
        application
      ) =>
        total +
        application.totalAmount,
      0
    );

  await ctx.reply(
    [
      "💰 Оплаты",
      "",
      `Оплаченных заявок: ${applications.length}`,
      `Получено: ${amount} ₽`,
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// ISSUED
// ---------------------------------------------------------------------

async function showIssued(
  ctx: Context
): Promise<void> {
  const applications =
    listIssuedApplications();

  if (
    applications.length === 0
  ) {
    await ctx.reply(
      "Пока нет выданных полисов."
    );

    return;
  }

  const lines =
    applications
      .slice(0, 20)
      .map(
        application => {
          return [
            `#${application.id}`,
            application.policyNumber ||
              "без номера",
            application.applicationType ===
            "individual"
              ? "VI"
              : "VK",
            `${application.participantsCount} чел.`,
          ].join(" · ");
        }
      );

  await ctx.reply(
    [
      "✅ Выданные полисы",
      "",
      ...lines,
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// POLICY NUMBERS
// ---------------------------------------------------------------------

async function showPolicyNumbers(
  ctx: Context
): Promise<void> {
  const vi =
    getPolicyNumberStats(
      "individual"
    );

  const vk =
    getPolicyNumberStats(
      "group"
    );
  const sys = getPolicyNumberStats("SYS");

  const keyboard =
    new InlineKeyboard()
      .text(
        "⬆️ Загрузить VI",
        "manager:numbers:vi"
      )
      .row()
      .text(
        "⬆️ Загрузить VK",
        "manager:numbers:vk"
      )
      .row()
      .text(
        "⬆️ Загрузить SYS",
        "manager:numbers:sys"
      );

  await ctx.reply(
    [
      "🎫 Номера полисов",
      "",
      "VI — индивидуальные",
      `Всего: ${vi.total}`,
      `Свободно: ${vi.free}`,
      `Зарезервировано: ${vi.reserved}`,
      `Выдано: ${vi.issued}`,
      "",
      "VK — групповые",
      `Всего: ${vk.total}`,
      `Свободно: ${vk.free}`,
      `Зарезервировано: ${vk.reserved}`,
      `Выдано: ${vk.issued}`,
      "",
      "SYS — РЕСО, индивидуальные годовые",
      `Всего: ${sys.total}`,
      `Свободно: ${sys.free}`,
      `Зарезервировано: ${sys.reserved}`,
      `Выдано: ${sys.issued}`,
    ].join("\n"),
    {
      reply_markup:
        keyboard,
    }
  );
}

// ---------------------------------------------------------------------
// EXCEL
// ---------------------------------------------------------------------

async function showExcelTournaments(
  ctx: Context
): Promise<void> {
  const active =
    listActiveTournaments();

  const closed =
    listClosedTournaments();

  const tournaments = [
    ...active,
    ...closed,
  ];

  if (
    tournaments.length === 0
  ) {
    await ctx.reply(
      "Нет турниров для выгрузки."
    );

    return;
  }

  const keyboard =
    new InlineKeyboard();

  for (
    const tournament
    of tournaments
  ) {
    keyboard
      .text(
        `${
          tournament.isActive
            ? "✅"
            : "⛔"
        } ${tournament.name}`,
        `manager:excel:${tournament.id}`
      )
      .row();
  }

  await ctx.reply(
    [
      "📊 Excel для страховой",
      "",
      "Выберите турнир.",
      "",
      "В файл попадут только:",
      "• оплаченные заявки;",
      "• выданные полисы;",
      "• ещё не выгруженные в страховую.",
    ].join("\n"),
    {
      reply_markup:
        keyboard,
    }
  );
}

async function generateAndSendExcel(
  ctx: Context,
  tournamentId: number
): Promise<void> {
  await ctx.reply(
    "⏳ Формирую Excel для страховой..."
  );

  try {
    const result =
      await generateInsurerExcel(
        tournamentId
      );

    await ctx.replyWithDocument(
      new InputFile(
        result.filePath
      ),
      {
        caption: [
          "✅ Excel для страховой сформирован",
          "",
          `Партия: ${result.batchId}`,
          `Заявок: ${result.applicationsCount}`,
          `Участников: ${result.participantsCount}`,
          "",
          "Эти заявки отмечены как выгруженные и повторно в следующую выгрузку не попадут.",
        ].join("\n"),
      }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Неизвестная ошибка";

    await ctx.reply(
      `❌ Не удалось сформировать Excel.\n\n${message}`
    );
  }
}

// ---------------------------------------------------------------------
// ANALYTICS
// ---------------------------------------------------------------------

async function showAnalytics(
  ctx: Context
): Promise<void> {
  const overall =
    getOverallAnalytics();

  const today =
    getTodayAnalytics();

  await ctx.reply(
    [
      formatOverallAnalytics(
        overall
      ),
      "",
      "Сегодня",
      `Заявок: ${today.applications}`,
      `Участников: ${today.participants}`,
      `Оплачено: ${today.paidApplications}`,
      `Выдано: ${today.issuedPolicies}`,
      `Выручка: ${today.revenue} ₽`,
    ].join("\n")
  );
}

// ---------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------

async function showSettings(
  ctx: Context
): Promise<void> {
  const email =
    getManagerEmail();

  const keyboard =
    new InlineKeyboard()
      .text(
        "📧 Изменить email",
        "manager:settings:email"
      );

  await ctx.reply(
    [
      "⚙️ Настройки",
      "",
      `Email менеджера: ${
        email ||
        "не указан"
      }`,
    ].join("\n"),
    {
      reply_markup:
        keyboard,
    }
  );
}

// ---------------------------------------------------------------------
// MANAGER TEXT
// ---------------------------------------------------------------------

async function handleManagerText(
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
    text === "🏆 Турниры"
  ) {
    await showTournaments(ctx);
    return;
  }

  if (
    text === "📋 Заявки"
  ) {
    await showApplications(ctx);
    return;
  }

  if (
    text === "💰 Оплаты"
  ) {
    await showPayments(ctx);
    return;
  }

  if (
    text ===
    "✅ Выданные полисы"
  ) {
    await showIssued(ctx);
    return;
  }

  if (
    text ===
    "🎫 Номера полисов"
  ) {
    await showPolicyNumbers(ctx);
    return;
  }

  if (
    text ===
    "📊 Excel для страховой"
  ) {
    await showExcelTournaments(
      ctx
    );

    return;
  }

  if (
    text === "📈 Аналитика"
  ) {
    await showAnalytics(ctx);
    return;
  }

  if (
    text === "⚙️ Настройки"
  ) {
    await showSettings(ctx);
    return;
  }

  const session =
    sessions.get(
      ctx.from.id
    );

  if (
    session?.mode ===
    "create_tournament"
  ) {
    const tournament =
      createTournament(
        text
      );

    sessions.delete(
      ctx.from.id
    );

    await ctx.reply(
      `✅ Турнир создан: ${tournament.name}`
    );

    await showTournaments(ctx);

    return;
  }

  if (
    session?.mode ===
    "set_manager_email"
  ) {
    if (
      !isValidEmail(text)
    ) {
      await ctx.reply(
        "❌ Некорректный email. Отправьте ещё раз."
      );

      return;
    }

    const email =
      setManagerEmail(
        text
      );

    sessions.delete(
      ctx.from.id
    );

    await ctx.reply(
      `✅ Email менеджера сохранён: ${email}`
    );

    return;
  }

  if (
    session?.mode ===
      "import_vi" ||
    session?.mode ===
      "import_vk" ||
    session?.mode ===
      "import_sys"
  ) {
    const policyType =
      session.mode ===
      "import_vi"
        ? "individual"
        : session.mode === "import_vk"
          ? "group"
          : "SYS";

    const numbers =
      text
        .split(
          /[\s,;]+/
        )
        .map(
          value =>
            value.trim()
        )
        .filter(Boolean);

    try {
      const result =
        importPolicyNumbers(
          policyType,
          numbers
        );

      sessions.delete(
        ctx.from.id
      );

      await ctx.reply(
        [
          "✅ Номера обработаны.",
          "",
          `Загружено: ${result.imported}`,
          `Пропущено: ${result.skipped}`,
          result.duplicates.length > 0
            ? `Дубликаты: ${result.duplicates.join(", ")}`
            : "Дубликатов нет.",
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(
        error instanceof Error
          ? `❌ ${error.message}`
          : "❌ Ошибка загрузки номеров"
      );
    }

    return;
  }
}

// ---------------------------------------------------------------------
// REGISTER
// ---------------------------------------------------------------------

export function registerManagerHandlers(
  bot: Bot
): void {
  bot.command(
    "admin",
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      await showManagerMenu(
        ctx
      );
    }
  );

  bot.callbackQuery(
    "manager:tournament:create",
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      sessions.set(
        ctx.from.id,
        {
          mode:
            "create_tournament",
        }
      );

      await ctx.answerCallbackQuery();

      await ctx.reply(
        "Отправьте название нового турнира."
      );
    }
  );

  bot.callbackQuery(
    /^manager:tournament:view:(\d+)$/,
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      await ctx.answerCallbackQuery();

      await showTournament(
        ctx,
        Number(
          ctx.match[1]
        )
      );
    }
  );

  bot.callbackQuery(
    /^manager:tournament:close:(\d+)$/,
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      const id =
        Number(
          ctx.match[1]
        );

      closeTournament(id);

      await ctx.answerCallbackQuery({
        text:
          "Турнир завершён",
      });

      await showTournament(
        ctx,
        id
      );
    }
  );

  bot.callbackQuery(
    /^manager:tournament:reopen:(\d+)$/,
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      const id =
        Number(
          ctx.match[1]
        );

      reopenTournament(id);

      await ctx.answerCallbackQuery({
        text:
          "Турнир открыт",
      });

      await showTournament(
        ctx,
        id
      );
    }
  );

  bot.callbackQuery(
    "manager:numbers:vi",
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      sessions.set(
        ctx.from.id,
        {
          mode:
            "import_vi",
        }
      );

      await ctx.answerCallbackQuery();

      await ctx.reply(
        [
          "⬆️ Загрузка VI",
          "",
          "Отправьте номера одним сообщением.",
          "Можно по одному в строке, через пробел или запятую.",
        ].join("\n")
      );
    }
  );

  bot.callbackQuery(
    "manager:numbers:vk",
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      sessions.set(
        ctx.from.id,
        {
          mode:
            "import_vk",
        }
      );

      await ctx.answerCallbackQuery();

      await ctx.reply(
        [
          "⬆️ Загрузка VK",
          "",
          "Отправьте номера одним сообщением.",
          "Можно по одному в строке, через пробел или запятую.",
        ].join("\n")
      );
    }
  );

  bot.callbackQuery(
    "manager:numbers:sys",
    async ctx => {
      if (!isManager(ctx)) return;
      sessions.set(ctx.from.id, { mode: "import_sys" });
      await ctx.answerCallbackQuery();
      await ctx.reply([
        "⬆️ Загрузка SYS (РЕСО)",
        "",
        "Отправьте номера, начинающиеся с SYS, одним сообщением.",
        "Можно по одному в строке, через пробел или запятую.",
      ].join("\n"));
    }
  );

  // -------------------------------------------------------------------
  // EXCEL
  // -------------------------------------------------------------------

  bot.callbackQuery(
    /^manager:excel:(\d+)$/,
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      const tournamentId =
        Number(
          ctx.match[1]
        );

      await ctx.answerCallbackQuery({
        text:
          "Формирую Excel",
      });

      await generateAndSendExcel(
        ctx,
        tournamentId
      );
    }
  );

  // -------------------------------------------------------------------
  // SETTINGS
  // -------------------------------------------------------------------

  bot.callbackQuery(
    "manager:settings:email",
    async ctx => {
      if (!isManager(ctx)) {
        return;
      }

      sessions.set(
        ctx.from.id,
        {
          mode:
            "set_manager_email",
        }
      );

      await ctx.answerCallbackQuery();

      await ctx.reply(
        "Отправьте email менеджера."
      );
    }
  );

  // -------------------------------------------------------------------
  // TEXT
  // -------------------------------------------------------------------

  bot.on(
    "message:text",
    async (
      ctx,
      next: NextFunction
    ) => {
      if (!isManager(ctx)) {
        await next();
        return;
      }

      await handleManagerText(
        ctx
      );
    }
  );
}
