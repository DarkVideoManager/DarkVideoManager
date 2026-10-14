import pino from 'pino'

const isDev = process.env['NODE_ENV'] === 'development'

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
})

export function createLogger(module: string): pino.Logger {
  return logger.child({ module })
}
