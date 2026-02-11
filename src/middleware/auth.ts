import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import Logger from "bunyan";

const JWT_SECRET = process.env.JWT_SECRET!;

const logger = Logger.createLogger({
  name: "auth",
  level: (process.env.LOG_LEVEL as Logger.LogLevel) || "info",
});

export interface AuthPayload {
  address: string;
  iat: number;
  exp: number;
}

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * JWT authentication middleware.
 * Verifies Bearer token from the Authorization header and attaches
 * the decoded payload (wallet address) to req.user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Unauthorized",
      detail: "Missing or invalid Authorization header",
    });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.user = decoded;
    next();
  } catch (error) {
    logger.debug({ error }, "JWT verification failed");
    res.status(401).json({
      error: "Unauthorized",
      detail: "Invalid or expired token",
    });
  }
}

export { JWT_SECRET };
