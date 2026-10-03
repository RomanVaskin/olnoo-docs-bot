import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(
  process.cwd(),
  "data"
);

fs.mkdirSync(
  dataDir,
  {
    recursive: true,
  }
);

export const db = new Database(
  path.join(
    dataDir,
    "docs.db"
  )
);

db.pragma("journal_mode = WAL");

db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_user_id TEXT PRIMARY KEY,

  telegram_username TEXT,

  telegram_name TEXT,

  email TEXT,

  created_at TEXT NOT NULL,

  updated_at TEXT NOT NULL
);
`);

// ---------------------------------------------------------------------
// MANAGER SETTINGS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS manager_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  email TEXT,

  created_at TEXT NOT NULL,

  updated_at TEXT NOT NULL
);
`);

db.prepare(`
  INSERT OR IGNORE INTO manager_settings (
    id,
    email,
    created_at,
    updated_at
  )

  VALUES (
    1,
    NULL,
    ?,
    ?
  )
`).run(
  new Date().toISOString(),
  new Date().toISOString()
);

// ---------------------------------------------------------------------
// TOURNAMENTS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  name TEXT NOT NULL,

  event_date TEXT,

  is_active INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL
);
`);

// ---------------------------------------------------------------------
// APPLICATIONS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  submitted_by_user_id TEXT NOT NULL,

  tournament_id INTEGER NOT NULL,

  application_type TEXT NOT NULL
    CHECK (
      application_type IN (
        'individual',
        'group'
      )
    ),

  policy_period TEXT
    CHECK (
      policy_period IS NULL
      OR policy_period IN (
        'day',
        'month',
        'year'
      )
    ),

  participants_count INTEGER NOT NULL DEFAULT 0,

  price_per_person INTEGER NOT NULL DEFAULT 0,

  total_amount INTEGER NOT NULL DEFAULT 0,

  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      payment_status IN (
        'pending',
        'paid',
        'cancelled',
        'refunded'
      )
    ),

  paid_at TEXT,

  policy_number TEXT,

  policy_date TEXT,

  policy_start_date TEXT,

  policy_end_date TEXT,

  policy_status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (
      policy_status IN (
        'waiting',
        'generating',
        'issued',
        'error'
      )
    ),

  issued_at TEXT,

  exported_to_insurer INTEGER NOT NULL DEFAULT 0,

  export_batch_id TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (
    submitted_by_user_id
  )
  REFERENCES users (
    telegram_user_id
  ),

  FOREIGN KEY (
    tournament_id
  )
  REFERENCES tournaments (
    id
  )
);
`);

// Additive migration for web/Telegram insurance convergence. Existing rows
// keep the Telegram default and no legacy application is rewritten.
const applicationColumns = db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
const hasApplicationColumn = (name: string) => applicationColumns.some(column => column.name === name);
if (!hasApplicationColumn("source")) db.exec("ALTER TABLE applications ADD COLUMN source TEXT NOT NULL DEFAULT 'telegram'");
if (!hasApplicationColumn("insurer")) db.exec("ALTER TABLE applications ADD COLUMN insurer TEXT");
if (!hasApplicationColumn("policy_type")) db.exec("ALTER TABLE applications ADD COLUMN policy_type TEXT");
if (!hasApplicationColumn("sport")) db.exec("ALTER TABLE applications ADD COLUMN sport TEXT");
if (!hasApplicationColumn("insurance_amount")) db.exec("ALTER TABLE applications ADD COLUMN insurance_amount INTEGER");

// ---------------------------------------------------------------------
// PARTICIPANTS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  application_id INTEGER NOT NULL,

  last_name TEXT,

  first_name TEXT,

  middle_name TEXT,

  birth_date TEXT,

  birth_place TEXT,

  gender TEXT,

  passport_series TEXT,

  passport_number TEXT,

  issue_date TEXT,

  issued_by TEXT,

  department_code TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (
    application_id
  )
  REFERENCES applications (
    id
  )
  ON DELETE CASCADE
);
`);

// ---------------------------------------------------------------------
// POLICY NUMBERS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS policy_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  policy_number TEXT NOT NULL UNIQUE,

  policy_type TEXT NOT NULL
    CHECK (
      policy_type IN (
        'VI',
        'VK',
        'SYS'
      )
    ),

  status TEXT NOT NULL DEFAULT 'available'
    CHECK (
      status IN (
        'available',
        'reserved',
        'issued'
      )
    ),

  sequence INTEGER NOT NULL,

  application_id INTEGER,

  reserved_at TEXT,

  issued_at TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (
    application_id
  )
  REFERENCES applications (
    id
  )
);
`);

