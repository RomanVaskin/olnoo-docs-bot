import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  PDFDocument,
  PDFFont,
  PDFPage,
  rgb,
} from "pdf-lib";

import fontkit from "@pdf-lib/fontkit";

import { db } from "../db.js";

import type {
  Application,
  Participant,
} from "../types.js";

import {
  getApplicationById,
  listApplicationParticipants,
} from "./applications.js";

import {
  markPolicyNumberIssued,
  releaseReservedPolicyNumber,
  reserveNextPolicyNumber,
} from "./policy-numbers.js";

export type PolicyGenerationResult = {
  applicationId: number;
  policyNumber: string;
  policyType: "individual" | "group";
  filePath: string;
  participantsCount: number;
};

const templatesDir =
  path.join(
    process.cwd(),
    "templates"
  );

const exportsDir =
  path.join(
    process.cwd(),
    "exports"
  );

const tempDir =
  path.join(
    process.cwd(),
    "data",
    "pdf-temp"
  );

const individualTemplatePath =
  path.join(
    templatesDir,
    "individual.pdf"
  );

const groupTemplatePath =
  path.join(
    templatesDir,
    "group.pdf"
  );

const resoTemplatePath = path.join(templatesDir, "reso.pdf");

export const RESO_COORDINATES = {
  policyNumber: { x: 190, y: 759, width: 105, size: 8.5 },
  policyDate: { x: 310, y: 759, width: 72, size: 8.5 },
  fullName: { x: 183, y: 718, width: 348, size: 8.5 },
  birthDate: { x: 183, y: 706, width: 120, size: 8.2 },
  document: { x: 183, y: 691, width: 250, size: 8.2 },
  policyStartDate: { x: 200, y: 660, width: 80, size: 8.2 },
  policyEndDate: { x: 300, y: 660, width: 80, size: 8.2 },
  sport: { x: 183, y: 548, width: 348, size: 8.5 },
  insuranceAmountDeath: { x: 472, y: 495, width: 62, size: 8.2 },
  insuranceAmountDisability: { x: 472, y: 448, width: 62, size: 8.2 },
  insuranceAmountInjury: { x: 472, y: 396, width: 62, size: 8.2 },
} as const;

const regularFontPath =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

const boldFontPath =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

fs.mkdirSync(
  exportsDir,
  {
    recursive: true,
  }
);

fs.mkdirSync(
  tempDir,
  {
    recursive: true,
  }
);

