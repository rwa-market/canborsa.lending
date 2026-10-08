import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Last line of defence (F-19): an error outside routes (header, providers) does not leave
 * a white screen. Page errors are caught by the router's defaultErrorComponent.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main role="alert" className="mx-auto flex min-h-screen max-w-lg items-center p-4 sm:p-8">
        <Card className="w-full text-center">
          <CardHeader>
            <CardTitle asChild>
              <h1 className="text-xl">Something went wrong</h1>
            </CardTitle>
            <CardDescription asChild>
              <p>{this.state.error.message}</p>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }
}
