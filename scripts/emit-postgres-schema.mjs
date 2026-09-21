#!/usr/bin/env node
/**
 * Write the schema out as Postgres DDL.
 *
 *   npm run emit-postgres-schema > costgrid-postgres.sql
 *
 * This is generated and validated DDL. It is not a Postgres port, and calling
 * it "half" of one would be generous: the schema is a single component beside
 * connection management, async drivers, placeholder syntax, transaction and
 * locking behaviour, date functions, schema introspection, error handling,
 * backups and deployment. None of those have been done.
 *
 * What it is worth: the DDL is applied to a real PostgreSQL in the test suite,
 * with production-scale values written and read back, and the money aggregates
 * run on both engines over identical rows and compared. So the one difference
 * that actually bites is handled rather than waiting to be discovered on the
 * day: SQLite's INTEGER is 64-bit and Postgres's is 32-bit, which every
 * nanodollar and every millisecond timestamp in this product would overflow.
 *
 * Validated via PGlite, which is Postgres built from the same C sources to
 * WebAssembly. That makes the parser, planner, types and constraints the real
 * ones. It is a single in-process connection, so it says nothing about
 * pooling, lock contention under concurrency, replication or server tuning.
 */
import { postgresSchema } from "../packages/db/dist/index.js";

process.stdout.write(`${postgresSchema()}\n`);