// Lossless migration from the legacy individual/group pools. IDs,
// application bindings, reservations and issued markers are preserved.
const policyNumbersSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='policy_numbers'").get() as { sql: string }).sql;
if (!policyNumbersSql.includes("'SYS'") || policyNumbersSql.includes("'individual'")) {
  db.transaction(() => db.exec(`
    ALTER TABLE policy_numbers RENAME TO policy_numbers_legacy;
    CREATE TABLE policy_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_number TEXT NOT NULL UNIQUE,
      policy_type TEXT NOT NULL CHECK (policy_type IN ('VI','VK','SYS')),
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','issued')),
      sequence INTEGER NOT NULL,
      application_id INTEGER,
      reserved_at TEXT,
      issued_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications (id)
    );
    INSERT INTO policy_numbers (id,policy_number,policy_type,status,sequence,application_id,reserved_at,issued_at,created_at)
    SELECT id,policy_number,
      CASE policy_type WHEN 'individual' THEN 'VI' WHEN 'group' THEN 'VK' ELSE policy_type END,
      CASE status WHEN 'free' THEN 'available' ELSE status END,
      sequence,application_id,reserved_at,issued_at,created_at
    FROM policy_numbers_legacy;
    DROP TABLE policy_numbers_legacy;
  `))();
}

// Correct pre-SYS web reservations made by the short-lived VK=RESO mapping.
// Issued contracts are never silently revoked; in normal deployment none can
// exist because RESO generation was blocked without the official template.
db.transaction(() => {
  db.prepare(`
    UPDATE policy_numbers
    SET status='available', application_id=NULL, reserved_at=NULL
    WHERE status='reserved' AND application_id IN (
      SELECT id FROM applications WHERE source='web' AND insurer='reso' AND policy_type='VK'
    )
  `).run();
  db.prepare(`
    UPDATE applications
    SET policy_type='SYS', policy_number=NULL, policy_status='waiting'
    WHERE source='web' AND insurer='reso' AND policy_type='VK' AND policy_status!='issued'
  `).run();
})();

// ---------------------------------------------------------------------
// PAYMENTS
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  application_id INTEGER NOT NULL,

  provider TEXT NOT NULL DEFAULT 'simulator',

  external_payment_id TEXT,

  amount INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'paid',
        'cancelled',
        'refunded'
      )
    ),

  receipt_id TEXT,

  receipt_status TEXT,

  receipt_email TEXT,

  paid_at TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (
    application_id
  )
  REFERENCES applications (
    id
  )
);
`);

// ---------------------------------------------------------------------
// EXPORT BATCHES
// ---------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS export_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  batch_id TEXT NOT NULL UNIQUE,

  tournament_id INTEGER,

  rows_count INTEGER NOT NULL DEFAULT 0,

  file_path TEXT,

  insurer_paid INTEGER NOT NULL DEFAULT 0,

  insurer_paid_at TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY (
    tournament_id
  )
  REFERENCES tournaments (
    id
  )
);
`);

// ---------------------------------------------------------------------
// INDEXES
// ---------------------------------------------------------------------

db.exec(`
CREATE INDEX IF NOT EXISTS
idx_applications_tournament
ON applications (
  tournament_id
);
`);

db.exec(`
CREATE INDEX IF NOT EXISTS
idx_applications_payment_status
ON applications (
  payment_status
);
`);

db.exec(`
CREATE INDEX IF NOT EXISTS
idx_applications_policy_status
ON applications (
  policy_status
);
`);

db.exec(`
CREATE INDEX IF NOT EXISTS
idx_policy_numbers_type_status
ON policy_numbers (
  policy_type,
  status,
  sequence
);
`);

db.exec(`
CREATE INDEX IF NOT EXISTS
idx_participants_application
ON participants (
  application_id
);
`);

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}
