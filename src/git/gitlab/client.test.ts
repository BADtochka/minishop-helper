import { describe, expect, test } from "bun:test";
import { GitLabClient } from "./client";

describe("GitLabClient", () => {
  test("refreshes once after a 401 and retries with the replacement token", async () => {
    const tokens: string[] = [];
    let refreshes = 0;
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.test",
      token: () => "expired",
      refreshToken: async () => { refreshes++; return "fresh"; },
      fetch: async (_url, init) => {
        const authorization = new Headers(init?.headers).get("authorization")!;
        tokens.push(authorization);
        return authorization === "Bearer expired" ? new Response(null, { status: 401 }) : Response.json({ ok: true });
      },
    });

    await expect(client.request("/projects")).resolves.toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(["Bearer expired", "Bearer fresh"]);
  });
});
