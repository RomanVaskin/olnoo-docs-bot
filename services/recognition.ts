import type { Api } from "grammy";

import { config } from "../config.js";

import type { PassportData } from "../types.js";

import { normalizeDocument } from "./document-normalizer.js";

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

const OCR_URL =
  process.env.OCR_URL ||
  "http://127.0.0.1:3020";

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

function clean(
  value: unknown
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}

// ---------------------------------------------------------------------
// TELEGRAM FILE DOWNLOAD
// ---------------------------------------------------------------------

export async function downloadTelegramFile(
  api: Api,
  fileId: string
): Promise<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
}> {
  const file =
    await api.getFile(fileId);

  if (!file.file_path) {
    throw new Error(
      "Telegram did not return file_path"
    );
  }

  const url =
    `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed: ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  const filePath =
    file.file_path.toLowerCase();

  let mimeType =
    "application/octet-stream";

  if (
    filePath.endsWith(".jpg") ||
    filePath.endsWith(".jpeg")
  ) {
    mimeType =
      "image/jpeg";
  } else if (
    filePath.endsWith(".png")
  ) {
    mimeType =
      "image/png";
  } else if (
    filePath.endsWith(".webp")
  ) {
    mimeType =
      "image/webp";
  } else if (
    filePath.endsWith(".pdf")
  ) {
    mimeType =
      "application/pdf";
  }

  return {
    buffer,
    filename:
      file.file_path
        .split("/")
        .pop() ||
      "document.jpg",
    mimeType,
  };
}

// ---------------------------------------------------------------------
// PASSPORT RECOGNITION
// ---------------------------------------------------------------------

export async function recognizePassport(
  fileBuffer: Buffer,
  mimeType: string,
  filename = "document"
): Promise<PassportData> {
  const normalized =
    await normalizeDocument(
      fileBuffer,
      filename,
      mimeType
    );

  fileBuffer =
    normalized.buffer;

  mimeType =
    normalized.mimeType;

  const form =
    new FormData();

  const blob =
    new Blob(
      [new Uint8Array(fileBuffer)],
      {
        type: mimeType,
      }
    );

  form.append(
    "file",
    blob,
    filename
  );

  const response =
    await fetch(
      `${OCR_URL}/passport`,
      {
        method: "POST",
        body: form,
      }
    );

  const raw =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `OLNOO OCR error ${response.status}: ${raw.slice(
        0,
        1500
      )}`
    );
  }

  let result: unknown;

  try {
    result =
      JSON.parse(raw);
  } catch {
    throw new Error(
      `OLNOO OCR returned invalid JSON: ${raw.slice(
        0,
        1500
      )}`
    );
  }

  if (
    !result ||
    typeof result !== "object"
  ) {
    throw new Error(
      "OLNOO OCR returned invalid response"
    );
  }

  const root =
    result as Record<
      string,
      unknown
    >;

  if (root.ok !== true) {
    throw new Error(
      `OLNOO OCR recognition failed: ${raw.slice(
        0,
        1500
      )}`
    );
  }

  const routerData =
    root.data;

  if (
    !routerData ||
    typeof routerData !== "object"
  ) {
    throw new Error(
      "OLNOO OCR did not return AI data"
    );
  }

  const output =
    (
      routerData as {
        output?: unknown;
      }
    ).output;

  if (
    !output ||
    typeof output !== "object"
  ) {
    throw new Error(
      `OLNOO OCR did not return structured output: ${raw.slice(
        0,
        1500
      )}`
    );
  }

  const parsed =
    output as Record<
      string,
      unknown
    >;

  return {
    documentType:
      clean(
        parsed.documentType
      ),

    lastName:
      clean(
        parsed.lastName
      ),

    firstName:
      clean(
        parsed.firstName
      ),

    middleName:
      clean(
        parsed.middleName
      ),

    birthDate:
      clean(
        parsed.birthDate
      ),

    birthPlace:
      clean(
        parsed.birthPlace
      ),

    gender:
      clean(
        parsed.gender
      ),

    passportSeries:
      clean(
        parsed.passportSeries
      ),

    passportNumber:
      clean(
        parsed.passportNumber
      ),

    issueDate:
      clean(
        parsed.issueDate
      ),

    issuedBy:
      clean(
        parsed.issuedBy
      ),

    departmentCode:
      clean(
        parsed.departmentCode
      ),
  };
}
