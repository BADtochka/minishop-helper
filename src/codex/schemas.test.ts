import { describe, expect, test } from "bun:test";
import { IssueSchema, normalizeIssue } from "./schemas";

const issue = {
  type: "bug" as const,
  title: "Checkout fails",
  description: "The checkout button returns an error.",
  labels: ["checkout"],
  confidence: 0.9,
};

describe("IssueSchema", () => {
  test("accepts the issue contract", () => {
    expect(IssueSchema.parse(issue)).toEqual(issue);
  });

  test("rejects an invalid issue type", () => {
    expect(() => IssueSchema.parse({ ...issue, type: "incident" })).toThrow();
  });

  test("uses task when confidence is below the fallback threshold", () => {
    expect(normalizeIssue({ ...issue, confidence: 0.59 }).type).toBe("task");
    expect(normalizeIssue({ ...issue, confidence: 0.6 }).type).toBe("bug");
  });

  test("reads persisted previews from the former body field", () => {
    const { description: _description, ...metadata } = issue;
    expect(IssueSchema.parse({ ...metadata, body: "Legacy description" }).description).toBe("Legacy description");
  });
});
