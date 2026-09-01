import type { ProjectContext } from "./schema";

export function defaultProjectContext(fullName: string, repositoryId: string): ProjectContext | undefined {
  if (fullName !== "3252a8/remnawave-minishop" && repositoryId !== "3252a8/remnawave-minishop") return undefined;
  return {
    productSummary: "Remnawave MiniShop is a Telegram Mini App for managing a Remnawave shop.",
    communityAssumption: "Reports may describe Telegram Desktop, mobile clients, or the Mini App; client availability is not an external-platform failure by default.",
    components: [
      { id: "miniapp/status", description: "Mini App status and Telegram client capability flags.", aliases: ["Telegram Desktop", "PC", "status flags"], indicators: ["desktop status", "PC status", "flags"], likelyLabels: ["bug", "miniapp"] },
    ],
    externalPlatforms: [{ name: "Telegram", role: "host client for the Mini App" }],
    terminology: { miniapp: "Telegram Mini App", status: "application status flags" },
    disambiguationRules: ["Telegram Desktop PC status flags belong to miniapp/status; Telegram is not an external failing platform unless the report explicitly says so.", "Context is advisory: do not invent files, causes, or integrations."],
  };
}
