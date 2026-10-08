import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useTheme } from '@/lib/theme'

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return <Sonner theme={theme} position="bottom-right" richColors closeButton {...props} />
}
