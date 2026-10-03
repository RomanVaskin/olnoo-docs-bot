import { db, nowIso } from "../db.js";

import type {
  Application,
  ApplicationType,
  Participant,
  PassportData,
  PolicyPeriod,
} from "../types.js";

import {
  calculateTotalAmount,
  getPricePerPerson,
} from "./payments.js";

// ---------------------------------------------------------------------
// DB ROW TYPES
// ---------------------------------------------------------------------

type DbApplicationRow = {
  id: number;

  submitted_by_user_id: string;

  tournament_id: number;

  application_type:
    ApplicationType;

  policy_period:
    PolicyPeriod | null;

  participants_count: number;

  price_per_person: number;

  total_amount: number;

  payment_status:
    Application["paymentStatus"];

  paid_at: string | null;

  policy_number: string | null;

  policy_date: string | null;

  policy_start_date:
    string | null;

  policy_end_date:
    string | null;

  policy_status:
    Application["policyStatus"];

  issued_at: string | null;

  exported_to_insurer: number;

  export_batch_id:
    string | null;

  created_at: string;
  source: "telegram" | "web";
  insurer: "ingos" | "reso" | null;
  policy_type: "VI" | "VK" | "SYS" | null;
  sport: string | null;
  insurance_amount: number | null;
};

type DbParticipantRow = {
  id: number;

  application_id: number;

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

  created_at: string;
};

// ---------------------------------------------------------------------
// MAPPERS
// ---------------------------------------------------------------------

function mapApplication(
  row: DbApplicationRow
): Application {
  return {
    id:
      row.id,

    submittedByUserId:
      row.submitted_by_user_id,

    tournamentId:
      row.tournament_id,

    applicationType:
      row.application_type,

    policyPeriod:
      row.policy_period,

    participantsCount:
      row.participants_count,

    pricePerPerson:
      row.price_per_person,

    totalAmount:
      row.total_amount,

    paymentStatus:
      row.payment_status,

    paidAt:
      row.paid_at,

    policyNumber:
      row.policy_number,

    policyDate:
      row.policy_date,

    policyStartDate:
      row.policy_start_date,

    policyEndDate:
      row.policy_end_date,

    policyStatus:
      row.policy_status,

    issuedAt:
      row.issued_at,

    exportedToInsurer:
      row.exported_to_insurer,

    exportBatchId:
      row.export_batch_id,

    createdAt:
      row.created_at,
    source: row.source || "telegram",
    insurer: row.insurer || null,
    insurancePolicyType: row.policy_type || null,
    sport: row.sport || null,
    insuranceAmount: row.insurance_amount || null,
  };
}

function mapParticipant(
  row: DbParticipantRow
): Participant {
  return {
    id:
      row.id,

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

    createdAt:
      row.created_at,
  };
}

// ---------------------------------------------------------------------
// CREATE APPLICATION
// ---------------------------------------------------------------------

export function createApplication(
  submittedByUserId: string,
  tournamentId: number,
  applicationType:
    ApplicationType
): Application {
  const user =
    db.prepare(`
      SELECT telegram_user_id
      FROM users
      WHERE telegram_user_id = ?
      LIMIT 1
    `).get(
      submittedByUserId
    );

  if (!user) {
    throw new Error(
      "Пользователь не найден"
    );
  }

  const tournament =
    db.prepare(`
      SELECT id
      FROM tournaments
      WHERE
        id = ?
        AND is_active = 1
      LIMIT 1
    `).get(
      tournamentId
    );

  if (!tournament) {
    throw new Error(
      "Турнир не найден или закрыт"
    );
  }

  const result =
    db.prepare(`
      INSERT INTO applications (
        submitted_by_user_id,
        tournament_id,
        application_type,
        policy_period,
        participants_count,
        price_per_person,
        total_amount,
        payment_status,
        paid_at,
        policy_number,
        policy_date,
        policy_start_date,
        policy_end_date,
        policy_status,
        issued_at,
        exported_to_insurer,
        export_batch_id,
        created_at,
        source,
        insurer,
        policy_type
      )
      VALUES (
        ?,
        ?,
        ?,
        NULL,
        0,
        0,
        0,
        'pending',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        'waiting',
        NULL,
        0,
        NULL,
        ?,
        'telegram',
        NULL,
        NULL
      )
    `).run(
      submittedByUserId,
      tournamentId,
      applicationType,
      nowIso()
    );

  const application =
    getApplicationById(
      Number(
        result.lastInsertRowid
      )
    );

  if (!application) {
    throw new Error(
      "Не удалось получить созданную заявку"
    );
  }

  return application;
}

// ---------------------------------------------------------------------
// GET APPLICATION
// ---------------------------------------------------------------------

