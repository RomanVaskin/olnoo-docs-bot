import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

import { db, nowIso } from "../db.js";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

type ExportRow = {
  source: "web" | "telegram";
  insurer: "ingos" | "reso" | null;
  insurance_policy_type: "VI" | "VK" | "SYS" | null;
  application_id: number;

  tournament_id: number;
  tournament_name: string;

  application_type:
    | "individual"
    | "group";

  policy_number: string | null;

  policy_date: string | null;
  policy_start_date: string | null;
  policy_end_date: string | null;

  policy_period:
    | "day"
    | "month"
    | "year"
    | null;

  payment_status: string;

  total_amount: number;

  paid_at: string | null;

  policy_status: string;

  issued_at: string | null;

  participant_id: number;

  last_name: string;
  first_name: string;
  middle_name: string;

  birth_date: string;
  birth_place: string;
  gender: string;

  passport_series: string;
  passport_number: string;

  issue_date: string;
  issued_by: string;
  department_code: string;

  telegram_user_id: string;

  telegram_username: string | null;

  telegram_name: string | null;

  email: string | null;
};

export type ExcelExportResult = {
  batchId: string;

  filePath: string;

  applicationsCount: number;

  participantsCount: number;
};

// ---------------------------------------------------------------------
// EXPORT DIR
// ---------------------------------------------------------------------

const exportDir =
  path.join(
    process.cwd(),
    "exports"
  );

fs.mkdirSync(
  exportDir,
  {
    recursive: true,
  }
);

// ---------------------------------------------------------------------
// BATCH ID
// ---------------------------------------------------------------------

function createBatchId():
  string {
  const now =
    new Date();

  const year =
    now.getFullYear();

  const month =
    String(
      now.getMonth() + 1
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      now.getDate()
    ).padStart(
      2,
      "0"
    );

  const prefix =
    `EXPORT-${year}-${month}-${day}`;

  const row =
    db.prepare(`
      SELECT
        COUNT(*) AS count
      FROM export_batches
      WHERE batch_id LIKE ?
    `).get(
      `${prefix}-%`
    ) as {
      count: number;
    };

  const sequence =
    String(
      (row.count || 0) + 1
    ).padStart(
      3,
      "0"
    );

  return `${prefix}-${sequence}`;
}

// ---------------------------------------------------------------------
// PERIOD LABEL
// ---------------------------------------------------------------------

function periodLabel(
  period:
    | "day"
    | "month"
    | "year"
    | null
): string {
  if (
    period === "day"
  ) {
    return "1 день";
  }

  if (
    period === "month"
  ) {
    return "1 месяц";
  }

  if (
    period === "year"
  ) {
    return "1 год";
  }

  return "";
}

// ---------------------------------------------------------------------
// TYPE LABEL
// ---------------------------------------------------------------------

function applicationTypeLabel(
  type:
    | "individual"
    | "group"
): string {
  return type ===
    "individual"
    ? "Индивидуальный"
    : "Групповой";
}

// ---------------------------------------------------------------------
// GET EXPORT ROWS
// ---------------------------------------------------------------------

function getRowsForExport(
  tournamentId: number
): ExportRow[] {
  return db.prepare(`
    SELECT
      a.source,
      a.insurer,
      a.policy_type AS insurance_policy_type,
      a.id AS application_id,

      a.tournament_id,
      t.name AS tournament_name,

      a.application_type,

      a.policy_number,

      a.policy_date,
      a.policy_start_date,
      a.policy_end_date,

      a.policy_period,

      a.payment_status,

      a.total_amount,

      a.paid_at,

      a.policy_status,

      a.issued_at,

      p.id AS participant_id,

      p.last_name,
      p.first_name,
      p.middle_name,

      p.birth_date,
      p.birth_place,
      p.gender,

      p.passport_series,
      p.passport_number,

      p.issue_date,
      p.issued_by,
      p.department_code,

      u.telegram_user_id,

      u.telegram_username,

      u.telegram_name,

      u.email

    FROM applications a

    INNER JOIN tournaments t
      ON t.id = a.tournament_id

    INNER JOIN participants p
      ON p.application_id = a.id

    INNER JOIN users u
      ON u.telegram_user_id =
         a.submitted_by_user_id

    WHERE
      a.tournament_id = ?

      AND a.payment_status = 'paid'

      AND a.policy_status = 'issued'

      AND a.exported_to_insurer = 0

    ORDER BY
      a.id ASC,
      p.id ASC
  `).all(
    tournamentId
  ) as ExportRow[];
}

// ---------------------------------------------------------------------
// GENERATE EXCEL
// ---------------------------------------------------------------------

