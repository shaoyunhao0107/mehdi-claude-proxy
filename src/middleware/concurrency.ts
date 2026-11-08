// Local patch: cap how many model requests run at once. Every request starts a Claude
// Code CLI process (~250-400 MB); Claude Code clients fire parallel sub-agent requests,
// and too many at once made the CLI fail with "memory allocation failed" on this server.
// Extra requests wait in FIFO order; a client that disconnects while waiting leaves the queue.
import type { Request, Response, NextFunction } from "express";

const MAX = Math.max(1, parseInt(process.env.MAX_CONCURRENT_REQUESTS || "4", 10));
const LIMITED = /^\/(messages|chat\/completions)$/;

let running = 0;
const waiting: Array<() => void> = [];

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

export function concurrencyLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST" || !LIMITED.test(req.path)) return next();

  let done = false;
  const start = () => {
    res.once("close", () => {
      if (!done) {
        done = true;
        release();
      }
    });
    next();
  };

  if (running < MAX) {
    running++;
    start();
    return;
  }
  const t0 = Date.now();
  const ticket = () => {
    const waitedMs = Date.now() - t0;
    if (waitedMs > 1000) console.log(`[concurrency] request waited ${Math.round(waitedMs / 1000)}s for a slot`);
    start();
  };
  waiting.push(ticket);
  // res (not req: req "close" also fires once the body has been read) closes when the
  // client goes away while queued: drop its ticket (no slot was taken).
  res.once("close", () => {
    const i = waiting.indexOf(ticket);
    if (i >= 0) waiting.splice(i, 1);
  });
}

export function concurrencyStatus() {
  return { max: MAX, running, waiting: waiting.length };
}
