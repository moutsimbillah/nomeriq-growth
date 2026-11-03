import { Buffer } from "node:buffer";

process.env.DATABASE_URL = "";
process.env.PGLITE_DIR = `.data/test-vitest-${process.pid}`;
process.env.AUTO_MIGRATE = "true";
process.env.APP_URL = "http://localhost:3100";
process.env.SESSION_SECRET = Buffer.alloc(48, 7).toString("base64");
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.EMAIL_DELIVERY_MODE = "sandbox";
process.env.CRON_SECRET = "test-cron-secret";
process.env.AI_PROVIDER = "none";
