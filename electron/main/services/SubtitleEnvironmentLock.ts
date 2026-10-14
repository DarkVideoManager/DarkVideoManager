let installing = false

export function setSubtitleEnvironmentInstalling(value: boolean): void {
  installing = value
}

export function assertSubtitleEnvironmentIdle(): void {
  if (installing) throw new Error('자막 환경 설치가 끝난 뒤 자막 생성을 시작하거나 재개해 주세요.')
}
