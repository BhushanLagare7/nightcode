import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "../generated/prisma/client.ts";

dotenv.config({
  path: path.resolve(import.meta.dirname, "../../../.env"),
});

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL environment variable");
}

const adapter = new PrismaPg({ connectionString: databaseUrl });

export const db = new PrismaClient({ adapter });
