// 极简日志:全部走 stderr,让 stdout 留给未来可能的机器可读输出(如 --json)
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s);

export const log = {
  step: (msg: string) => console.error(dim("→ ") + msg),
  ok: (msg: string) => console.error(green("✓ ") + msg),
  warn: (msg: string) => console.error(yellow("! ") + msg),
  error: (msg: string) => console.error(red("✗ ") + msg),
};
