import { db, nowIso } from "../db.js";
import type {
  UserProfile,
} from "../types.js";

// ---------------------------------------------------------------------
// DB TYPES
// ---------------------------------------------------------------------

type DbUserRow = {
  telegram_user_id: string;

  telegram_username: string | null;

  telegram_name: string | null;

  email: string | null;

  created_at: string;

  updated_at: string;
};

type DbManagerSettingsRow = {
  id: number;

  email: string | null;

  created_at: string;

  updated_at: string;
};

// ---------------------------------------------------------------------
// MAPPERS
// ---------------------------------------------------------------------

function mapUser(
  row: DbUserRow
): UserProfile {
  return {
    telegramUserId:
      row.telegram_user_id,

    telegramUsername:
      row.telegram_username,

    telegramName:
      row.telegram_name,

    email:
      row.email,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

// ---------------------------------------------------------------------
// EMAIL VALIDATION
// ---------------------------------------------------------------------

export function normalizeEmail(
  email: string
): string {
  return email
    .trim()
    .toLowerCase();
}

export function isValidEmail(
  email: string
): boolean {
  const normalized =
    normalizeEmail(
      email
    );

  if (!normalized) {
    return false;
  }

  if (
    normalized.length > 254
  ) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalized
  );
}

// ---------------------------------------------------------------------
// UPSERT USER
// ---------------------------------------------------------------------

export function upsertUser(
  telegramUserId: string,
  telegramUsername?: string | null,
  telegramName?: string | null
): UserProfile {
  const now =
    nowIso();

  const existing =
    getUserByTelegramId(
      telegramUserId
    );

  if (!existing) {
    db.prepare(`
      INSERT INTO users (
        telegram_user_id,
        telegram_username,
        telegram_name,
        email,
        created_at,
        updated_at
      )

      VALUES (
        ?,
        ?,
        ?,
        NULL,
        ?,
        ?
      )
    `).run(
      telegramUserId,
      telegramUsername || null,
      telegramName || null,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE users
      SET
        telegram_username = ?,
        telegram_name = ?,
        updated_at = ?
      WHERE telegram_user_id = ?
    `).run(
      telegramUsername || null,
      telegramName || null,
      now,
      telegramUserId
    );
  }

  const user =
    getUserByTelegramId(
      telegramUserId
    );

  if (!user) {
    throw new Error(
      "Не удалось создать или обновить пользователя"
    );
  }

  return user;
}

// ---------------------------------------------------------------------
// GET USER
// ---------------------------------------------------------------------

export function getUserByTelegramId(
  telegramUserId: string
): UserProfile | null {
  const row =
    db.prepare(`
      SELECT
        telegram_user_id,
        telegram_username,
        telegram_name,
        email,
        created_at,
        updated_at
      FROM users
      WHERE telegram_user_id = ?
      LIMIT 1
    `).get(
      telegramUserId
    ) as
      | DbUserRow
      | undefined;

  if (!row) {
    return null;
  }

  return mapUser(
    row
  );
}

// ---------------------------------------------------------------------
// SET USER EMAIL
// ---------------------------------------------------------------------

export function setUserEmail(
  telegramUserId: string,
  email: string
): UserProfile {
  const user =
    getUserByTelegramId(
      telegramUserId
    );

  if (!user) {
    throw new Error(
      "Пользователь не найден"
    );
  }

  const normalized =
    normalizeEmail(
      email
    );

  if (
    !isValidEmail(
      normalized
    )
  ) {
    throw new Error(
      "Некорректный email"
    );
  }

  db.prepare(`
    UPDATE users
    SET
      email = ?,
      updated_at = ?
    WHERE telegram_user_id = ?
  `).run(
    normalized,
    nowIso(),
    telegramUserId
  );

  const updated =
    getUserByTelegramId(
      telegramUserId
    );

  if (!updated) {
    throw new Error(
      "Не удалось обновить email"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// CLEAR USER EMAIL
// ---------------------------------------------------------------------

export function clearUserEmail(
  telegramUserId: string
): UserProfile {
  const user =
    getUserByTelegramId(
      telegramUserId
    );

  if (!user) {
    throw new Error(
      "Пользователь не найден"
    );
  }

  db.prepare(`
    UPDATE users
    SET
      email = NULL,
      updated_at = ?
    WHERE telegram_user_id = ?
  `).run(
    nowIso(),
    telegramUserId
  );

  const updated =
    getUserByTelegramId(
      telegramUserId
    );

  if (!updated) {
    throw new Error(
      "Не удалось очистить email"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// MANAGER EMAIL
// ---------------------------------------------------------------------

export function getManagerEmail():
  string | null {
  const row =
    db.prepare(`
      SELECT
        id,
        email,
        created_at,
        updated_at
      FROM manager_settings
      WHERE id = 1
      LIMIT 1
    `).get() as
      | DbManagerSettingsRow
      | undefined;

  if (!row) {
    return null;
  }

  return row.email;
}

export function setManagerEmail(
  email: string
): string {
  const normalized =
    normalizeEmail(
      email
    );

  if (
    !isValidEmail(
      normalized
    )
  ) {
    throw new Error(
      "Некорректный email менеджера"
    );
  }

  const now =
    nowIso();

  db.prepare(`
    INSERT INTO manager_settings (
      id,
      email,
      created_at,
      updated_at
    )

    VALUES (
      1,
      ?,
      ?,
      ?
    )

    ON CONFLICT(id)
    DO UPDATE SET
      email = excluded.email,
      updated_at = excluded.updated_at
  `).run(
    normalized,
    now,
    now
  );

  return normalized;
}

// ---------------------------------------------------------------------
// PROFILE LABEL
// ---------------------------------------------------------------------

export function formatUserProfile(
  user: UserProfile
): string {
  const name =
    user.telegramName ||
    "не указано";

  const username =
    user.telegramUsername
      ? `@${user.telegramUsername}`
      : "не указан";

  const email =
    user.email ||
    "не указан";

  return [
    "👤 Профиль",
    "",
    `Имя: ${name}`,
    `Username: ${username}`,
    `Telegram ID: ${user.telegramUserId}`,
    `Email: ${email}`,
  ].join("\n");
}
