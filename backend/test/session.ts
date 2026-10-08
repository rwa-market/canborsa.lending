/** Session for route tests: a token with the same secret as the app (AUTH_SECRET). */
import { createAuth } from '../src/auth.ts'

export const TEST_SECRET = 'test-secret-0123456789-0123456789-0123'
export const sessionFor = (party: string) => createAuth(TEST_SECRET).issue(party)
