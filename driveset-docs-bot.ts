import { createDriveSetBot } from "./driveset/bot.js";
import { DriveSetCarImageService } from "./driveset/car-images.js";
import { loadDriveSetConfig } from "./driveset/config.js";
import { DriveSetDocumentService } from "./driveset/documents.js";
import { DriveSetStorage } from "./driveset/storage.js";

async function start(): Promise<void> {
  const config = loadDriveSetConfig();
  const storage = new DriveSetStorage();
  const images = new DriveSetCarImageService({
    routerUrl: config.routerUrl,
    routerToken: config.routerToken,
  });
  const documents = new DriveSetDocumentService(storage, images);
  const bot = createDriveSetBot(config.botToken, documents);

  const stop = (signal: string): void => {
    console.log(`DriveSet Docs bot received ${signal}`);
    bot.stop();
    storage.close();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  await bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "menu", description: "Открыть меню" },
  ]);
  await bot.start({ onStart: info => console.log(`DriveSet Docs bot @${info.username} started`) });
}

start().catch(error => {
  console.error("DriveSet Docs bot failed to start", error);
  process.exit(1);
});
