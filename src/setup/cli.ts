import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runSetupWizard } from "./wizard";
import { readSecret, terminalKeys } from "./terminal";

const terminal = createInterface({ input: stdin, output: stdout });

async function select(prompt: string, choices: string[], current = choices[0]): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    for (;;) {
      const value = (await terminal.question(`${prompt} (${choices.join(" / ")}) [${current}]: `)).trim() || current;
      if (choices.includes(value)) return value;
      stdout.write(`Choose one of: ${choices.join(", ")}\n`);
    }
  }

  let index = Math.max(0, choices.indexOf(current));
  const render = () => {
    stdout.write(`\x1b[2K\r${prompt} `);
    stdout.write(choices.map((choice, choiceIndex) => choiceIndex === index ? `\x1b[36m[${choice}]\x1b[0m` : choice).join("  "));
  };

  return new Promise((resolve, reject) => {
    terminal.pause();
    const onKey = (chunk: Buffer) => {
      for (const key of terminalKeys(chunk)) {
        if (key === "\u0003") {
          cleanup();
          reject(new Error("Setup cancelled"));
          return;
        }
        if (key === "\u001b[A" || key === "\u001b[D") index = (index + choices.length - 1) % choices.length;
        if (key === "\u001b[B" || key === "\u001b[C") index = (index + 1) % choices.length;
        if (key === "\r" || key === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(choices[index]);
          return;
        }
      }
      render();
    };
    const cleanup = () => {
      stdin.off("data", onKey);
      stdin.setRawMode?.(false);
      terminal.resume();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
    render();
  });
}

try {
  await runSetupWizard({
    ask: (prompt, options) => options?.secret && stdin.isTTY && typeof stdin.setRawMode === "function"
      ? readSecret(stdin, stdout, prompt, () => terminal.pause(), () => terminal.resume())
      : terminal.question(prompt),
    select,
    write: (message) => stdout.write(`${message}\n`),
  });
} finally {
  terminal.close();
}