export function getApplicationById(
  applicationId: number
): Application | null {
  const row =
    db.prepare(`
      SELECT
        id,
        submitted_by_user_id,
        tournament_id,
        application_type,
        policy_period,
        participants_count,
        price_per_person,
        total_amount,
        payment_status,
        paid_at,
        policy_number,
        policy_date,
        policy_start_date,
        policy_end_date,
        policy_status,
        issued_at,
        exported_to_insurer,
        export_batch_id,
        created_at,
        source,
        insurer,
        policy_type,
        sport,
        insurance_amount
      FROM applications
      WHERE id = ?
      LIMIT 1
    `).get(
      applicationId
    ) as
      | DbApplicationRow
      | undefined;

  if (!row) {
    return null;
  }

  return mapApplication(
    row
  );
}

// ---------------------------------------------------------------------
// ADD PARTICIPANT
// ---------------------------------------------------------------------

export function addParticipant(
  applicationId: number,
  data: PassportData
): Participant {
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
    application.paymentStatus ===
    "paid"
  ) {
    throw new Error(
      "Нельзя добавлять участников после оплаты"
    );
  }

  if (
    application.policyStatus ===
    "issued"
  ) {
    throw new Error(
      "Нельзя изменять уже оформленный полис"
    );
  }

  if (
    application.applicationType ===
      "individual" &&
    application.participantsCount >=
      1
  ) {
    throw new Error(
      "В индивидуальной заявке может быть только один участник"
    );
  }

  const result =
    db.prepare(`
      INSERT INTO participants (
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

      VALUES (
        ?,

        ?,
        ?,
        ?,

        ?,
        ?,
        ?,

        ?,
        ?,

        ?,
        ?,
        ?,

        ?
      )
    `).run(
      applicationId,

      data.lastName || "",
      data.firstName || "",
      data.middleName || "",

      data.birthDate || "",
      data.birthPlace || "",
      data.gender || "",

      data.passportSeries || "",
      data.passportNumber || "",

      data.issueDate || "",
      data.issuedBy || "",
      data.departmentCode || "",

      nowIso()
    );

  refreshParticipantsCount(
    applicationId
  );

  const participant =
    getParticipantById(
      Number(
        result.lastInsertRowid
      )
    );

  if (!participant) {
    throw new Error(
      "Не удалось получить участника"
    );
  }

  return participant;
}

// ---------------------------------------------------------------------
// GET PARTICIPANT
// ---------------------------------------------------------------------

export function getParticipantById(
  participantId: number
): Participant | null {
  const row =
    db.prepare(`
      SELECT
        id,
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
      FROM participants
      WHERE id = ?
      LIMIT 1
    `).get(
      participantId
    ) as
      | DbParticipantRow
      | undefined;

  if (!row) {
    return null;
  }

  return mapParticipant(
    row
  );
}

// ---------------------------------------------------------------------
// LIST PARTICIPANTS
// ---------------------------------------------------------------------

export function listApplicationParticipants(
  applicationId: number
): Participant[] {
  const rows =
    db.prepare(`
      SELECT
        id,
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
      FROM participants
      WHERE application_id = ?
      ORDER BY id ASC
    `).all(
      applicationId
    ) as DbParticipantRow[];

  return rows.map(
    mapParticipant
  );
}

// ---------------------------------------------------------------------
// REMOVE PARTICIPANT
// ---------------------------------------------------------------------

export function removeParticipant(
  participantId: number
): void {
  const participant =
    getParticipantById(
      participantId
    );

  if (!participant) {
    throw new Error(
      "Участник не найден"
    );
  }

  const application =
    getApplicationById(
      participant.applicationId
    );

  if (!application) {
    throw new Error(
      "Заявка не найдена"
    );
  }

  if (
    application.paymentStatus ===
    "paid"
  ) {
    throw new Error(
      "Нельзя удалять участников после оплаты"
    );
  }

  db.prepare(`
    DELETE FROM participants
    WHERE id = ?
  `).run(
    participantId
  );

  refreshParticipantsCount(
    participant.applicationId
  );
}

// ---------------------------------------------------------------------
// PARTICIPANTS COUNT
// ---------------------------------------------------------------------

function refreshParticipantsCount(
  applicationId: number
): number {
  const row =
    db.prepare(`
      SELECT
        COUNT(*) AS count
      FROM participants
      WHERE application_id = ?
    `).get(
      applicationId
    ) as {
      count: number;
    };

  const count =
    row.count || 0;

  db.prepare(`
    UPDATE applications
    SET participants_count = ?
    WHERE id = ?
  `).run(
    count,
    applicationId
  );

  return count;
}

// ---------------------------------------------------------------------
// SET POLICY PERIOD
// ---------------------------------------------------------------------

