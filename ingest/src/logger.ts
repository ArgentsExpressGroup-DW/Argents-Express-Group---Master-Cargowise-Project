/**
 * logger.ts
 * Minimal structured logger. Outputs JSON lines in CI; pretty in dev.
 */

import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: Level, message: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  const output = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info:  (msg: string, data?: Record<string, unknown>) => log('info',  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => log('warn',  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
