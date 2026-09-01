import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { formatLogLine } from "./logger";

const path = Bun.argv[2];
const input = path ? createReadStream(path, "utf8") : stdin;
const lines = createInterface({ input });

for await (const line of lines) {
  if (line.trim()) stdout.write(`${formatLogLine(line, Boolean(stdout.isTTY))}\n`);
}
