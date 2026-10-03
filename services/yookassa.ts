import {
  randomUUID,
} from "node:crypto";

import {
  config,
} from "../config.js";

type YooKassaAmount = {
  value: string;
  currency: string;
};

type YooKassaConfirmation = {
  type?: string;
  confirmation_url?: string;
};

type YooKassaPaymentResponse = {
  id: string;
  status:
    | "pending"
    | "waiting_for_capture"
    | "succeeded"
    | "canceled";
  paid: boolean;
  amount: YooKassaAmount;
  confirmation?: YooKassaConfirmation;
  created_at?: string;
  captured_at?: string;
  description?: string;
  metadata?: {
    application_id?: string;
  };
};

export type CreateYooKassaPaymentInput = {
  applicationId: number;
  amount: number;
  email?: string | null;
  returnUrl?: string;
  idempotenceKey?: string;
};

export type CreatedYooKassaPayment = {
  paymentId: string;
  status: string;
  confirmationUrl: string;
  amount: number;
};

export type YooKassaPaymentStatus = {
  paymentId: string;
  status:
    | "pending"
    | "waiting_for_capture"
    | "succeeded"
    | "canceled";
  paid: boolean;
  amount: number;
  capturedAt: string | null;
};

function authHeader():
  string {
  const credentials =
    Buffer.from(
      `${config.yookassa.shopId}:${config.yookassa.secretKey}`
    ).toString(
      "base64"
    );

  return `Basic ${credentials}`;
}

async function parseResponse(
  response: Response
): Promise<any> {
  const text =
    await response.text();

  let data: any = null;

  if (text) {
    try {
      data =
        JSON.parse(text);
    } catch {
      data = {
        raw: text,
      };
    }
  }

  if (!response.ok) {
    console.error(
      "YooKassa API error:",
      response.status,
      data
    );

    const description =
      data?.description ||
      data?.message ||
      `HTTP ${response.status}`;

    throw new Error(
      `Ошибка ЮKassa: ${description}`
    );
  }

  return data;
}

export async function createYooKassaPayment(
  input: CreateYooKassaPaymentInput
): Promise<CreatedYooKassaPayment> {
  if (
    !Number.isFinite(
      input.amount
    ) ||
    input.amount <= 0
  ) {
    throw new Error(
      "Некорректная сумма платежа"
    );
  }

  if (
    !input.email
  ) {
    throw new Error(
      "Для создания чека нужен email пользователя"
    );
  }

  const body = {
    amount: {
      value:
        input.amount.toFixed(
          2
        ),
      currency:
        "RUB",
    },

    capture:
      true,

    confirmation: {
      type:
        "redirect",

      return_url:
        input.returnUrl || "https://t.me/",
    },

    description:
      `Страхование, заявка #${input.applicationId}`,

    metadata: {
      application_id:
        String(
          input.applicationId
        ),
    },

    receipt: {
      customer: {
        email:
          input.email,
      },

      items: [
        {
          description:
            "Услуги страхования",

          quantity:
            "1.00",

          amount: {
            value:
              input.amount.toFixed(
                2
              ),

            currency:
              "RUB",
          },

          vat_code:
            1,

          payment_mode:
            "full_payment",

          payment_subject:
            "service",
        },
      ],
    },
  };

  const response =
    await fetch(
      "https://api.yookassa.ru/v3/payments",
      {
        method:
          "POST",

        headers: {
          Authorization:
            authHeader(),

          "Content-Type":
            "application/json",

          "Idempotence-Key":
            input.idempotenceKey || randomUUID(),
        },

        body:
          JSON.stringify(
            body
          ),
      }
    );

  const payment =
    await parseResponse(
      response
    ) as YooKassaPaymentResponse;

  const confirmationUrl =
    payment.confirmation
      ?.confirmation_url;

  if (
    !payment.id
  ) {
    throw new Error(
      "ЮKassa не вернула ID платежа"
    );
  }

  if (
    !confirmationUrl
  ) {
    throw new Error(
      "ЮKassa не вернула ссылку на оплату"
    );
  }

  return {
    paymentId:
      payment.id,

    status:
      payment.status,

    confirmationUrl,

    amount:
      Number(
        payment.amount.value
      ),
  };
}

export async function getYooKassaPayment(
  paymentId: string
): Promise<YooKassaPaymentStatus> {
  if (
    !paymentId.trim()
  ) {
    throw new Error(
      "Не указан ID платежа"
    );
  }

  const response =
    await fetch(
      `https://api.yookassa.ru/v3/payments/${encodeURIComponent(
        paymentId
      )}`,
      {
        method:
          "GET",

        headers: {
          Authorization:
            authHeader(),

          "Content-Type":
            "application/json",
        },
      }
    );

  const payment =
    await parseResponse(
      response
    ) as YooKassaPaymentResponse;

  return {
    paymentId:
      payment.id,

    status:
      payment.status,

    paid:
      payment.paid,

    amount:
      Number(
        payment.amount.value
      ),

    capturedAt:
      payment.captured_at ||
      null,
  };
}
