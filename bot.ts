import "dotenv/config";

import { Bot } from "grammy";

import { config } from "./config.js";

import "./db.js";

import {
  registerUserHandlers,
} from "./handlers/user.js";

import {
  registerManagerHandlers,
} from "./handlers/manager.js";

// ---------------------------------------------------------------------
// BOT
// ---------------------------------------------------------------------

const bot =
  new Bot(
    config.botToken
  );

// ---------------------------------------------------------------------
// HANDLERS
// ---------------------------------------------------------------------

registerManagerHandlers(
  bot
);

registerUserHandlers(
  bot
);

// ---------------------------------------------------------------------
// ERROR HANDLER
// ---------------------------------------------------------------------

bot.catch(
  error => {
    console.error(
      "OLNOO Docs bot error:"
    );

    console.error(
      error.error
    );

    console.error(
      "Update:"
    );

    console.error(
      error.ctx.update
    );
  }
);

// ---------------------------------------------------------------------
// START
// ---------------------------------------------------------------------

async function start():
  Promise<void> {
  await bot.api.setMyCommands([
    {
      command:
        "start",

      description:
        "Главное меню",
    },

    {
      command:
        "menu",

      description:
        "Открыть меню",
    },

    {
      command:
        "admin",

      description:
        "Меню менеджера",
    },
  ]);

  console.log(
    "OLNOO Docs modular bot started"
  );

  await bot.start({
    onStart:
      botInfo => {
        console.log(
          `Telegram bot @${botInfo.username} started`
        );
      },
  });
}

start().catch(
  error => {
    console.error(
      "Fatal startup error:",
      error
    );

    process.exit(1);
  }
);
