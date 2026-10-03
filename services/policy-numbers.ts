import { db, nowIso } from "../db.js";

import type {
  ApplicationType,
  InsurancePolicyType,
  PolicyNumberStatus,
} from "../types.js";

type PolicyPoolInput = ApplicationType | InsurancePolicyType;

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

export type PolicyNumberRow = {
  id: number;
  policyNumber: string;
  policyType: InsurancePolicyType;
  status: PolicyNumberStatus;
  sequence: number;
  applicationId: number | null;
  reservedAt: string | null;
  issuedAt: string | null;
  createdAt: string;
};

export type PolicyNumberStats = {
  total: number;
  free: number;
  reserved: number;
  issued: number;
};

type DbPolicyNumberRow = {
  id: number;
  policy_number: string;
  policy_type: InsurancePolicyType;
  status: PolicyNumberStatus;
  sequence: number;
  application_id: number | null;
  reserved_at: string | null;
  issued_at: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------
// MAPPER
// ---------------------------------------------------------------------

function mapRow(
  row: DbPolicyNumberRow
): PolicyNumberRow {
  return {
    id: row.id,
    policyNumber: row.policy_number,
    policyType: row.policy_type,
    status: row.status,
    sequence: row.sequence,
    applicationId: row.application_id,
    reservedAt: row.reserved_at,
    issuedAt: row.issued_at,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------
// NORMALIZATION
// ---------------------------------------------------------------------

function normalizePolicyNumber(
  value: string
): string {
  return value
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizePoolType(policyType: PolicyPoolInput): InsurancePolicyType {
  if (policyType === "individual") return "VI";
  if (policyType === "group") return "VK";
  return policyType;
}

function validatePolicyNumber(
  policyNumber: string,
  policyType: PolicyPoolInput
): void {
  const poolType = normalizePoolType(policyType);
  if (!policyNumber) {
    throw new Error(
      "Номер полиса не может быть пустым"
    );
  }

  if (
    poolType === "VI" &&
    !policyNumber.startsWith("VI")
  ) {
    throw new Error(
      `Индивидуальный номер должен начинаться с VI: ${policyNumber}`
    );
  }

  if (
    poolType === "VK" &&
    !policyNumber.startsWith("VK")
  ) {
    throw new Error(
      `Групповой номер должен начинаться с VK: ${policyNumber}`
    );
  }

  if (poolType === "SYS" && !policyNumber.startsWith("SYS")) {
    throw new Error(`Номер РЕСО должен начинаться с SYS: ${policyNumber}`);
  }
}

// ---------------------------------------------------------------------
// SEQUENCE
// ---------------------------------------------------------------------

function getNextSequence(
  policyType: PolicyPoolInput
): number {
  const poolType = normalizePoolType(policyType);
  const row =
    db.prepare(`
      SELECT
        MAX(sequence) AS max_sequence
      FROM policy_numbers
      WHERE policy_type = ?
    `).get(
      poolType
    ) as {
      max_sequence: number | null;
    };

  return (
    (row.max_sequence || 0) + 1
  );
}

// ---------------------------------------------------------------------
// IMPORT
// ---------------------------------------------------------------------

export function importPolicyNumbers(
  policyType: PolicyPoolInput,
  rawNumbers: string[]
): {
  imported: number;
  skipped: number;
  duplicates: string[];
} {
  let sequence =
    getNextSequence(
      policyType
    );

  let imported = 0;
  let skipped = 0;

  const duplicates: string[] = [];

  const exists =
    db.prepare(`
      SELECT id
      FROM policy_numbers
      WHERE policy_number = ?
      LIMIT 1
    `);

  const insert =
    db.prepare(`
      INSERT INTO policy_numbers (
        policy_number,
        policy_type,
        status,
        sequence,
        application_id,
        reserved_at,
        issued_at,
        created_at
      )
      VALUES (
        ?,
        ?,
        'available',
        ?,
        NULL,
        NULL,
        NULL,
        ?
      )
    `);

  const transaction =
    db.transaction(() => {
      for (
        const rawNumber
        of rawNumbers
      ) {
        const policyNumber =
          normalizePolicyNumber(
            rawNumber
          );

        if (!policyNumber) {
          skipped++;
          continue;
        }

        validatePolicyNumber(
          policyNumber,
          policyType
        );

        if (
          exists.get(
            policyNumber
          )
        ) {
          duplicates.push(
            policyNumber
          );

          skipped++;
          continue;
        }

        insert.run(
          policyNumber,
          normalizePoolType(policyType),
          sequence,
          nowIso()
        );

        sequence++;
        imported++;
      }
    });

  transaction();

  return {
    imported,
    skipped,
    duplicates,
  };
}

// ---------------------------------------------------------------------
// RESERVE NEXT
// ---------------------------------------------------------------------

export function reserveNextPolicyNumber(
  policyType: PolicyPoolInput,
  applicationId: number
): PolicyNumberRow {
  const transaction =
    db.transaction(
      (): PolicyNumberRow => {
        const existing =
          db.prepare(`
            SELECT
              id,
              policy_number,
              policy_type,
              status,
              sequence,
              application_id,
              reserved_at,
              issued_at,
              created_at
            FROM policy_numbers
            WHERE
              application_id = ?
              AND status IN (
                'reserved',
                'issued'
              )
            LIMIT 1
          `).get(
            applicationId
          ) as
            | DbPolicyNumberRow
            | undefined;

        if (existing) {
          return mapRow(
            existing
          );
        }

        const next =
          db.prepare(`
            SELECT
              id,
              policy_number,
              policy_type,
              status,
              sequence,
              application_id,
              reserved_at,
              issued_at,
              created_at
            FROM policy_numbers
            WHERE
              policy_type = ?
              AND status = 'available'
            ORDER BY sequence ASC
            LIMIT 1
          `).get(
            normalizePoolType(policyType)
          ) as
            | DbPolicyNumberRow
            | undefined;

        if (!next) {
          throw new Error(
            `Закончились номера ${normalizePoolType(policyType)}`
          );
        }

        const reservedAt =
          nowIso();

        const result =
          db.prepare(`
            UPDATE policy_numbers
            SET
              status = 'reserved',
              application_id = ?,
              reserved_at = ?
            WHERE
              id = ?
              AND status = 'available'
          `).run(
            applicationId,
            reservedAt,
            next.id
          );

        if (
          result.changes !== 1
        ) {
          throw new Error(
            "Не удалось зарезервировать номер полиса"
          );
        }

        db.prepare(`
          UPDATE applications
          SET policy_number = ?
          WHERE id = ?
        `).run(
          next.policy_number,
          applicationId
        );

        return {
          ...mapRow(next),
          status: "reserved",
          applicationId,
          reservedAt,
        };
      }
    );

  return transaction();
}

// ---------------------------------------------------------------------
// MARK ISSUED
// ---------------------------------------------------------------------

export function markPolicyNumberIssued(
  applicationId: number
): PolicyNumberRow {
  const transaction =
    db.transaction(
      (): PolicyNumberRow => {
        const row =
          db.prepare(`
            SELECT
              id,
              policy_number,
              policy_type,
              status,
              sequence,
              application_id,
              reserved_at,
              issued_at,
              created_at
            FROM policy_numbers
            WHERE application_id = ?
            LIMIT 1
          `).get(
            applicationId
          ) as
            | DbPolicyNumberRow
            | undefined;

        if (!row) {
          throw new Error(
            "Номер полиса не зарезервирован"
          );
        }

        if (
          row.status === "issued"
        ) {
          return mapRow(row);
        }

        if (
          row.status !== "reserved"
        ) {
          throw new Error(
            "Некорректный статус номера полиса"
          );
        }

        const issuedAt =
          nowIso();

        db.prepare(`
          UPDATE policy_numbers
          SET
            status = 'issued',
            issued_at = ?
          WHERE id = ?
        `).run(
          issuedAt,
          row.id
        );

        db.prepare(`
          UPDATE applications
          SET
            policy_status = 'issued',
            issued_at = ?
          WHERE id = ?
        `).run(
          issuedAt,
          applicationId
        );

        return {
          ...mapRow(row),
          status: "issued",
          issuedAt,
        };
      }
    );

  return transaction();
}

// ---------------------------------------------------------------------
// RELEASE RESERVED
// ---------------------------------------------------------------------

export function releaseReservedPolicyNumber(
  applicationId: number
): void {
  const transaction =
    db.transaction(() => {
      const row =
        db.prepare(`
          SELECT
            id,
            status
          FROM policy_numbers
          WHERE application_id = ?
          LIMIT 1
        `).get(
          applicationId
        ) as
          | {
              id: number;
              status: PolicyNumberStatus;
            }
          | undefined;

      if (
        !row ||
        row.status !== "reserved"
      ) {
        return;
      }

      db.prepare(`
        UPDATE policy_numbers
        SET
          status = 'available',
          application_id = NULL,
          reserved_at = NULL
        WHERE id = ?
      `).run(
        row.id
      );

      db.prepare(`
        UPDATE applications
        SET policy_number = NULL
        WHERE id = ?
      `).run(
        applicationId
      );
    });

  transaction();
}

// ---------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------

export function getPolicyNumberStats(
  policyType: PolicyPoolInput
): PolicyNumberStats {
  const row =
    db.prepare(`
      SELECT
        COUNT(*) AS total,

        COALESCE(
          SUM(
            CASE
              WHEN status = 'available'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS free,

        COALESCE(
          SUM(
            CASE
              WHEN status = 'reserved'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS reserved,

        COALESCE(
          SUM(
            CASE
              WHEN status = 'issued'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS issued

      FROM policy_numbers
      WHERE policy_type = ?
    `).get(
      normalizePoolType(policyType)
    ) as {
      total: number;
      free: number;
      reserved: number;
      issued: number;
    };

  return {
    total: row.total || 0,
    free: row.free || 0,
    reserved: row.reserved || 0,
    issued: row.issued || 0,
  };
}

// ---------------------------------------------------------------------
// LIST FREE
// ---------------------------------------------------------------------

export function listFreePolicyNumbers(
  policyType: PolicyPoolInput,
  limit = 20
): PolicyNumberRow[] {
  const rows =
    db.prepare(`
      SELECT
        id,
        policy_number,
        policy_type,
        status,
        sequence,
        application_id,
        reserved_at,
        issued_at,
        created_at
      FROM policy_numbers
      WHERE
        policy_type = ?
        AND status = 'available'
      ORDER BY sequence ASC
      LIMIT ?
    `).all(
      normalizePoolType(policyType),
      limit
    ) as DbPolicyNumberRow[];

  return rows.map(
    mapRow
  );
}