export function setApplicationPeriod(
  applicationId: number,
  period: PolicyPeriod
): Application {
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
    application.paymentStatus ===
    "paid"
  ) {
    throw new Error(
      "Нельзя менять период после оплаты"
    );
  }

  if (
    application.participantsCount <=
    0
  ) {
    throw new Error(
      "Сначала добавьте участников"
    );
  }

  const pricePerPerson =
    getPricePerPerson(
      period
    );

  const totalAmount =
    calculateTotalAmount(
      period,
      application.participantsCount
    );

  db.prepare(`
    UPDATE applications
    SET
      policy_period = ?,
      price_per_person = ?,
      total_amount = ?,
      insurer = ?,
      policy_type = ?
    WHERE id = ?
  `).run(
    period,
    pricePerPerson,
    totalAmount,
    application.source === "web" && period === "year" ? "reso" : "ingos",
    application.source === "web" && period === "year" ? "SYS" : application.applicationType === "group" ? "VK" : "VI",
    applicationId
  );

  const updated =
    getApplicationById(
      applicationId
    );

  if (!updated) {
    throw new Error(
      "Не удалось обновить заявку"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// LIST USER APPLICATIONS
// ---------------------------------------------------------------------

export function listUserApplications(
  telegramUserId: string,
  limit = 20
): Application[] {
  const rows =
    db.prepare(`
      SELECT
        id,
        submitted_by_user_id,
        tournament_id,
        application_type,
        policy_period,
        participants_count,
        price_per_person,
        total_amount,
        payment_status,
        paid_at,
        policy_number,
        policy_date,
        policy_start_date,
        policy_end_date,
        policy_status,
        issued_at,
        exported_to_insurer,
        export_batch_id,
        created_at

      FROM applications

      WHERE
        submitted_by_user_id = ?

      ORDER BY id DESC

      LIMIT ?
    `).all(
      telegramUserId,
      limit
    ) as DbApplicationRow[];

  return rows.map(
    mapApplication
  );
}

// ---------------------------------------------------------------------
// LIST TOURNAMENT APPLICATIONS
// ---------------------------------------------------------------------

export function listTournamentApplications(
  tournamentId: number
): Application[] {
  const rows =
    db.prepare(`
      SELECT
        id,
        submitted_by_user_id,
        tournament_id,
        application_type,
        policy_period,
        participants_count,
        price_per_person,
        total_amount,
        payment_status,
        paid_at,
        policy_number,
        policy_date,
        policy_start_date,
        policy_end_date,
        policy_status,
        issued_at,
        exported_to_insurer,
        export_batch_id,
        created_at

      FROM applications

      WHERE
        tournament_id = ?

      ORDER BY id DESC
    `).all(
      tournamentId
    ) as DbApplicationRow[];

  return rows.map(
    mapApplication
  );
}

// ---------------------------------------------------------------------
// LIST PAID APPLICATIONS
// ---------------------------------------------------------------------

export function listPaidApplications(
  tournamentId?: number
): Application[] {
  let rows: DbApplicationRow[];

  if (
    tournamentId !== undefined
  ) {
    rows =
      db.prepare(`
        SELECT
          id,
          submitted_by_user_id,
          tournament_id,
          application_type,
          policy_period,
          participants_count,
          price_per_person,
          total_amount,
          payment_status,
          paid_at,
          policy_number,
          policy_date,
          policy_start_date,
          policy_end_date,
          policy_status,
          issued_at,
          exported_to_insurer,
          export_batch_id,
          created_at

        FROM applications

        WHERE
          payment_status = 'paid'
          AND tournament_id = ?

        ORDER BY id DESC
      `).all(
        tournamentId
      ) as DbApplicationRow[];
  } else {
    rows =
      db.prepare(`
        SELECT
          id,
          submitted_by_user_id,
          tournament_id,
          application_type,
          policy_period,
          participants_count,
          price_per_person,
          total_amount,
          payment_status,
          paid_at,
          policy_number,
          policy_date,
          policy_start_date,
          policy_end_date,
          policy_status,
          issued_at,
          exported_to_insurer,
          export_batch_id,
          created_at

        FROM applications

        WHERE
          payment_status = 'paid'

        ORDER BY id DESC
      `).all() as DbApplicationRow[];
  }

  return rows.map(
    mapApplication
  );
}

// ---------------------------------------------------------------------
// LIST ISSUED APPLICATIONS
// ---------------------------------------------------------------------

export function listIssuedApplications(
  tournamentId?: number
): Application[] {
  let rows: DbApplicationRow[];

  if (
    tournamentId !== undefined
  ) {
    rows =
      db.prepare(`
        SELECT
          id,
          submitted_by_user_id,
          tournament_id,
          application_type,
          policy_period,
          participants_count,
          price_per_person,
          total_amount,
          payment_status,
          paid_at,
          policy_number,
          policy_date,
          policy_start_date,
          policy_end_date,
          policy_status,
          issued_at,
          exported_to_insurer,
          export_batch_id,
          created_at

        FROM applications

        WHERE
          policy_status = 'issued'
          AND tournament_id = ?

        ORDER BY id DESC
      `).all(
        tournamentId
      ) as DbApplicationRow[];
  } else {
    rows =
      db.prepare(`
        SELECT
          id,
          submitted_by_user_id,
          tournament_id,
          application_type,
          policy_period,
          participants_count,
          price_per_person,
          total_amount,
          payment_status,
          paid_at,
          policy_number,
          policy_date,
          policy_start_date,
          policy_end_date,
          policy_status,
          issued_at,
          exported_to_insurer,
          export_batch_id,
          created_at

        FROM applications

        WHERE
          policy_status = 'issued'

        ORDER BY id DESC
      `).all() as DbApplicationRow[];
  }

  return rows.map(
    mapApplication
  );
}
