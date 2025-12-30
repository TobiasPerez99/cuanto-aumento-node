import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

// Configurar DATABASE_URL según el entorno
// Esto debe hacerse ANTES de crear PrismaClient
process.env.DATABASE_URL = process.env.NODE_ENV === "production" ? process.env.DATABASE_URL_PRODUCTION : process.env.DATABASE_URL_DEVELOPMENT;

// Prisma 7 gets configuration from prisma.config.ts
const prisma = new PrismaClient({
  log: ["error", "warn"],
});

export { prisma };
