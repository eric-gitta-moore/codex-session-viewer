import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

function resolveBasePath() {
  const repository = process.env.GITHUB_REPOSITORY

  if (process.env.GITHUB_ACTIONS !== 'true' || !repository) {
    return '/'
  }

  const repositoryName = repository.split('/')[1]

  // Project Pages need the repo name as the base path, while user pages stay at root.
  return repositoryName.endsWith('.github.io') ? '/' : `/${repositoryName}/`
}

export default defineConfig({
  plugins: [vue()],
  base: resolveBasePath(),
})
