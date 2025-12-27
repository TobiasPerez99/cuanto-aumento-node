import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

// Prisma 7 gets configuration from prisma.config.ts
const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

export { prisma };
