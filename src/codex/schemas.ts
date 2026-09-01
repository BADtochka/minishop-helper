import { z } from "zod";

export const IssueTypeSchema = z.enum([
  "bug",
  "feature_request",
  "improvement",
  "documentation",
  "task",
]);

const CurrentIssueSchema = z.object({
  type: IssueTypeSchema,
  title: z.string().trim().min(3).max(100),
  description: z.string().min(1).max(30_000),
  labels: z.array(z.string().trim().min(1)).max(100),
  confidence: z.number().min(0).max(1),
});

// Existing previews may have been persisted before `body` was renamed.
export const IssueSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || "description" in value || !("body" in value)) return value;
  const { body, ...rest } = value as Record<string, unknown>;
  return { ...rest, description: body };
}, CurrentIssueSchema);

export type Issue = z.infer<typeof CurrentIssueSchema>;
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const ISSUE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "description", "labels", "confidence"],
  properties: {
    type: { enum: IssueTypeSchema.options },
    title: { type: "string", minLength: 3, maxLength: 100 },
    description: { type: "string", minLength: 1, maxLength: 30_000 },
    labels: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export function normalizeIssue(value: unknown, confidenceThreshold = 0.6): Issue {
  const issue = IssueSchema.parse(value);
  return issue.confidence < confidenceThreshold ? { ...issue, type: "task" } : issue;
}
