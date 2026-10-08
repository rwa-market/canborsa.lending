import { useCallback, useSyncExternalStore } from 'react'

/** The theme lives in the `dark` class on <html>; the initial value is set by a script in index.html. */
type Theme = 'light' | 'dark'

const listeners = new Set<() => void>()
const read = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

function apply(theme: Theme) {
  const root = document.documentElement
  root.classList.add('theme-switching')
  root.classList.toggle('dark', theme === 'dark')
  try {
    localStorage.setItem('theme', theme)
  } catch {
    // storage unavailable: the theme lasts until reload
  }
  requestAnimationFrame(() => root.classList.remove('theme-switching'))
  listeners.forEach((l) => l())
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    read,
    () => 'light' as Theme,
  )
  const toggle = useCallback(() => apply(read() === 'dark' ? 'light' : 'dark'), [])
  return { theme, toggle }
}
