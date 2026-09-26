import { createDb, createPool, runMigrations } from "@zal/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();

const pool = createPool(config.databaseUrl);
await runMigrations(pool);
console.log("migrations: ok");

const app = await buildApp({ db: createDb(pool), config, logger: true });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`api: listening on :${config.port}`);