function fullName(
  participant: Participant
): string {
  return [
    participant.lastName,
    participant.firstName,
    participant.middleName,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
}

function safeFileName(
  value: string
): string {
  return value.replace(
    /[^a-zA-Zа-яА-Я0-9_-]+/g,
    "_"
  );
}

function drawTextFit(
  page: PDFPage,
  text: string,
  font: PDFFont,
  options: {
    x: number;
    y: number;
    width: number;
    size: number;
    minSize?: number;
  }
): void {
  let size =
    options.size;

  const minSize =
    options.minSize ?? 4;

  while (
    size > minSize &&
    font.widthOfTextAtSize(
      text,
      size
    ) > options.width
  ) {
    size -= 0.15;
  }

  page.drawText(
    text,
    {
      x: options.x,
      y: options.y,
      size,
      font,
      color: rgb(
        0,
        0,
        0
      ),
    }
  );
}

function pdfYFromTop(
  page: PDFPage,
  top: number
): number {
  return (
    page.getHeight() -
    top
  );
}

function normalizePdf(
  inputPath: string,
  outputPath: string
): void {
  if (
    fs.existsSync(
      outputPath
    )
  ) {
    fs.unlinkSync(
      outputPath
    );
  }

  execFileSync(
    "gs",
    [
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dPDFSETTINGS=/prepress",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      `-sOutputFile=${outputPath}`,
      inputPath,
    ],
    {
      stdio: "pipe",
    }
  );

  if (
    !fs.existsSync(
      outputPath
    )
  ) {
    throw new Error(
      "Ghostscript не создал финальный PDF"
    );
  }

  if (
    fs.statSync(
      outputPath
    ).size < 1000
  ) {
    throw new Error(
      "Финальный PDF повреждён"
    );
  }
}

function ensureFonts():
  void {
  if (
    !fs.existsSync(
      regularFontPath
    )
  ) {
    throw new Error(
      "Не найден DejaVuSans.ttf"
    );
  }

  if (
    !fs.existsSync(
      boldFontPath
    )
  ) {
    throw new Error(
      "Не найден DejaVuSans-Bold.ttf"
    );
  }
}

function ensureApplicationCanBeIssued(
  application: Application,
  participants: Participant[]
): void {
  if (application.insurer === "reso" && (application.applicationType !== "individual" || application.insurancePolicyType !== "SYS")) {
    throw new Error("РЕСО поддерживает только индивидуальный годовой продукт SYS");
  }
  if (application.insurancePolicyType === "SYS" && application.insurer !== "reso") {
    throw new Error("SYS может выпускаться только страховой РЕСО");
  }
  if (
    application.paymentStatus !==
    "paid"
  ) {
    throw new Error(
      "Заявка не оплачена"
    );
  }

  if (
    !application.policyDate ||
    !application.policyStartDate ||
    !application.policyEndDate
  ) {
    throw new Error(
      "В заявке отсутствуют даты полиса"
    );
  }

  if (
    participants.length === 0
  ) {
    throw new Error(
      "В заявке нет участников"
    );
  }

  if (
    application.applicationType ===
      "individual" &&
    participants.length !== 1
  ) {
    throw new Error(
      "В индивидуальной заявке должен быть один участник"
    );
  }

  if (
    application.applicationType ===
      "group" &&
    participants.length < 2
  ) {
    throw new Error(
      "В групповой заявке должно быть минимум два участника"
    );
  }
}

async function saveFinalPdf(
  pdf: PDFDocument,
  policyNumber: string
): Promise<string> {
  const safePolicyNumber =
    safeFileName(
      policyNumber
    );

  const tempFilePath =
    path.join(
      tempDir,
      `${safePolicyNumber}-${Date.now()}.pdf`
    );

  const finalFilePath =
    path.join(
      exportsDir,
      `${safePolicyNumber}.pdf`
    );

  const bytes =
    await pdf.save({
      useObjectStreams: false,
    });

  fs.writeFileSync(
    tempFilePath,
    bytes
  );

  try {
    normalizePdf(
      tempFilePath,
      finalFilePath
    );
  } finally {
    if (
      fs.existsSync(
        tempFilePath
      )
    ) {
      fs.unlinkSync(
        tempFilePath
      );
    }
  }

  return finalFilePath;
}

async function createIndividualPolicy(
  application: Application,
  participant: Participant,
  policyNumber: string
): Promise<string> {
  ensureFonts();

  if (
    !fs.existsSync(
      individualTemplatePath
    )
  ) {
    throw new Error(
      "Не найден templates/individual.pdf"
    );
  }

  const pdf =
    await PDFDocument.load(
      fs.readFileSync(
        individualTemplatePath
      )
    );

  pdf.registerFontkit(
    fontkit
  );

  const regularFont =
    await pdf.embedFont(
      fs.readFileSync(
        regularFontPath
      )
    );

  const boldFont =
    await pdf.embedFont(
      fs.readFileSync(
        boldFontPath
      )
    );

  const page =
    pdf.getPages()[0];

  if (!page) {
    throw new Error(
      "Шаблон individual.pdf пуст"
    );
  }

  const fio =
    fullName(
      participant
    );

  const startDate =
    application.policyStartDate ||
    "";

  const endDate =
    application.policyEndDate ||
    "";

  const policyDate =
    application.policyDate ||
    "";

  drawTextFit(
    page,
    policyNumber,
    boldFont,
    {
      x: 327,
      y: 802,
      width: 92,
      size: 8.8,
      minSize: 7,
    }
  );

  drawTextFit(
    page,
    fio,
    regularFont,
    {
      x: 25,
      y: 667,
      width: 195,
      size: 6.6,
      minSize: 5,
    }
  );

  drawTextFit(
    page,
    participant.birthDate || "",
    regularFont,
    {
      x: 226,
      y: 667,
      width: 68,
      size: 6.2,
      minSize: 5,
    }
  );

  const fioParts =
    [
      participant.lastName,
      participant.firstName,
      participant.middleName,
    ]
      .filter(Boolean)
      .map(
        value =>
          value.toUpperCase()
      );

  let tableY =
    565;

  for (
    const line
    of fioParts
  ) {
    drawTextFit(
      page,
      line,
      regularFont,
      {
        x: 25,
        y: tableY,
        width: 72,
        size: 5.7,
        minSize: 4.3,
      }
    );

    tableY -=
      7.2;
  }

  drawTextFit(
    page,
    startDate,
    regularFont,
    {
      x: 306,
      y: 460,
      width: 43,
      size: 5.4,
      minSize: 4.8,
    }
  );

  drawTextFit(
    page,
    endDate,
    regularFont,
    {
      x: 354,
      y: 460,
      width: 43,
      size: 5.4,
      minSize: 4.8,
    }
  );

  drawTextFit(
    page,
    policyDate,
    regularFont,
    {
      x: 272,
      y: 424,
      width: 48,
      size: 5.4,
      minSize: 4.8,
    }
  );

  drawTextFit(
    page,
    policyDate,
    boldFont,
    {
      x: 466,
      y: 132,
      width: 54,
      size: 6.4,
      minSize: 5.5,
    }
  );

  return saveFinalPdf(
    pdf,
    policyNumber
  );
}

const VK_TABLE = {
  fioLeft: 42.5,
  fioRight: 138.8,

  dobLeft: 138.8,
  dobRight: 188.4,

  periodLeft: 297.7,
  periodRight: 358.6,

  firstRowTop: 121.6,

  rowHeight: 31.55,
};

function drawVkParticipant(
  page: PDFPage,
  participant: Participant,
  index: number,
  startDate: string,
  endDate: string,
  font: PDFFont
): void {
  const rowTop =
    VK_TABLE.firstRowTop +
    index *
      VK_TABLE.rowHeight;

  const fioWidth =
    VK_TABLE.fioRight -
    VK_TABLE.fioLeft;

  const dobWidth =
    VK_TABLE.dobRight -
    VK_TABLE.dobLeft;

  const periodWidth =
    VK_TABLE.periodRight -
    VK_TABLE.periodLeft;

  const fioLines =
    [
      participant.lastName,
      participant.firstName,
      participant.middleName,
    ]
      .filter(Boolean)
      .map(
        value =>
          value.toUpperCase()
      );

  for (
    let lineIndex = 0;
    lineIndex <
    fioLines.length;
    lineIndex++
  ) {
    drawTextFit(
      page,
      fioLines[lineIndex],
      font,
      {
        x:
          VK_TABLE.fioLeft +
          4,

        y:
          pdfYFromTop(
            page,
            rowTop +
              8 +
              lineIndex *
                6.1
          ),

        width:
          fioWidth -
          8,

        size: 4.7,

        minSize: 3.6,
      }
    );
  }

  drawTextFit(
    page,
    participant.birthDate ||
      "",
    font,
    {
      x:
        VK_TABLE.dobLeft +
        4,

      y:
        pdfYFromTop(
          page,
          rowTop +
            18
        ),

      width:
        dobWidth -
        8,

      size: 4.8,

      minSize: 4,
    }
  );

  drawTextFit(
    page,
    startDate,
    font,
    {
      x:
        VK_TABLE.periodLeft +
        4,

      y:
        pdfYFromTop(
          page,
          rowTop +
            11
        ),

      width:
        periodWidth -
        8,

      size: 4.6,

      minSize: 3.8,
    }
  );

  drawTextFit(
    page,
    endDate,
    font,
    {
      x:
        VK_TABLE.periodLeft +
        4,

      y:
        pdfYFromTop(
          page,
          rowTop +
            20
        ),

      width:
        periodWidth -
        8,

      size: 4.6,

      minSize: 3.8,
    }
  );
}

async function createGroupPolicy(
  application: Application,
  participants: Participant[],
  policyNumber: string
): Promise<string> {
  ensureFonts();

  if (
    !fs.existsSync(
      groupTemplatePath
    )
  ) {
    throw new Error(
      "Не найден templates/group.pdf"
    );
  }

  if (
    participants.length > 20
  ) {
    throw new Error(
      "Текущий VK-шаблон поддерживает максимум 20 участников"
    );
  }

  const pdf =
    await PDFDocument.load(
      fs.readFileSync(
        groupTemplatePath
      )
    );

  pdf.registerFontkit(
    fontkit
  );

  const regularFont =
    await pdf.embedFont(
      fs.readFileSync(
        regularFontPath
      )
    );

  const boldFont =
    await pdf.embedFont(
      fs.readFileSync(
        boldFontPath
      )
    );

  const pages =
    pdf.getPages();

  if (
    pages.length < 4
  ) {
    throw new Error(
      "group.pdf должен содержать 4 страницы"
    );
  }

  const page1 =
    pages[0];

  const page2 =
    pages[1];

  const page4 =
    pages[3];

  const policyDate =
    application.policyDate ||
    "";

  const startDate =
    application.policyStartDate ||
    "";

  const endDate =
    application.policyEndDate ||
    "";

  // PAGE 1 — VK NUMBER
  drawTextFit(
    page1,
    policyNumber,
    boldFont,
    {
      x: 305,
      y: 773,
      width: 100,
      size: 8.8,
      minSize: 7,
    }
  );

  // PAGE 1 — START
  drawTextFit(
    page1,
    startDate,
    regularFont,
    {
      x: 375,
      y: 567,
      width: 42,
      size: 5.2,
      minSize: 4.5,
    }
  );

  // PAGE 1 — END
  drawTextFit(
    page1,
    endDate,
    regularFont,
    {
      x: 417,
      y: 567,
      width: 42,
      size: 5.2,
      minSize: 4.5,
    }
  );

  // PAGE 1 — PAYMENT DATE
  drawTextFit(
    page1,
    policyDate,
    regularFont,
    {
      x: 275,
      y: 528,
      width: 50,
      size: 5.2,
      minSize: 4.5,
    }
  );

  // PAGE 1 — CONTRACT DATE
  drawTextFit(
    page1,
    policyDate,
    boldFont,
    {
      x: 374,
      y: 59,
      width: 56,
      size: 6.2,
      minSize: 5,
    }
  );

  // PAGE 2 — VK NUMBER
  drawTextFit(
    page2,
    policyNumber,
    regularFont,
    {
      x: 356,
      y: 793,
      width: 90,
      size: 6.4,
      minSize: 5.2,
    }
  );

  // PAGE 2 — DATE
  drawTextFit(
    page2,
    policyDate,
    regularFont,
    {
      x: 441,
      y: 793,
      width: 58,
      size: 6.4,
      minSize: 5.2,
    }
  );

  // PARTICIPANTS
  for (
    let index = 0;
    index <
    participants.length;
    index++
  ) {
    drawVkParticipant(
      page2,
      participants[index],
      index,
      startDate,
      endDate,
      regularFont
    );
  }

  // PAGE 4 — NUMBER
  drawTextFit(
    page4,
    policyNumber,
    regularFont,
    {
      x: 424,
      y: 784,
      width: 85,
      size: 6.2,
      minSize: 5,
    }
  );

  // PAGE 4 — DATE
  drawTextFit(
    page4,
    policyDate,
    regularFont,
    {
      x: 513,
      y: 784,
      width: 55,
      size: 6.2,
      minSize: 5,
    }
  );

  return saveFinalPdf(
    pdf,
    policyNumber
  );
}

/** RESO coordinates are deliberately isolated: calibrate only this object once
 * the insurer supplies templates/reso.pdf. No synthetic insurance form is made. */
export async function generateResoPolicy(
  application: Application,
  participant: Participant,
  policyNumber: string
): Promise<string> {
  ensureFonts();
  if (!fs.existsSync(resoTemplatePath)) {
    throw new Error("Не найден templates/reso.pdf (TODO: получить и откалибровать официальный шаблон РЕСО)");
  }
  const pdf = await PDFDocument.load(fs.readFileSync(resoTemplatePath));
  pdf.registerFontkit(fontkit);
  const regularFont = await pdf.embedFont(fs.readFileSync(regularFontPath));
  const boldFont = await pdf.embedFont(fs.readFileSync(boldFontPath));
  const page = pdf.getPages()[0];
  if (!page) throw new Error("Шаблон reso.pdf пуст");
  const document = [participant.passportSeries, participant.passportNumber].filter(Boolean).join(" ");
  const insuranceAmount = application.insuranceAmount ? application.insuranceAmount.toLocaleString("ru-RU") : "";
  const values: Array<[keyof typeof RESO_COORDINATES, string, PDFFont]> = [
    ["policyNumber", policyNumber, boldFont], ["policyDate", application.policyDate || "", regularFont],
    ["fullName", fullName(participant), boldFont], ["birthDate", participant.birthDate, regularFont],
    ["document", document, regularFont], ["policyStartDate", application.policyStartDate || "", regularFont],
    ["policyEndDate", application.policyEndDate || "", regularFont], ["sport", "Тхэквондо, Восточные единоборства, Кикбоксинг", boldFont],
    ["insuranceAmountDeath", insuranceAmount, boldFont], ["insuranceAmountDisability", insuranceAmount, boldFont],
    ["insuranceAmountInjury", insuranceAmount, boldFont],
  ];
  for (const [key, value, font] of values) drawTextFit(page, value || "", font, RESO_COORDINATES[key]);
  return saveFinalPdf(pdf, policyNumber);
}

function markGenerating(
  applicationId: number
): void {
  db.prepare(`
    UPDATE applications
    SET policy_status = 'generating'
    WHERE id = ?
  `).run(
    applicationId
  );
}

function markGenerationError(
  applicationId: number
): void {
  db.prepare(`
    UPDATE applications
    SET policy_status = 'error'
    WHERE id = ?
  `).run(
    applicationId
  );
}

export async function issuePolicy(
  applicationId: number
): Promise<PolicyGenerationResult> {
  const application =
    getApplicationById(
      applicationId
    );

  if (!application) {
    throw new Error(
      "Заявка не найдена"
    );
  }

  const participants =
    listApplicationParticipants(
      applicationId
    );

  ensureApplicationCanBeIssued(
    application,
    participants
  );

  if (
    application.policyStatus ===
      "issued" &&
    application.policyNumber
  ) {
    const existingFile =
      path.join(
        exportsDir,
        `${safeFileName(
          application.policyNumber
        )}.pdf`
      );

    if (
      fs.existsSync(
        existingFile
      )
    ) {
      return {
        applicationId,
        policyNumber:
          application.policyNumber,
        policyType:
          application.applicationType,
        filePath:
          existingFile,
        participantsCount:
          participants.length,
      };
    }
  }

  markGenerating(
    applicationId
  );

  const reserved =
    reserveNextPolicyNumber(
      application.insurancePolicyType || application.applicationType,
      applicationId
    );

  try {
    let filePath:
      string;

    if (application.insurer === "reso" && application.insurancePolicyType === "SYS") {
      filePath = await generateResoPolicy(application, participants[0], reserved.policyNumber);
    } else if (
      application.applicationType ===
      "individual"
    ) {
      filePath =
        await createIndividualPolicy(
          application,
          participants[0],
          reserved.policyNumber
        );
    } else {
      filePath =
        await createGroupPolicy(
          application,
          participants,
          reserved.policyNumber
        );
    }

    markPolicyNumberIssued(
      applicationId
    );

    return {
      applicationId,
      policyNumber:
        reserved.policyNumber,
      policyType:
        application.applicationType,
      filePath,
      participantsCount:
        participants.length,
    };
  } catch (error) {
    markGenerationError(
      applicationId
    );

    releaseReservedPolicyNumber(
      applicationId
    );

    throw error;
  }
}
