export const DOMAIN_ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  LOCKED: 'LOCKED',
  IO: 'IO',
  DATABASE: 'DATABASE',
  FFMPEG: 'FFMPEG',
  INTERNAL: 'INTERNAL',
} as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES]

export interface DomainError {
  code: DomainErrorCode
  message: string
  details?: Record<string, unknown>
}

export type Ok<T> = { ok: true; value: T }
export type Err<E = DomainError> = { ok: false; error: E }
export type Result<T, E = DomainError> = Ok<T> | Err<E>
export type DomainResult<T> = Result<T, DomainError>

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return details === undefined ? { code, message } : { code, message, details }
}

export function toDomainError(error: unknown, fallbackMessage = '알 수 없는 오류'): DomainError {
  if (isDomainError(error)) return error
  if (error instanceof Error) {
    return domainError(DOMAIN_ERROR_CODES.INTERNAL, error.message)
  }
  return domainError(DOMAIN_ERROR_CODES.INTERNAL, fallbackMessage)
}

export function isDomainError(error: unknown): error is DomainError {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as Partial<DomainError>
  return (
    typeof candidate.code === 'string' &&
    Object.values(DOMAIN_ERROR_CODES).includes(candidate.code as DomainErrorCode) &&
    typeof candidate.message === 'string'
  )
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok
}
