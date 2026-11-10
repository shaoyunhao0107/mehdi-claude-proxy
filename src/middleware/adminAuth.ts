import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { ADMIN_API_SECRET } from "../config.js";

/** Compare without revealing, through timing, how much of the secret matched. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // Local patch: the admin API is only reachable from this machine.
  if (!LOOPBACK.has(req.socket.remoteAddress || "")) {
    res.status(404).json({ error: { message: "Not found", type: "not_found" } });
    return;
  }

  if (!ADMIN_API_SECRET) {
    res.status(503).json({
      error: {
        message: "Admin API is not configured. Set ADMIN_API_SECRET environment variable.",
        type: "configuration_error",
      },
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !sameSecret(authHeader, `Bearer ${ADMIN_API_SECRET}`)) {
    res.status(401).json({
      error: {
        message: "Invalid admin authorization",
        type: "authentication_error",
      },
    });
    return;
  }

  next();
}
