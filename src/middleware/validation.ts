import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import Logger from "bunyan";

/**
 * Validation middleware factory for request body validation
 * Uses Zod schemas to validate incoming requests and provide clear error messages
 */
export function validateBody(schema: ZodSchema, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Validate and transform the request body
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((err: any) => ({
          field: err.path.join("."),
          message: err.message,
        }));

        logger.debug(
          { errors, body: req.body },
          "Request body validation failed",
        );

        res.status(400).json({
          error: "Validation failed",
          detail: "Invalid request body",
          errors,
        });
      } else {
        logger.error({ error }, "Unexpected error during validation");
        res.status(500).json({
          error: "Internal server error",
          detail: "An error occurred during validation",
        });
      }
    }
  };
}

/**
 * Validation middleware factory for query parameters validation
 * Uses Zod schemas to validate incoming query parameters
 */
export function validateQuery(schema: ZodSchema, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Validate and transform the query parameters
      req.query = schema.parse(req.query) as any;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((err: any) => ({
          field: err.path.join("."),
          message: err.message,
        }));

        logger.debug(
          { errors, query: req.query },
          "Query parameter validation failed",
        );

        res.status(400).json({
          error: "Validation failed",
          detail: "Invalid query parameters",
          errors,
        });
      } else {
        logger.error({ error }, "Unexpected error during validation");
        res.status(500).json({
          error: "Internal server error",
          detail: "An error occurred during validation",
        });
      }
    }
  };
}
