import type { AppDatabase } from "../storage/db";

export function healthResponse(): Response {
  return Response.json({ status: "ok" });
}

export function readyResponse(
  database: AppDatabase,
  telegram: "starting" | "ready" | "failed" | "not_configured" = "not_configured",
  services: Record<string, string> = {},
  required = false,
): Response {
  try {
    database.query("SELECT 1").get();
    const unavailable = telegram === "failed" || (required && (telegram !== "ready" || Object.values(services).some((value) => value !== "ready" && value !== "connected" && value !== "configured" && value !== "running")));
    return Response.json({ status: unavailable ? "not_ready" : "ready", database: "ready", telegram, ...services }, { status: unavailable ? 503 : 200 });
  } catch {
    return Response.json({ status: "not_ready", database: "unavailable", telegram, ...services }, { status: 503 });
  }
}
