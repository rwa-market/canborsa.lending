/** Dates and times in the UI are always in English, regardless of the browser locale. */
const LOCALE = 'en-US'

/** «Oct 1, 2026, 2:29 PM» */
export const formatDateTime = (iso: string | number | Date) =>
  new Date(iso).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })

/** «2:29:05 PM» */
export const formatTime = (iso: string | number | Date) => new Date(iso).toLocaleTimeString(LOCALE)
