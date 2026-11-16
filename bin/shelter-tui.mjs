#!/usr/bin/env node
// Token Shelter in a terminal pane. See `shelter-tui --help`.
import { runCli } from '../src/tui/app.mjs';

runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    if (process.stdout.isTTY) process.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    process.stderr.write(`shelter-tui: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  },
);
