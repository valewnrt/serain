import { createInterface } from "node:readline/promises";

/** Terminal input for the setup scripts. Secrets are never shown and never appear in argv. */

const KEY_ENTER = [13, 10, 4];
const KEY_CTRL_C = 3;
const KEY_BACKSPACE = [127, 8];

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line without showing it. The password never appears in argv or in the shell history. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("The password is only asked for at a terminal."));
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    const typed: number[] = [];
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (KEY_ENTER.includes(byte)) {
          finish();
          return resolve(Buffer.from(typed).toString("utf8"));
        }
        if (byte === KEY_CTRL_C) {
          finish();
          return reject(new Error("Cancelled."));
        }
        if (KEY_BACKSPACE.includes(byte)) typed.pop();
        else typed.push(byte);
      }
    };
    stdin.on("data", onData);
  });
}
