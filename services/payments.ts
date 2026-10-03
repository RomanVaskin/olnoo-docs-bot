import { config } from "../config.js";
import { db, nowIso } from "../db.js";
import type {
  PolicyPeriod,
} from "../types.js";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

export type PaymentResult = {
  applicationId: number;

  amount: number;

  paymentStatus: "paid";

  paidAt: string;

  policyDate: string;

  policyStartDate: string;

  policyEndDate: string;
};

export type RealPaymentInput = {
  applicationId: number;

  externalPaymentId: string;

  amount: number;

  receiptId?: string;

  receiptStatus?: string;

  receiptEmail?: string;

  paidAt?: string;
};

// ---------------------------------------------------------------------
// PRICE
// ---------------------------------------------------------------------

export function getPricePerPerson(
  period: PolicyPeriod
): number {
  if (period === "day") {
    return config.prices.day;
  }

  if (period === "month") {
    return config.prices.month;
  }

  if (period === "year") {
    return config.prices.year;
  }

  throw new Error(
    "Неизвестный период страхования"
  );
}

export function calculateTotalAmount(
  period: PolicyPeriod,
  participantsCount: number
): number {
  if (
    !Number.isInteger(
      participantsCount
    ) ||
    participantsCount <= 0
  ) {
    throw new Error(
      "Количество участников должно быть больше нуля"
    );
  }

  const pricePerPerson =
    getPricePerPerson(
      period
    );

  return (
    pricePerPerson *
    participantsCount
  );
}

// ---------------------------------------------------------------------
// DATE HELPERS
// ---------------------------------------------------------------------

function pad(
  value: number
): string {
  return String(
    value
  ).padStart(
    2,
    "0"
  );
}

export function formatDateRu(
  date: Date
): string {
  return [
    pad(
      date.getDate()
    ),

    pad(
      date.getMonth() + 1
    ),

    date.getFullYear(),
  ].join(".");
}

function addDay(
  date: Date
): Date {
  const result =
    new Date(
      date.getTime()
    );

  result.setDate(
    result.getDate() + 1
  );

  return result;
}

function addMonth(
  date: Date
): Date {
  const result =
    new Date(
      date.getTime()
    );

  const originalDay =
    result.getDate();

  result.setDate(1);

  result.setMonth(
    result.getMonth() + 1
  );

  const lastDay =
    new Date(
      result.getFullYear(),
      result.getMonth() + 1,
      0
    ).getDate();

  result.setDate(
    Math.min(
      originalDay,
      lastDay
    )
  );

  return result;
}

function addYear(
  date: Date
): Date {
  const result =
    new Date(
      date.getTime()
    );

  const originalMonth =
    result.getMonth();

  const originalDay =
    result.getDate();

  result.setDate(1);

  result.setFullYear(
    result.getFullYear() + 1
  );

  result.setMonth(
    originalMonth
  );

  const lastDay =
    new Date(
      result.getFullYear(),
      originalMonth + 1,
      0
    ).getDate();

  result.setDate(
    Math.min(
      originalDay,
      lastDay
    )
  );

  return result;
}

// ---------------------------------------------------------------------
// POLICY DATES
// ---------------------------------------------------------------------

export type PolicyDates = {
  policyDate: string;

  startDate: string;

  endDate: string;

  paidAt: string;
};

export function calculatePolicyDates(
  period: PolicyPeriod,
  baseDate: Date = new Date()
): PolicyDates {
  let endDate: Date;

  if (
    period === "day"
  ) {
    endDate =
      addDay(
        baseDate
      );
  } else if (
    period === "month"
  ) {
    endDate =
      addMonth(
        baseDate
      );
  } else if (
    period === "year"
  ) {
    endDate =
      addYear(
        baseDate
      );
  } else {
    throw new Error(
      "Неизвестный период страхования"
    );
  }

  return {
    policyDate:
      formatDateRu(
        baseDate
      ),

    startDate:
      formatDateRu(
        baseDate
      ),

    endDate:
      formatDateRu(
        endDate
      ),

    paidAt:
      baseDate.toISOString(),
  };
}

// ---------------------------------------------------------------------
// GET APPLICATION FOR PAYMENT
// ---------------------------------------------------------------------

type PaymentApplicationRow = {
  id: number;

  policy_period:
    PolicyPeriod | null;

  participants_count:
    number;

  payment_status:
    string;

  total_amount:
    number;

  paid_at:
    string | null;

  policy_date:
    string | null;

  policy_start_date:
    string | null;

  policy_end_date:
    string | null;
};

function getApplicationForPayment(
  applicationId: number
): PaymentApplicationRow {
  const application =
    db.prepare(`
      SELECT
        id,
        policy_period,
        participants_count,
        payment_status,
        total_amount,
        paid_at,
        policy_date,
        policy_start_date,
        policy_end_date
      FROM applications
      WHERE id = ?
      LIMIT 1
    `).get(
      applicationId
    ) as
      | PaymentApplicationRow
      | undefined;

  if (!application) {
    throw new Error(
      "Заявка не найдена"
    );
  }

  return application;
}

// ---------------------------------------------------------------------
// RETURN EXISTING PAID RESULT
// ---------------------------------------------------------------------

