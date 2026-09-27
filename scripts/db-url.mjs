#!/usr/bin/env node
// Prints the local Supabase Postgres connection string for psql.
import { readFileSync, existsSync } from "node:fs";

const port = process.env.POSTGRES_PORT ?? "54322";
const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;

if (process.argv.includes("--check")) {
  if (!existsSync("supabase/config.toml")) {
    console.error("supabase/config.toml missing — run `supabase init` or use the repo config");
    process.exit(1);
  }
}
process.stdout.write(url);
