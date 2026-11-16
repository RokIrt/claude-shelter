#!/usr/bin/env node
// token-shelter [--port <n>] [--sim [name]] [--open]
// Thin wrapper: the options are parsed and served by ../server.mjs.
import { runCli } from '../server.mjs';

runCli(process.argv.slice(2));
