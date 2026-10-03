import path from "node:path";
import { db, nowIso } from "../db.js";
import { calculatePolicyDates, simulateSuccessfulPayment } from "./payments.js";
import { createYooKassaPayment, getYooKassaPayment } from "./yookassa.js";
import { issuePolicy } from "./policies.js";
import { recognizePassport } from "./recognition.js";

export type WebPeriod = "single" | "year";

const PRICES: Record<string, Partial<Record<WebPeriod, number>>> = {
  standard: { single: 300, year: 1300 },
  optimal: { single: 600, year: 4000 },
  extended: { year: 6000 },
  profi: { single: 1200 },
  "profi-plus": { single: 2500, year: 5500 },
};

const COVERAGES: Record<string, number> = {
  standard: 100000,
  optimal: 300000,
  extended: 500000,
  profi: 100000,
  "profi-plus": 300000,
};

function priceFor(tariffId: string, period: WebPeriod): number {
  const price = PRICES[tariffId]?.[period];
  if (!price) throw new Error("Недоступная комбинация тарифа и периода");
  return price;
}

function dateRu(value: string | undefined): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function isoDateParts(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error("Некорректная дата начала действия полиса");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const check = new Date(Date.UTC(year, month - 1, day));

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error("Некорректная дата начала действия полиса");
  }

  return { year, month, day };
}

function formatIsoDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function todayMoscowRu(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";

  return `${day}.${month}.${year}`;
}

function tomorrowMoscowIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  const tomorrow = new Date(Date.UTC(year, month - 1, day));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  return formatIsoDate(tomorrow);
}

function calculateWebPolicyPeriod(
  policyStartDate: string,
  period: WebPeriod
): {
  startDate: string;
  endDate: string;
} {
  const { year, month, day } = isoDateParts(policyStartDate);

  if (policyStartDate < tomorrowMoscowIso()) {
    throw new Error("Дата начала действия полиса должна быть не раньше завтрашнего дня");
  }

  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start);

  if (period === "single") {
    // 5 календарных дней включительно:
    // 10.09 → 14.09
    end.setUTCDate(end.getUTCDate() + 4);
  } else {
    // 1 год:
    // 10.09.2026 → 10.09.2027
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  }

  return {
    startDate: dateRu(formatIsoDate(start)),
    endDate: dateRu(formatIsoDate(end)),
  };
}

