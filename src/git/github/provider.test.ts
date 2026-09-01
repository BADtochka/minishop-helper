import { describe, expect, test } from "bun:test";
import { GitHubClient } from "./client";
import { GitHubProvider } from "./provider";

const repository = { id: "1", owner: "octo", name: "project", fullName: "octo/project", description: null, private: false, webUrl: "https://github.com/octo/project", defaultBranch: null };

describe("GitHubProvider", () => {
  test("maps users and repositories", async () => {
    const fetch = mockFetch([
      { id: 42, login: "octo", name: "Octo Cat", avatar_url: "https://avatar" },
      { repositories: [{ id: 1, name: "project", full_name: "octo/project", description: null, private: false, html_url: "https://github.com/octo/project", owner: { login: "octo" } }] },
    ]);
    const provider = new GitHubProvider(new GitHubClient({ token: () => "secret", fetch }));

    expect(await provider.getCurrentUser()).toEqual({ id: "42", login: "octo", name: "Octo Cat", avatarUrl: "https://avatar" });
    expect(await provider.listRepositories()).toEqual([repository]);
    expect(fetch.calls[1]?.[0]).toBe("https://api.github.com/installation/repositories?per_page=100");
  });

  test("sends auth headers and maps labels", async () => {
    const fetch = mockFetch([[{ name: "bug", color: "d73a4a", description: "A bug" }]]);
    const provider = new GitHubProvider(new GitHubClient({ token: () => "secret", fetch }));

    expect(await provider.listLabels(repository)).toEqual([{ name: "bug", color: "d73a4a", description: "A bug" }]);
    const [url, init] = fetch.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/octo/project/labels?per_page=100");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github+json");
  });

  test("lists repository branches through the branches endpoint", async () => {
    const fetch = mockFetch([[{ name: "main" }, { name: "release/v1" }]]);
    const provider = new GitHubProvider(new GitHubClient({ token: () => "secret", fetch }));
    expect(await provider.listBranches(repository)).toEqual(["main", "release/v1"]);
    expect(fetch.calls[0]?.[0]).toBe("https://api.github.com/repos/octo/project/branches?per_page=100");
  });

  test("follows GitHub next links when listing repositories", async () => {
    const fetch = mockFetchWithHeaders([
      [{ repositories: [{ id: 1, name: "one", full_name: "octo/one", description: null, private: false, html_url: "https://github.com/octo/one", owner: { login: "octo" } }] }, { link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"' }],
      [{ repositories: [{ id: 2, name: "two", full_name: "octo/two", description: null, private: false, html_url: "https://github.com/octo/two", owner: { login: "octo" } }] }, {}],
    ]);
    expect((await new GitHubProvider(new GitHubClient({ token: () => "secret", fetch })).listRepositories()).map((value) => value.fullName)).toEqual(["octo/one", "octo/two"]);
  });

  test("creates an issue with labels", async () => {
    const fetch = mockFetch([{ id: 99, number: 7, title: "Broken", html_url: "https://github.com/octo/project/issues/7" }]);
    const provider = new GitHubProvider(new GitHubClient({ token: () => "secret", fetch }));

    expect(await provider.createIssue(repository, { title: "Broken", description: "Steps", labels: ["bug", "urgent"] })).toEqual({ id: "99", number: 7, title: "Broken", webUrl: "https://github.com/octo/project/issues/7" });
    const [, init] = fetch.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Broken", body: "Steps", labels: ["bug", "urgent"] });
  });

  test("collects only bounded source endpoints and fifty recent issues", async () => {
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.includes("/contents/README.md")) return Response.json({ content: Buffer.from("readme").toString("base64"), encoding: "base64" });
      if (url.includes("/contents")) return Response.json([{ path: "README.md", type: "file", size: 6 }, { path: "src", type: "dir", size: 0 }]);
      if (url.includes("/issues?")) return Response.json(Array.from({ length: 50 }, (_, index) => ({ title: `issue ${index}`, labels: [{ name: "bug" }] })));
      return Response.json([]);
    }) as typeof globalThis.fetch;
    const calls: string[] = [];
    const sources = await new GitHubProvider(new GitHubClient({ token: () => "secret", fetch })).collectProjectSources(repository);
    expect(sources.files["README.md"]).toBe("readme"); expect(sources.recentIssues).toHaveLength(50);
    expect(calls.some((url) => url.endsWith("/issues?state=all&sort=created&direction=desc&per_page=50"))).toBe(true);
    expect(calls.filter((url) => url.includes("/contents")).length).toBeLessThanOrEqual(21);
  });
});

function mockFetch(responses: unknown[]) {
  const calls: [string, RequestInit | undefined][] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init]);
    return Response.json(responses.shift());
  }) as unknown as typeof globalThis.fetch & { calls: typeof calls };
  fetch.calls = calls;
  return fetch;
}

function mockFetchWithHeaders(responses: Array<[unknown, Record<string, string>]>) {
  return (async () => {
    const [body, headers] = responses.shift()!;
    return Response.json(body, { headers });
  }) as unknown as typeof globalThis.fetch;
}
