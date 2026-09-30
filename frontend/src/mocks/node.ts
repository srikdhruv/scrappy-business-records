/** The mock API for Vitest (Node). Tests reset `mockDb` to the fixture they need. */
import { setupServer } from 'msw/node'

import { MockDb } from './db'
import { createHandlers } from './handlers'

export const mockDb = new MockDb()
export const server = setupServer(...createHandlers(mockDb))
