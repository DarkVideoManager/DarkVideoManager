import { useEffect, useState } from 'react'
import type { AppUpdateState } from '@shared/appUpdate'
import type { Result } from '@shared/result'

export function useAppUpdate() {
  const api = window.api.updates
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const accept = (next: AppUpdateState) =>
    setState((previous) => (!previous || next.revision >= previous.revision ? next : previous))
  useEffect(() => {
    if (!api) return
    let active = true
    const stop = window.api.on.appUpdateChanged?.((next) => {
      if (active) accept(next)
    })
    void api
      .get()
      .then((result) => {
        if (!active) return
        if (result.ok) accept(result.value)
        else setError(result.error)
      })
      .catch(() => {
        if (active) setError('업데이트 상태를 불러오지 못했습니다.')
      })
    return () => {
      active = false
      stop?.()
    }
  }, [api])
  async function run(
    operation: () => Promise<Result<AppUpdateState | null, string>>,
  ): Promise<void> {
    setError(null)
    try {
      const result = await operation()
      if (!result.ok) setError(result.error)
      else if (result.value) accept(result.value)
    } catch {
      setError('업데이트 요청을 완료하지 못했습니다. 다시 시도하세요.')
    }
  }
  return { api, state, error, run }
}
