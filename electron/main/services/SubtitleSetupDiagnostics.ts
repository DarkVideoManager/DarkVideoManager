/** Keep useful error codes while excluding local paths and credentials from retry history. */
export function subtitleSetupDiagnostic(value: string, limit = 1600): string {
  const withoutSecrets = value
    // eslint-disable-next-line no-control-regex -- Strip terminal escape/control sequences from logs.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex -- Keep newline/tab while removing hidden control bytes.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(
      /\b(?:Bearer\s+\S+|(?:api[-_]?key|token|password|secret)\s*[:=]\s*\S+)/gi,
      '[비밀값 숨김]',
    )
  const codes = [
    ...new Set(
      withoutSecrets.match(
        /\b(?:HCS_E_[A-Z0-9_]+|WSL_E_[A-Z0-9_]+|E_ACCESSDENIED|0x[0-9a-f]{8})\b/gi,
      ) ?? [],
    ),
  ].slice(-8)
  const redacted = withoutSecrets
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"<>|]*/gi, '[로컬 경로]')
    .replace(/\/(?:home|Users|mnt)\/[^\s"<>]*/g, '[로컬 경로]')
    .trim()
  return [redacted, ...codes.filter((code) => !redacted.includes(code))]
    .filter(Boolean)
    .join('\n')
    .slice(-limit)
}
