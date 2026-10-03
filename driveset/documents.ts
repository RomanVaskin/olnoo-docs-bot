import fs from "node:fs";
import path from "node:path";

import {
  calculateDriveSetOrderTotals,
  generateDriveSetOrderPdf,
  type DriveSetService,
} from "../services/driveset-order.js";
import { DriveSetCarImageService, transparentCarImage } from "./car-images.js";
import { DriveSetStorage, type DriveSetDocument } from "./storage.js";

export type DriveSetDraft = {
  makeModel: string;
  vehicleYear: number;
  mileage: string;
  services: DriveSetService[];
  discountPercent: number;
};

export type DriveSetTelegramUser = {
  id: string;
  chatId: string;
  username: string | null;
  name: string | null;
};

export class DriveSetDocumentService {
  constructor(
    readonly storage: DriveSetStorage,
    private readonly images: DriveSetCarImageService,
    private readonly exportsDir = path.join(process.cwd(), "exports", "driveset"),
  ) {
    fs.mkdirSync(this.exportsDir, { recursive: true });
  }

  reserve(draft: DriveSetDraft, user: DriveSetTelegramUser, now = new Date()): DriveSetDocument {
    return this.storage.reserveDocument({
      telegramUserId: user.id,
      telegramChatId: user.chatId,
      telegramUsername: user.username,
      telegramName: user.name,
      makeModel: draft.makeModel,
      vehicleYear: draft.vehicleYear,
      mileage: draft.mileage,
      services: draft.services,
      discountPercent: draft.discountPercent,
      totals: calculateDriveSetOrderTotals(draft.services, draft.discountPercent),
      now,
    });
  }

  async generate(documentId: number, withImage = true): Promise<DriveSetDocument> {
    const document = this.storage.getDocument(documentId);
    let image: Awaited<ReturnType<DriveSetCarImageService["getOrGenerate"]>> | null = null;
    try {
      const imageBytes = withImage
        ? (image = await this.images.getOrGenerate(document.makeModel, document.vehicleYear)).bytes
        : await transparentCarImage();
      const pdfBytes = await generateDriveSetOrderPdf({
        orderNumber: document.orderNumber,
        date: new Date(document.createdAt),
        makeModel: document.makeModel,
        year: document.vehicleYear,
        mileage: document.mileage,
        carImage: imageBytes,
        services: document.services,
        discountPercent: document.discountPercent,
      });
      const pdfPath = path.join(this.exportsDir, `${document.orderNumber}.pdf`);
      const temporaryPath = `${pdfPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporaryPath, pdfBytes);
      fs.renameSync(temporaryPath, pdfPath);
      return this.storage.markGenerated(document.id, {
        pdfPath,
        imageCacheKey: image?.cacheKey,
        imagePath: image?.filePath,
      });
    } catch (error) {
      this.storage.markFailed(document.id, error);
      throw error;
    }
  }
}
