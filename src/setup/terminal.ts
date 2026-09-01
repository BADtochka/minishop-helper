export type RawInput = {
  isRaw?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  off(event: "data", listener: (chunk: Buffer) => void): void;
};

export type TerminalOutput = { write(value: string): unknown };

export function terminalKeys(chunk: Buffer): string[] {
  const value = chunk.toString();
  const keys: string[] = [];
  for (let index = 0; index < value.length;) {
    if (value[index] === "\u001b" && value[index + 1] === "[" && index + 2 < value.length) {
      keys.push(value.slice(index, index + 3));
      index += 3;
    } else {
      keys.push(value[index]);
      index += 1;
    }
  }
  return keys;
}

export function readSecret(input: RawInput, output: TerminalOutput, prompt: string, pause: () => void, resume: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    let listening = false;
    const cleanup = () => {
      if (listening) input.off("data", onData);
      input.setRawMode(wasRaw);
      resume();
    };
    const finish = (error?: Error) => {
      cleanup();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const key of terminalKeys(chunk)) {
        if (key === "\u0003") return finish(new Error("Setup cancelled"));
        if (key === "\r" || key === "\n") return finish();
        if (key === "\u007f" || key === "\b") value = value.slice(0, -1);
        else if (!key.startsWith("\u001b")) value += key;
      }
    };
    try {
      pause();
      output.write(prompt);
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
      listening = true;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