export async function generateInsurerExcel(
  tournamentId: number
): Promise<ExcelExportResult> {
  const tournament =
    db.prepare(`
      SELECT
        id,
        name
      FROM tournaments
      WHERE id = ?
      LIMIT 1
    `).get(
      tournamentId
    ) as
      | {
          id: number;
          name: string;
        }
      | undefined;

  if (!tournament) {
    throw new Error(
      "Турнир не найден"
    );
  }

  const rows =
    getRowsForExport(
      tournamentId
    );

  if (
    rows.length === 0
  ) {
    throw new Error(
      "Нет новых оплаченных и выданных полисов для выгрузки"
    );
  }

  const batchId =
    createBatchId();

  const workbook =
    new ExcelJS.Workbook();

  workbook.creator =
    "OLNOO Docs";

  workbook.created =
    new Date();

  const sheet =
    workbook.addWorksheet(
      "Страховая"
    );

  // -------------------------------------------------------------------
  // COLUMNS
  // -------------------------------------------------------------------

  sheet.columns = [
    { header: "Источник", key: "source", width: 14 },
    { header: "Страховая", key: "insurer", width: 18 },
    { header: "Тип полиса", key: "insurancePolicyType", width: 14 },
    {
      header:
        "Турнир",
      key:
        "tournament",
      width:
        28,
    },

    {
      header:
        "Тип заявки",
      key:
        "applicationType",
      width:
        20,
    },

    {
      header:
        "ID заявки",
      key:
        "applicationId",
      width:
        12,
    },

    {
      header:
        "Фамилия",
      key:
        "lastName",
      width:
        20,
    },

    {
      header:
        "Имя",
      key:
        "firstName",
      width:
        20,
    },

    {
      header:
        "Отчество",
      key:
        "middleName",
      width:
        22,
    },

    {
      header:
        "Дата рождения",
      key:
        "birthDate",
      width:
        16,
    },

    {
      header:
        "Место рождения",
      key:
        "birthPlace",
      width:
        30,
    },

    {
      header:
        "Пол",
      key:
        "gender",
      width:
        12,
    },

    {
      header:
        "Серия паспорта",
      key:
        "passportSeries",
      width:
        16,
    },

    {
      header:
        "Номер паспорта",
      key:
        "passportNumber",
      width:
        18,
    },

    {
      header:
        "Дата выдачи",
      key:
        "issueDate",
      width:
        16,
    },

    {
      header:
        "Кем выдан",
      key:
        "issuedBy",
      width:
        42,
    },

    {
      header:
        "Код подразделения",
      key:
        "departmentCode",
      width:
        20,
    },

    {
      header:
        "Номер полиса",
      key:
        "policyNumber",
      width:
        20,
    },

    {
      header:
        "Дата полиса",
      key:
        "policyDate",
      width:
        16,
    },

    {
      header:
        "Начало полиса",
      key:
        "policyStartDate",
      width:
        16,
    },

    {
      header:
        "Окончание полиса",
      key:
        "policyEndDate",
      width:
        18,
    },

    {
      header:
        "Период",
      key:
        "policyPeriod",
      width:
        14,
    },

    {
      header:
        "Статус оплаты",
      key:
        "paymentStatus",
      width:
        16,
    },

    {
      header:
        "Сумма заявки",
      key:
        "totalAmount",
      width:
        16,
    },

    {
      header:
        "Оплачено",
      key:
        "paidAt",
      width:
        24,
    },

    {
      header:
        "Статус полиса",
      key:
        "policyStatus",
      width:
        16,
    },

    {
      header:
        "Выдан",
      key:
        "issuedAt",
      width:
        24,
    },

    {
      header:
        "Telegram ID",
      key:
        "telegramUserId",
      width:
        18,
    },

    {
      header:
        "Telegram",
      key:
        "telegramUsername",
      width:
        20,
    },

    {
      header:
        "Имя пользователя",
      key:
        "telegramName",
      width:
        24,
    },

    {
      header:
        "Email",
      key:
        "email",
      width:
        28,
    },

    {
      header:
        "Export Batch",
      key:
        "batchId",
      width:
        28,
    },
  ];

  // -------------------------------------------------------------------
  // DATA
  // -------------------------------------------------------------------

  for (
    const row
    of rows
  ) {
    sheet.addRow({
      source: row.source || "telegram",
      insurer: row.insurer === "reso" ? "РЕСО-Гарантия" : row.insurer === "ingos" ? "Ингосстрах" : "",
      insurancePolicyType: row.insurance_policy_type || "",
      tournament:
        row.tournament_name,

      applicationType:
        applicationTypeLabel(
          row.application_type
        ),

      applicationId:
        row.application_id,

      lastName:
        row.last_name,

      firstName:
        row.first_name,

      middleName:
        row.middle_name,

      birthDate:
        row.birth_date,

      birthPlace:
        row.birth_place,

      gender:
        row.gender,

      passportSeries:
        row.passport_series,

      passportNumber:
        row.passport_number,

      issueDate:
        row.issue_date,

      issuedBy:
        row.issued_by,

      departmentCode:
        row.department_code,

      policyNumber:
        row.policy_number || "",

      policyDate:
        row.policy_date || "",

      policyStartDate:
        row.policy_start_date || "",

      policyEndDate:
        row.policy_end_date || "",

      policyPeriod:
        periodLabel(
          row.policy_period
        ),

      paymentStatus:
        row.payment_status,

      totalAmount:
        row.total_amount,

      paidAt:
        row.paid_at || "",

      policyStatus:
        row.policy_status,

      issuedAt:
        row.issued_at || "",

      telegramUserId:
        row.telegram_user_id,

      telegramUsername:
        row.telegram_username
          ? `@${row.telegram_username}`
          : "",

      telegramName:
        row.telegram_name || "",

      email:
        row.email || "",

      batchId,
    });
  }

  // -------------------------------------------------------------------
  // HEADER STYLE
  // -------------------------------------------------------------------

  const headerRow =
    sheet.getRow(1);

  headerRow.font = {
    bold: true,
    color: {
      argb:
        "FFFFFFFF",
    },
  };

  headerRow.fill = {
    type:
      "pattern",

    pattern:
      "solid",

    fgColor: {
      argb:
        "FF1F2937",
    },
  };

  headerRow.alignment = {
    vertical:
      "middle",

    horizontal:
      "center",

    wrapText:
      true,
  };

  headerRow.height =
    34;

  // -------------------------------------------------------------------
  // BODY STYLE
  // -------------------------------------------------------------------

  sheet.eachRow(
    (
      row,
      rowNumber
    ) => {
      if (
        rowNumber === 1
      ) {
        return;
      }

      row.alignment = {
        vertical:
          "top",

        wrapText:
          true,
      };
    }
  );

  sheet.views = [
    {
      state:
        "frozen",

      ySplit:
        1,
    },
  ];

  sheet.autoFilter = {
    from:
      "A1",

    to:
      "AC1",
  };

  // -------------------------------------------------------------------
  // SAVE
  // -------------------------------------------------------------------

  const safeTournamentName =
    tournament.name
      .replace(
        /[^a-zA-Zа-яА-Я0-9_-]+/g,
        "_"
      )
      .slice(
        0,
        60
      );

  const fileName =
    `${batchId}_${safeTournamentName}.xlsx`;

  const filePath =
    path.join(
      exportDir,
      fileName
    );

  await workbook.xlsx.writeFile(
    filePath
  );

  // -------------------------------------------------------------------
  // MARK EXPORTED ONLY AFTER FILE WAS CREATED
  // -------------------------------------------------------------------

  const applicationIds =
    [
      ...new Set(
        rows.map(
          row =>
            row.application_id
        )
      ),
    ];

  const transaction =
    db.transaction(() => {
      db.prepare(`
        INSERT INTO export_batches (
          batch_id,
          tournament_id,
          rows_count,
          file_path,
          insurer_paid,
          insurer_paid_at,
          created_at
        )

        VALUES (
          ?,
          ?,
          ?,
          ?,
          0,
          NULL,
          ?
        )
      `).run(
        batchId,
        tournamentId,
        rows.length,
        filePath,
        nowIso()
      );

      const markExported =
        db.prepare(`
          UPDATE applications
          SET
            exported_to_insurer = 1,
            export_batch_id = ?
          WHERE id = ?
        `);

      for (
        const applicationId
        of applicationIds
      ) {
        markExported.run(
          batchId,
          applicationId
        );
      }
    });

  transaction();

  return {
    batchId,

    filePath,

    applicationsCount:
      applicationIds.length,

    participantsCount:
      rows.length,
  };
}

// ---------------------------------------------------------------------
// MARK INSURER PAID
// ---------------------------------------------------------------------

export function markExportBatchInsurerPaid(
  batchId: string
): void {
  const result =
    db.prepare(`
      UPDATE export_batches
      SET
        insurer_paid = 1,
        insurer_paid_at = ?
      WHERE batch_id = ?
    `).run(
      nowIso(),
      batchId
    );

  if (
    result.changes !== 1
  ) {
    throw new Error(
      "Партия выгрузки не найдена"
    );
  }
}