export function createWebApplication(input: {
  tariffId: string;
  period: WebPeriod;
  email: string;
  participant: Record<string, string>;
  tournamentName: string;
  tournamentDate?: string;
  source?: "web" | "telegram";
  sport?: string;
  policyStartDate?: string;
}) {
  const email = input.email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Некорректный email");
  }

  const amount = priceFor(input.tariffId, input.period);
  const insurer = input.period === "year" ? "reso" : "ingos";
  const policyType = input.period === "year" ? "SYS" : "VI";
  const dbPeriod = input.period === "year" ? "year" : "day";
  const source = input.source === "telegram" ? "telegram" : "web";
  const insuranceAmount = COVERAGES[input.tariffId];

  if (!insuranceAmount) {
    throw new Error("Неизвестная страховая сумма тарифа");
  }

  let webDates: { startDate: string; endDate: string } | null = null;

  if (source === "web") {
    if (!input.policyStartDate) {
      throw new Error("Выберите дату начала действия полиса");
    }

    webDates = calculateWebPolicyPeriod(
      input.policyStartDate,
      input.period
    );
  }

  return db.transaction(() => {
    const userId = `${source}:${crypto.randomUUID()}`;
    const now = nowIso();

    db.prepare(
      "INSERT INTO users (telegram_user_id, telegram_username, telegram_name, email, created_at, updated_at) VALUES (?,NULL,?, ?,?,?)"
    ).run(
      userId,
      source === "telegram" ? "Telegram customer" : "Web customer",
      email,
      now,
      now
    );

    let tournament = db
      .prepare("SELECT id FROM tournaments WHERE name=? LIMIT 1")
      .get(input.tournamentName) as { id: number } | undefined;

    if (!tournament) {
      const result = db
        .prepare(
          "INSERT INTO tournaments (name,event_date,is_active,created_at) VALUES (?,?,1,?)"
        )
        .run(
          input.tournamentName,
          input.tournamentDate || null,
          now
        );

      tournament = { id: Number(result.lastInsertRowid) };
    }

    const result = db.prepare(`
      INSERT INTO applications
      (
        submitted_by_user_id,
        tournament_id,
        application_type,
        policy_period,
        participants_count,
        price_per_person,
        total_amount,
        payment_status,
        policy_start_date,
        policy_end_date,
        policy_status,
        exported_to_insurer,
        created_at,
        source,
        insurer,
        policy_type,
        sport,
        insurance_amount
      )
      VALUES (
        ?,?,
        'individual',
        ?,
        1,
        ?,?,
        'pending',
        ?,?,
        'waiting',
        0,
        ?,?,?,?,?,?
      )
    `).run(
      userId,
      tournament.id,
      dbPeriod,
      amount,
      amount,
      webDates?.startDate || null,
      webDates?.endDate || null,
      now,
      source,
      insurer,
      policyType,
      input.sport?.trim() || null,
      insuranceAmount
    );

    const applicationId = Number(result.lastInsertRowid);
    const p = input.participant;

    db.prepare(`
      INSERT INTO participants
      (
        application_id,
        last_name,
        first_name,
        middle_name,
        birth_date,
        birth_place,
        gender,
        passport_series,
        passport_number,
        issue_date,
        issued_by,
        department_code,
        created_at
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      applicationId,
      p.lastName || "",
      p.firstName || "",
      p.middleName || "",
      dateRu(p.birthDate),
      p.birthPlace || "",
      p.gender || "",
      p.passportSeries || "",
      p.passportNumber || "",
      dateRu(p.issueDate),
      p.issuedBy || "",
      p.departmentCode || "",
      now
    );

    return {
      applicationId,
      amount,
      insurer,
      insurerName:
        insurer === "reso" ? "РЕСО-Гарантия" : "Ингосстрах",
      policyType,
    };
  })();
}

export async function createWebPayment(
  applicationId: number,
  returnUrl: string
) {
  const row = db.prepare(`
    SELECT
      a.total_amount,
      a.source,
      a.policy_start_date,
      a.policy_end_date,
      u.email
    FROM applications a
    JOIN users u
      ON u.telegram_user_id = a.submitted_by_user_id
    WHERE a.id=?
      AND a.source IN ('web','telegram')
  `).get(applicationId) as {
    total_amount: number;
    source: "web" | "telegram";
    policy_start_date: string | null;
    policy_end_date: string | null;
    email: string;
  } | undefined;

  if (!row) {
    throw new Error("Web-заявка не найдена");
  }

  if (process.env.PAYMENT_TEST_MODE === "true") {
    const savedStartDate = row.policy_start_date;
    const savedEndDate = row.policy_end_date;

    const payment = simulateSuccessfulPayment(applicationId);

    // Общий симулятор используется также Telegram и считает даты
    // от момента оплаты. Для web возвращаем выбранный пользователем срок.
    if (
      row.source === "web" &&
      savedStartDate &&
      savedEndDate
    ) {
      db.prepare(`
        UPDATE applications
        SET
          policy_date = ?,
          policy_start_date = ?,
          policy_end_date = ?
        WHERE id = ?
      `).run(
        todayMoscowRu(),
        savedStartDate,
        savedEndDate,
        applicationId
      );
    }

    return {
      paymentId: `test-${applicationId}`,
      status: "succeeded",
      confirmationUrl: "",
      amount: payment.amount,
      paid: true,
      testMode: true,
    };
  }

  const payment = await createYooKassaPayment({
    applicationId,
    amount: row.total_amount,
    email: row.email,
    returnUrl,
    idempotenceKey: `web-application-${applicationId}`,
  });

  const existing = db
    .prepare(
      "SELECT id FROM payments WHERE application_id=? AND external_payment_id=?"
    )
    .get(applicationId, payment.paymentId);

  if (!existing) {
    db.prepare(
      "INSERT INTO payments (application_id,provider,external_payment_id,amount,status,receipt_email,created_at) VALUES (?,'yookassa',?,?,'pending',?,?)"
    ).run(
      applicationId,
      payment.paymentId,
      row.total_amount,
      row.email,
      nowIso()
    );
  }

  return payment;
}

export async function confirmWebPayment(
  applicationId: number,
  paymentId: string
) {
  const app = db.prepare(`
    SELECT
      total_amount,
      payment_status,
      policy_period,
      source,
      policy_start_date,
      policy_end_date
    FROM applications
    WHERE id=?
      AND source IN ('web','telegram')
  `).get(applicationId) as {
    total_amount: number;
    payment_status: string;
    policy_period: "day" | "year";
    source: "web" | "telegram";
    policy_start_date: string | null;
    policy_end_date: string | null;
  } | undefined;

  if (!app) {
    throw new Error("Web-заявка не найдена");
  }

  const paymentRow = db
    .prepare(
      "SELECT id FROM payments WHERE application_id=? AND external_payment_id=? AND provider='yookassa'"
    )
    .get(applicationId, paymentId);

  if (!paymentRow) {
    throw new Error("Платёж не относится к заявке");
  }

  const status = await getYooKassaPayment(paymentId);

  if (status.amount !== app.total_amount) {
    throw new Error("Сумма платежа не совпадает с заявкой");
  }

  if (
    status.status === "succeeded" &&
    status.paid &&
    app.payment_status !== "paid"
  ) {
    const paymentDates = calculatePolicyDates(
      app.policy_period,
      status.capturedAt
        ? new Date(status.capturedAt)
        : new Date()
    );

    const startDate =
      app.source === "web" && app.policy_start_date
        ? app.policy_start_date
        : paymentDates.startDate;

    const endDate =
      app.source === "web" && app.policy_end_date
        ? app.policy_end_date
        : paymentDates.endDate;

    db.transaction(() => {
      db.prepare(`
        UPDATE applications
        SET
          payment_status='paid',
          paid_at=?,
          policy_date=?,
          policy_start_date=?,
          policy_end_date=?
        WHERE id=?
          AND payment_status='pending'
      `).run(
        paymentDates.paidAt,
        todayMoscowRu(),
        startDate,
        endDate,
        applicationId
      );

      db.prepare(`
        UPDATE payments
        SET status='paid', paid_at=?
        WHERE application_id=?
          AND external_payment_id=?
      `).run(
        paymentDates.paidAt,
        applicationId,
        paymentId
      );
    })();
  }

  return status;
}

export async function issueWebPolicy(applicationId: number) {
  const result = await issuePolicy(applicationId);

  const row = db
    .prepare(
      "SELECT insurer,policy_type FROM applications WHERE id=? AND source IN ('web','telegram')"
    )
    .get(applicationId) as {
    insurer: string;
    policy_type: string;
  } | undefined;

  if (!row) {
    throw new Error("Web-заявка не найдена");
  }

  return {
    applicationId,
    policyNumber: result.policyNumber,
    insurer: row.insurer,
    insurerName:
      row.insurer === "reso"
        ? "РЕСО-Гарантия"
        : "Ингосстрах",
    policyType: row.policy_type,
    downloadPath: `/insurance/policies/${encodeURIComponent(
      result.policyNumber
    )}.pdf`,
  };
}

export { recognizePassport };

export function policyFilePath(policyNumber: string) {
  return path.join(
    process.cwd(),
    "exports",
    `${policyNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`
  );
}