function existingPaidResult(
  application:
    PaymentApplicationRow
): PaymentResult {
  if (
    !application.paid_at ||
    !application.policy_date ||
    !application.policy_start_date ||
    !application.policy_end_date
  ) {
    throw new Error(
      "Данные уже оплаченной заявки неполные"
    );
  }

  return {
    applicationId:
      application.id,

    amount:
      application.total_amount,

    paymentStatus:
      "paid",

    paidAt:
      application.paid_at,

    policyDate:
      application.policy_date,

    policyStartDate:
      application.policy_start_date,

    policyEndDate:
      application.policy_end_date,
  };
}

// ---------------------------------------------------------------------
// SIMULATED SUCCESSFUL PAYMENT
// ---------------------------------------------------------------------

export function simulateSuccessfulPayment(
  applicationId: number
): PaymentResult {
  const application =
    getApplicationForPayment(
      applicationId
    );

  if (
    application.payment_status ===
    "paid"
  ) {
    return existingPaidResult(
      application
    );
  }

  if (
    !application.policy_period
  ) {
    throw new Error(
      "Для заявки не выбран период страхования"
    );
  }

  if (
    application.participants_count <=
    0
  ) {
    throw new Error(
      "В заявке нет участников"
    );
  }

  const pricePerPerson =
    getPricePerPerson(
      application.policy_period
    );

  const totalAmount =
    calculateTotalAmount(
      application.policy_period,
      application.participants_count
    );

  const dates =
    calculatePolicyDates(
      application.policy_period
    );

  const transaction =
    db.transaction(() => {
      db.prepare(`
        UPDATE applications
        SET
          price_per_person = ?,
          total_amount = ?,
          payment_status = 'paid',
          paid_at = ?,
          policy_date = ?,
          policy_start_date = ?,
          policy_end_date = ?
        WHERE id = ?
      `).run(
        pricePerPerson,
        totalAmount,
        dates.paidAt,
        dates.policyDate,
        dates.startDate,
        dates.endDate,
        applicationId
      );

      db.prepare(`
        INSERT INTO payments (
          application_id,
          provider,
          external_payment_id,
          amount,
          status,
          receipt_id,
          receipt_status,
          receipt_email,
          paid_at,
          created_at
        )
        VALUES (
          ?,
          'simulator',
          NULL,
          ?,
          'paid',
          NULL,
          'simulated',
          NULL,
          ?,
          ?
        )
      `).run(
        applicationId,
        totalAmount,
        dates.paidAt,
        nowIso()
      );
    });

  transaction();

  return {
    applicationId,
    amount:
      totalAmount,
    paymentStatus:
      "paid",
    paidAt:
      dates.paidAt,
    policyDate:
      dates.policyDate,
    policyStartDate:
      dates.startDate,
    policyEndDate:
      dates.endDate,
  };
}

// ---------------------------------------------------------------------
// REAL PAYMENT / FUTURE YOOKASSA
// ---------------------------------------------------------------------

export function registerRealSuccessfulPayment(
  input: RealPaymentInput
): PaymentResult {
  const application =
    getApplicationForPayment(
      input.applicationId
    );

  if (
    application.payment_status ===
    "paid"
  ) {
    return existingPaidResult(
      application
    );
  }

  if (
    !application.policy_period
  ) {
    throw new Error(
      "Для заявки не выбран период страхования"
    );
  }

  if (
    application.participants_count <=
    0
  ) {
    throw new Error(
      "В заявке нет участников"
    );
  }

  const expectedAmount =
    calculateTotalAmount(
      application.policy_period,
      application.participants_count
    );

  if (
    input.amount !==
    expectedAmount
  ) {
    throw new Error(
      `Некорректная сумма платежа. Ожидалось ${expectedAmount} ₽, получено ${input.amount} ₽`
    );
  }

  const paidDate =
    input.paidAt
      ? new Date(
          input.paidAt
        )
      : new Date();

  if (
    Number.isNaN(
      paidDate.getTime()
    )
  ) {
    throw new Error(
      "Некорректная дата оплаты"
    );
  }

  const pricePerPerson =
    getPricePerPerson(
      application.policy_period
    );

  const dates =
    calculatePolicyDates(
      application.policy_period,
      paidDate
    );

  const transaction =
    db.transaction(() => {
      db.prepare(`
        UPDATE applications
        SET
          price_per_person = ?,
          total_amount = ?,
          payment_status = 'paid',
          paid_at = ?,
          policy_date = ?,
          policy_start_date = ?,
          policy_end_date = ?
        WHERE id = ?
      `).run(
        pricePerPerson,
        expectedAmount,
        dates.paidAt,
        dates.policyDate,
        dates.startDate,
        dates.endDate,
        input.applicationId
      );

      db.prepare(`
        INSERT INTO payments (
          application_id,
          provider,
          external_payment_id,
          amount,
          status,
          receipt_id,
          receipt_status,
          receipt_email,
          paid_at,
          created_at
        )
        VALUES (
          ?,
          'yookassa',
          ?,
          ?,
          'paid',
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `).run(
        input.applicationId,
        input.externalPaymentId,
        expectedAmount,
        input.receiptId || null,
        input.receiptStatus || null,
        input.receiptEmail || null,
        dates.paidAt,
        nowIso()
      );
    });

  transaction();

  return {
    applicationId:
      input.applicationId,
    amount:
      expectedAmount,
    paymentStatus:
      "paid",
    paidAt:
      dates.paidAt,
    policyDate:
      dates.policyDate,
    policyStartDate:
      dates.startDate,
    policyEndDate:
      dates.endDate,
  };
}
