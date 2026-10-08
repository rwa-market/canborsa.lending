/* global localStorage, document */
// Theme before first paint: the saved choice, otherwise dark (the product's main theme).
// A separate file, not an inline script: CSP script-src 'self' without hashes (audit F-2, F-15).
try {
  const t = localStorage.getItem('theme')
  const dark = t !== 'light'
  document.documentElement.classList.toggle('dark', dark)
} catch {
  // storage unavailable: dark
  document.documentElement.classList.add('dark')
}
