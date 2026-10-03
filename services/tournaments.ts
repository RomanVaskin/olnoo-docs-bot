import { db, nowIso } from "../db.js";
import type { Tournament } from "../types.js";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

type DbTournamentRow = {
  id: number;
  name: string;
  event_date: string | null;
  is_active: number;
  created_at: string;
};

// ---------------------------------------------------------------------
// MAPPER
// ---------------------------------------------------------------------

function mapTournament(
  row: DbTournamentRow
): Tournament {
  return {
    id: row.id,
    name: row.name,
    eventDate: row.event_date,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------
// CREATE TOURNAMENT
// ---------------------------------------------------------------------

export function createTournament(
  name: string,
  eventDate?: string | null
): Tournament {
  const normalizedName =
    name.trim();

  if (!normalizedName) {
    throw new Error(
      "Название турнира не может быть пустым"
    );
  }

  const result =
    db.prepare(`
      INSERT INTO tournaments (
        name,
        event_date,
        is_active,
        created_at
      )

      VALUES (
        ?,
        ?,
        1,
        ?
      )
    `).run(
      normalizedName,
      eventDate || null,
      nowIso()
    );

  const tournament =
    getTournamentById(
      Number(
        result.lastInsertRowid
      )
    );

  if (!tournament) {
    throw new Error(
      "Не удалось получить созданный турнир"
    );
  }

  return tournament;
}

// ---------------------------------------------------------------------
// GET BY ID
// ---------------------------------------------------------------------

export function getTournamentById(
  tournamentId: number
): Tournament | null {
  const row =
    db.prepare(`
      SELECT
        id,
        name,
        event_date,
        is_active,
        created_at
      FROM tournaments
      WHERE id = ?
      LIMIT 1
    `).get(
      tournamentId
    ) as
      | DbTournamentRow
      | undefined;

  if (!row) {
    return null;
  }

  return mapTournament(
    row
  );
}

// ---------------------------------------------------------------------
// ACTIVE TOURNAMENTS
// ---------------------------------------------------------------------

export function listActiveTournaments(): Tournament[] {
  const rows =
    db.prepare(`
      SELECT
        id,
        name,
        event_date,
        is_active,
        created_at
      FROM tournaments
      WHERE is_active = 1
      ORDER BY
        CASE
          WHEN event_date IS NULL
          THEN 1
          ELSE 0
        END ASC,
        event_date ASC,
        id DESC
    `).all() as DbTournamentRow[];

  return rows.map(
    mapTournament
  );
}

// ---------------------------------------------------------------------
// CLOSED TOURNAMENTS
// ---------------------------------------------------------------------

export function listClosedTournaments(): Tournament[] {
  const rows =
    db.prepare(`
      SELECT
        id,
        name,
        event_date,
        is_active,
        created_at
      FROM tournaments
      WHERE is_active = 0
      ORDER BY id DESC
    `).all() as DbTournamentRow[];

  return rows.map(
    mapTournament
  );
}

// ---------------------------------------------------------------------
// ALL TOURNAMENTS
// ---------------------------------------------------------------------

export function listAllTournaments(): Tournament[] {
  const rows =
    db.prepare(`
      SELECT
        id,
        name,
        event_date,
        is_active,
        created_at
      FROM tournaments
      ORDER BY
        is_active DESC,
        id DESC
    `).all() as DbTournamentRow[];

  return rows.map(
    mapTournament
  );
}

// ---------------------------------------------------------------------
// CLOSE TOURNAMENT
// ---------------------------------------------------------------------

export function closeTournament(
  tournamentId: number
): Tournament {
  const tournament =
    getTournamentById(
      tournamentId
    );

  if (!tournament) {
    throw new Error(
      "Турнир не найден"
    );
  }

  db.prepare(`
    UPDATE tournaments
    SET is_active = 0
    WHERE id = ?
  `).run(
    tournamentId
  );

  const updated =
    getTournamentById(
      tournamentId
    );

  if (!updated) {
    throw new Error(
      "Не удалось обновить турнир"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// REOPEN TOURNAMENT
// ---------------------------------------------------------------------

export function reopenTournament(
  tournamentId: number
): Tournament {
  const tournament =
    getTournamentById(
      tournamentId
    );

  if (!tournament) {
    throw new Error(
      "Турнир не найден"
    );
  }

  db.prepare(`
    UPDATE tournaments
    SET is_active = 1
    WHERE id = ?
  `).run(
    tournamentId
  );

  const updated =
    getTournamentById(
      tournamentId
    );

  if (!updated) {
    throw new Error(
      "Не удалось обновить турнир"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// RENAME TOURNAMENT
// ---------------------------------------------------------------------

export function renameTournament(
  tournamentId: number,
  newName: string
): Tournament {
  const normalizedName =
    newName.trim();

  if (!normalizedName) {
    throw new Error(
      "Название турнира не может быть пустым"
    );
  }

  const tournament =
    getTournamentById(
      tournamentId
    );

  if (!tournament) {
    throw new Error(
      "Турнир не найден"
    );
  }

  db.prepare(`
    UPDATE tournaments
    SET name = ?
    WHERE id = ?
  `).run(
    normalizedName,
    tournamentId
  );

  const updated =
    getTournamentById(
      tournamentId
    );

  if (!updated) {
    throw new Error(
      "Не удалось обновить турнир"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// UPDATE EVENT DATE
// ---------------------------------------------------------------------

export function updateTournamentDate(
  tournamentId: number,
  eventDate: string | null
): Tournament {
  const tournament =
    getTournamentById(
      tournamentId
    );

  if (!tournament) {
    throw new Error(
      "Турнир не найден"
    );
  }

  db.prepare(`
    UPDATE tournaments
    SET event_date = ?
    WHERE id = ?
  `).run(
    eventDate,
    tournamentId
  );

  const updated =
    getTournamentById(
      tournamentId
    );

  if (!updated) {
    throw new Error(
      "Не удалось обновить дату турнира"
    );
  }

  return updated;
}

// ---------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------

export type TournamentStats = {
  tournamentId: number;

  applications: number;

  participants: number;

  paidApplications: number;

  paidParticipants: number;

  issuedApplications: number;

  issuedParticipants: number;

  revenue: number;
};

export function getTournamentStats(
  tournamentId: number
): TournamentStats {
  const tournament =
    getTournamentById(
      tournamentId
    );

  if (!tournament) {
    throw new Error(
      "Турнир не найден"
    );
  }

  const row =
    db.prepare(`
      SELECT
        COUNT(*) AS applications,

        COALESCE(
          SUM(
            participants_count
          ),
          0
        ) AS participants,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS paid_applications,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN participants_count
              ELSE 0
            END
          ),
          0
        ) AS paid_participants,

        COALESCE(
          SUM(
            CASE
              WHEN policy_status = 'issued'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS issued_applications,

        COALESCE(
          SUM(
            CASE
              WHEN policy_status = 'issued'
              THEN participants_count
              ELSE 0
            END
          ),
          0
        ) AS issued_participants,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS revenue

      FROM applications
      WHERE tournament_id = ?
    `).get(
      tournamentId
    ) as {
      applications: number;

      participants: number;

      paid_applications: number;

      paid_participants: number;

      issued_applications: number;

      issued_participants: number;

      revenue: number;
    };

  return {
    tournamentId,

    applications:
      row.applications || 0,

    participants:
      row.participants || 0,

    paidApplications:
      row.paid_applications || 0,

    paidParticipants:
      row.paid_participants || 0,

    issuedApplications:
      row.issued_applications || 0,

    issuedParticipants:
      row.issued_participants || 0,

    revenue:
      row.revenue || 0,
  };
}
