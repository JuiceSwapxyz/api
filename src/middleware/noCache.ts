import { Request, Response, NextFunction } from "express";

export function noCache(req: Request, res: Response, next: NextFunction): void {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
  next();
}
