import "dotenv/config";

function requiredEnv(
  name: string
): string {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `${name} is missing`
    );
  }

  return value;
}

export const config = {
  botToken:
    requiredEnv(
      "BOT_TOKEN"
    ),

  managerChatId:
    requiredEnv(
      "MANAGER_CHAT_ID"
    ),

  aiRouterUrl:
    requiredEnv(
      "AI_ROUTER_URL"
    ),

  aiRouterApiKey:
    requiredEnv(
      "AI_ROUTER_API_KEY"
    ),

  yookassa: {
    shopId:
      requiredEnv(
        "YOOKASSA_SHOP_ID"
      ),

    secretKey:
      requiredEnv(
        "YOOKASSA_SECRET_KEY"
      ),
  },

  prices: {
    day: 100,
    month: 200,
    year: 500,
  },

  policyPrefixes: {
    individual: "VI",
    group: "VK",
    resoYear: "SYS",
  },

  lowPolicyNumbersWarning:
    20,
};
