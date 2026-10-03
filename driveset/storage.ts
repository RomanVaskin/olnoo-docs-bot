import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { DriveSetOrderTotals, DriveSetService } from "../services/driveset-order.js";

export type DriveSetDocumentStatus = "pending" | "generated" | "failed";

export type DriveSetDocument = {
  id: number;
  orderNumber: string;
  sequenceYear: number;
  sequence: number;
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername: string | null;
  telegramName: string | null;
  makeModel: string;
  vehicleYear: number;
  mileage: string;
  services: DriveSetService[];
  discountPercent: number;
  totals: DriveSetOrderTotals;
  imageCacheKey: string | null;
  imagePath: string | null;
  pdfPath: string | null;
  status: DriveSetDocumentStatus;
  errorMessage: string | null;
  createdAt: string;
  generatedAt: string | null;
};

type DocumentRow = {
  id: number;
  order_number: string;
  sequence_year: number;
  sequence: number;
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  telegram_name: string | null;
  make_model: string;
  vehicle_year: number;
  mileage: string;
  services_json: string;
  discount_percent: number;
  paid_works_cost: number;
  discount_amount: number;
  total: number;
  image_cache_key: string | null;
  image_path: string | null;
  pdf_path: string | null;
  status: DriveSetDocumentStatus;
  error_message: string | null;
  created_at: string;
  generated_at: string | null;
};

export type ReserveDocumentInput = {
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername: string | null;
  telegramName: string | null;
  makeModel: string;
  vehicleYear: number;
  mileage: string;
  services: DriveSetService[];
  discountPercent: number;
  totals: DriveSetOrderTotals;
  now?: Date;
};

function mapRow(row: DocumentRow): DriveSetDocument {
  return {
    id: row.id,
    orderNumber: row.order_number,
    sequenceYear: row.sequence_year,
    sequence: row.sequence,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    telegramUsername: row.telegram_username,
    telegramName: row.telegram_name,
    makeModel: row.make_model,
    vehicleYear: row.vehicle_year,
    mileage: row.mileage,
    services: JSON.parse(row.services_json) as DriveSetService[],
    discountPercent: row.discount_percent,
    totals: {
      paidWorksCost: row.paid_works_cost,
      discountPercent: row.discount_percent,
      discountAmount: row.discount_amount,
      total: row.total,
    },
    imageCacheKey: row.image_cache_key,
    imagePath: row.image_path,
    pdfPath: row.pdf_path,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    generatedAt: row.generated_at,
  };
}

export class DriveSetStorage {
  private readonly database: Database.Database;

  constructor(databasePath = path.join(process.cwd(), "data", "driveset", "driveset.db")) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS driveset_sequences (
        sequence_year INTEGER PRIMARY KEY,
        last_sequence INTEGER NOT NULL CHECK (last_sequence > 0)
      );

      CREATE TABLE IF NOT EXISTS driveset_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT NOT NULL UNIQUE,
        sequence_year INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        telegram_username TEXT,
        telegram_name TEXT,
        make_model TEXT NOT NULL,
        vehicle_year INTEGER NOT NULL,
        mileage TEXT NOT NULL,
        services_json TEXT NOT NULL,
        discount_percent REAL NOT NULL,
        paid_works_cost REAL NOT NULL,
        discount_amount REAL NOT NULL,
        total REAL NOT NULL,
        image_cache_key TEXT,
        image_path TEXT,
        pdf_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'generated', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        generated_at TEXT,
        UNIQUE (sequence_year, sequence)
      );

      CREATE INDEX IF NOT EXISTS driveset_documents_user_history
      ON driveset_documents (telegram_user_id, created_at DESC);
    `);
  }

  reserveDocument(input: ReserveDocumentInput): DriveSetDocument {
    const transaction = this.database.transaction(() => {
      const sequenceYear = (input.now ?? new Date()).getUTCFullYear();
      const current = this.database.prepare(
        "SELECT last_sequence FROM driveset_sequences WHERE sequence_year = ?",
      ).get(sequenceYear) as { last_sequence: number } | undefined;
      const sequence = (current?.last_sequence ?? 0) + 1;

      this.database.prepare(`
        INSERT INTO driveset_sequences (sequence_year, last_sequence)
        VALUES (?, ?)
        ON CONFLICT(sequence_year) DO UPDATE SET last_sequence = excluded.last_sequence
      `).run(sequenceYear, sequence);

      const orderNumber = `DS-${sequenceYear}-${String(sequence).padStart(4, "0")}`;
      const createdAt = (input.now ?? new Date()).toISOString();
      const result = this.database.prepare(`
        INSERT INTO driveset_documents (
          order_number, sequence_year, sequence,
          telegram_user_id, telegram_chat_id, telegram_username, telegram_name,
          make_model, vehicle_year, mileage, services_json, discount_percent,
          paid_works_cost, discount_amount, total, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        orderNumber,
        sequenceYear,
        sequence,
        input.telegramUserId,
        input.telegramChatId,
        input.telegramUsername,
        input.telegramName,
        input.makeModel,
        input.vehicleYear,
        input.mileage,
        JSON.stringify(input.services),
        input.discountPercent,
        input.totals.paidWorksCost,
        input.totals.discountAmount,
        input.totals.total,
        createdAt,
      );
      return this.getDocument(Number(result.lastInsertRowid));
    });

    return transaction();
  }

  getDocument(id: number): DriveSetDocument {
    const row = this.database.prepare(
      "SELECT * FROM driveset_documents WHERE id = ?",
    ).get(id) as DocumentRow | undefined;
    if (!row) throw new Error(`Заказ-наряд с id=${id} не найден`);
    return mapRow(row);
  }

  markGenerated(
    id: number,
    data: { pdfPath: string; imageCacheKey?: string; imagePath?: string; generatedAt?: Date },
  ): DriveSetDocument {
    this.database.prepare(`
      UPDATE driveset_documents
      SET status = 'generated', pdf_path = ?, image_cache_key = ?, image_path = ?,
          error_message = NULL, generated_at = ?
      WHERE id = ?
    `).run(
      data.pdfPath,
      data.imageCacheKey ?? null,
      data.imagePath ?? null,
      (data.generatedAt ?? new Date()).toISOString(),
      id,
    );
    return this.getDocument(id);
  }

  markFailed(id: number, error: unknown): DriveSetDocument {
    const message = error instanceof Error ? error.message : String(error);
    this.database.prepare(`
      UPDATE driveset_documents SET status = 'failed', error_message = ? WHERE id = ?
    `).run(message.slice(0, 1000), id);
    return this.getDocument(id);
  }

  listUserDocuments(telegramUserId: string, limit = 10): DriveSetDocument[] {
    const rows = this.database.prepare(`
      SELECT * FROM driveset_documents
      WHERE telegram_user_id = ? AND status = 'generated'
      ORDER BY created_at DESC LIMIT ?
    `).all(telegramUserId, limit) as DocumentRow[];
    return rows.map(mapRow);
  }

  close(): void {
    this.database.close();
  }
}
