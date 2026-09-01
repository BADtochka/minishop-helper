import { describe, expect, test } from "bun:test";
import { GitLabClient } from "./client";
import { GitLabProvider } from "./provider";

const repository = { id: "22", owner: "group", name: "project", fullName: "group/project", description: null, private: true, webUrl: "https://gitlab.example/group/project", defaultBranch: null };

describe("GitLabProvider", () => {
  test("maps users and projects", async () => {
    const fetch = mockFetch([
      { id: 42, username: "octo", name: "Octo Cat", avatar_url: "https://avatar" },
      [{ id: 22, name: "project", path_with_namespace: "group/project", description: null, visibility: "private", web_url: "https://gitlab.example/group/project", namespace: { full_path: "group" } }],
    ]);
    const provider = new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example/", token: () => "secret", fetch }));

    expect(await provider.getCurrentUser()).toEqual({ id: "42", login: "octo", name: "Octo Cat", avatarUrl: "https://avatar" });
    expect(await provider.listRepositories()).toEqual([repository]);
  });

  test("sends auth headers and maps labels", async () => {
    const fetch = mockFetch([[{ name: "bug", color: "#d73a4a", description: "A bug" }]]);
    const provider = new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch }));

    expect(await provider.listLabels(repository)).toEqual([{ name: "bug", color: "d73a4a", description: "A bug" }]);
    const [url, init] = fetch.calls[0]!;
    expect(url).toBe("https://gitlab.example/api/v4/projects/22/labels?per_page=100");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
  });

  test("lists repository branches through the branches endpoint", async () => {
    const fetch = mockFetch([[{ name: "main" }, { name: "release/v1" }]]);
    const provider = new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch }));
    expect(await provider.listBranches(repository)).toEqual(["main", "release/v1"]);
    expect(fetch.calls[0]?.[0]).toBe("https://gitlab.example/api/v4/projects/22/repository/branches?per_page=100&page=1");
  });

  test("follows GitLab x-next-page headers when listing projects", async () => {
    const fetch = mockFetchWithHeaders([
      [[{ id: 1, name: "one", path_with_namespace: "group/one", description: null, visibility: "private", web_url: "https://gitlab.example/group/one", namespace: { full_path: "group" } }], { "x-next-page": "2" }],
      [[{ id: 2, name: "two", path_with_namespace: "group/two", description: null, visibility: "private", web_url: "https://gitlab.example/group/two", namespace: { full_path: "group" } }], {}],
    ]);
    expect((await new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch })).listRepositories()).map((value) => value.fullName)).toEqual(["group/one", "group/two"]);
  });

  test("creates an issue with comma-separated labels", async () => {
    const fetch = mockFetch([{ id: 99, iid: 7, title: "Broken", web_url: "https://gitlab.example/group/project/-/issues/7" }]);
    const provider = new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch }));

    expect(await provider.createIssue(repository, { title: "Broken", description: "Steps", labels: ["bug", "urgent"] })).toEqual({ id: "99", number: 7, title: "Broken", webUrl: "https://gitlab.example/group/project/-/issues/7" });
    const [, init] = fetch.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Broken", description: "Steps", labels: "bug,urgent" });
  });

  test("uploads images as multipart files and adds GitLab markdown before creating the issue", async () => {
    const fetch = mockFetch([
      { markdown: "![telegram](/-/project/22/uploads/image.png)" },
      { id: 99, iid: 7, title: "Broken", web_url: "https://gitlab.example/group/project/-/issues/7" },
    ]);
    const provider = new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch }));

    await provider.createIssue(repository, { title: "Broken", description: "Steps", attachments: [{ mimeType: "image/png", filename: "screen shot.png", dataBase64: Buffer.from("image").toString("base64") }] });

    const [uploadUrl, uploadInit] = fetch.calls[0]!;
    expect(uploadUrl).toBe("https://gitlab.example/api/v4/projects/22/uploads");
    expect(uploadInit?.method).toBe("POST");
    expect(uploadInit?.body).toBeInstanceOf(FormData);
    const file = (uploadInit?.body as FormData).get("file") as File;
    expect(file.name).toBe("screen_shot.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("image");
    expect(JSON.parse(String(fetch.calls[1]?.[1]?.body))).toEqual({ title: "Broken", description: "Steps\n\n![telegram](/-/project/22/uploads/image.png)" });
  });

  test("does not create an issue when an attachment upload fails", async () => {
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("upload failed", { status: 500 });
    }) as typeof globalThis.fetch;
    const provider = new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch }));

    await expect(provider.createIssue(repository, { title: "Broken", attachments: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] })).rejects.toMatchObject({ code: "api", status: 500 });
    expect(calls).toEqual(["https://gitlab.example/api/v4/projects/22/uploads"]);
  });

  test("uses shallow tree, allow-listed raw files, and a bounded issue page", async () => {
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.includes("/repository/files/")) return new Response("readme");
      if (url.includes("/repository/tree")) return Response.json([{ path: "README.md", type: "blob" }, { path: "src", type: "tree" }]);
      if (url.includes("/issues?")) return Response.json(Array.from({ length: 50 }, (_, index) => ({ title: `issue ${index}`, labels: ["bug"] })));
      return Response.json([]);
    }) as typeof globalThis.fetch;
    const sources = await new GitLabProvider(new GitLabClient({ baseUrl: "https://gitlab.example", token: () => "secret", fetch })).collectProjectSources(repository);
    expect(sources.files["README.md"]).toBe("readme"); expect(sources.recentIssues).toHaveLength(50);
    expect(calls.some((url) => url.endsWith("/issues?scope=all&order_by=created_at&sort=desc&per_page=50"))).toBe(true);
    expect(calls.filter((url) => url.includes("/repository/tree")).length).toBeLessThanOrEqual(20);
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
