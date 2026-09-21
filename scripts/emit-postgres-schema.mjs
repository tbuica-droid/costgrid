#!/usr/bin/env node
/**
 * Write the schema out as Postgres DDL.
 *
 *   npm run emit-postgres-schema > costgrid-postgres.sql
 *
 * This is the schema half of the Postgres port, and only that half. The
 * repository layer still speaks to a synchronous SQLite driver, so running
 * this script does not give you a CostGrid on Postgres. What it gives you is a
 * schema that has been translated deliberately rather than by hand on the day,
 * with the one difference that actually bites already handled: SQLite's
 * INTEGER is 64-bit and Postgres's is 32-bit, which every nanodollar and every
 * millisecond timestamp in this product would overflow.
 *
 * Not yet run against a real Postgres. There was none on the machine where
 * this was written, and saying so is cheaper than someone finding out.
 */
import { postgresSchema } from "../packages/db/dist/index.js";

process.stdout.write(`${postgresSchema()}\n`);
