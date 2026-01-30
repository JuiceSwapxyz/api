import { PrismaClient } from "../generated/prisma";
import Logger from "bunyan";

const logger = Logger.createLogger({
  name: "prisma-client",
  level: (process.env.LOG_LEVEL as Logger.LogLevel) || "info",
});

// Singleton pattern to prevent connection pool exhaustion
// In development, reuse the same client across hot reloads
// In production, create a single client instance per process

const globalForPrisma = global as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    errorFormat: "minimal",
  });

// Store in global scope in development to prevent multiple instances
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Graceful shutdown - close Prisma connection on process termination
const gracefulShutdown = async () => {
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Connection health check utility
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ error }, "Database connection failed");
    return false;
  }
}
