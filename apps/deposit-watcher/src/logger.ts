type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly minLevel: Level = 'info') {}

  private emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(ctx ?? {}),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.emit('debug', msg, ctx); }
  info(msg: string, ctx?: Record<string, unknown>): void { this.emit('info', msg, ctx); }
  warn(msg: string, ctx?: Record<string, unknown>): void { this.emit('warn', msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.emit('error', msg, ctx); }
}
