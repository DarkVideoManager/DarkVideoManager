import { shell } from 'electron'
import { loadConfig, updateConfig } from '../infra/config'

const REPOSITORY_URL = 'https://github.com/DarkVideoManager/DarkVideoManager'

/** Persist before displaying, so restarts and later versions do not ask again. */
export function claimGitHubStarPrompt(): boolean {
  if (loadConfig().githubStarPromptShown) return false
  updateConfig((config) => ({ ...config, githubStarPromptShown: true }))
  return true
}

/** No renderer-supplied URLs, account access, or automatic starring. */
export async function openGitHubRepository(): Promise<void> {
  await shell.openExternal(REPOSITORY_URL)
}
