import { MapTrifoldIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { PageBody, PageTop } from '@/components/layout'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@/components/ui/empty'

export function NotFound() {
  return (
    <>
      <PageTop title="Page not found" description="There is nothing at this address." />
      <PageBody>
        <Empty variant="card" className="max-w-2xl">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapTrifoldIcon />
            </EmptyMedia>
            <EmptyDescription>
              The link may be old or mistyped. The market and your position are on the dashboard.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/">Go to dashboard</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </PageBody>
    </>
  )
}
