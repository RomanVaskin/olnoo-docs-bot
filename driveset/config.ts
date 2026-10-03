import "dotenv/config";

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is missing`);
}

export type DriveSetConfig = {
  botToken: string;
  routerUrl: string;
  routerToken: string;
};

export function loadDriveSetConfig(): DriveSetConfig {
  return {
    botToken: requiredEnv("DRIVESET_DOCS_BOT_TOKEN"),
    routerUrl: requiredEnv("DRIVESET_ROUTER_URL", "AI_ROUTER_URL"),
    routerToken: requiredEnv("DRIVESET_ROUTER_TOKEN", "OLNOO_ROUTER_TOKEN", "AI_ROUTER_API_KEY"),
  };
}
