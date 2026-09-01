import { z } from "zod";

const shortText = z.string().trim().min(1).max(500);
export const ProjectContextSchema = z.object({
  productSummary: shortText,
  communityAssumption: shortText,
  components: z.array(z.object({
    id: z.string().trim().min(1).max(80), description: shortText,
    aliases: z.array(z.string().trim().min(1).max(80)).max(20),
    indicators: z.array(z.string().trim().min(1).max(160)).max(20),
    likelyLabels: z.array(z.string().trim().min(1).max(80)).max(20),
  })).max(30),
  externalPlatforms: z.array(z.object({ name: shortText, role: shortText })).max(20),
  terminology: z.record(z.string(), z.string().max(160)),
  disambiguationRules: z.array(shortText).max(40),
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;
export const PROJECT_CONTEXT_LIMIT = 8 * 1024;
export const PROJECT_CONTEXT_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["productSummary", "communityAssumption", "components", "externalPlatforms", "terminology", "disambiguationRules"],
  properties: {
    productSummary: { type: "string", minLength: 1, maxLength: 500 },
    communityAssumption: { type: "string", minLength: 1, maxLength: 500 },
    components: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, required: ["id", "description", "aliases", "indicators", "likelyLabels"], properties: {
      id: { type: "string", minLength: 1, maxLength: 80 }, description: { type: "string", minLength: 1, maxLength: 500 },
      aliases: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } }, indicators: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 160 } }, likelyLabels: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
    } } },
    externalPlatforms: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["name", "role"], properties: { name: { type: "string", minLength: 1, maxLength: 500 }, role: { type: "string", minLength: 1, maxLength: 500 } } } },
    terminology: { type: "object", additionalProperties: { type: "string", maxLength: 160 } },
    disambiguationRules: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 500 } },
  },
} as const;

export function serializeProjectContext(context: ProjectContext): string {
  const serialized = JSON.stringify(ProjectContextSchema.parse(context));
  if (new TextEncoder().encode(serialized).byteLength > PROJECT_CONTEXT_LIMIT) throw new Error("Project context exceeds 8 KiB");
  return serialized;
}
