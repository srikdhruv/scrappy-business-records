import type { FeedbackRead } from '@/api/types'

import { feedbackOutcome, WAIT_FOR_SENT_MS } from './feedback'
import { dataUrlBytes, visibleBox } from './screenshot'

const pending: FeedbackRead = {
  id: '3f0e8c1a-5b7d-4e2a-9c1f-0a1b2c3d4e5f',
  category: 'problem',
  status: 'pending',
  created_at: '2026-10-15T10:00:00Z',
  sent_at: null,
  attempts: 0,
  sending: true,
}

describe('feedbackOutcome', () => {
  it('waits while the first try is under way', () => {
    expect(feedbackOutcome(undefined, 0)).toBe('sending')
    expect(feedbackOutcome(pending, 2000)).toBe('sending')
  })

  it('says Sent once the inbox has it', () => {
    expect(feedbackOutcome({ ...pending, status: 'sent', attempts: 1 }, 500)).toBe('sent')
  })

  it('says Saved (it goes by itself) when offline or after waiting long enough', () => {
    expect(feedbackOutcome({ ...pending, attempts: 1 }, 1000)).toBe('saved')
    expect(feedbackOutcome(pending, WAIT_FOR_SENT_MS)).toBe('saved')
  })

  it('says it can’t be sent yet when this copy does not send', () => {
    expect(feedbackOutcome({ ...pending, sending: false }, 0)).toBe('held')
  })

  it('says so when the inbox turned it down', () => {
    expect(feedbackOutcome({ ...pending, status: 'failed', attempts: 1 }, 0)).toBe('failed')
  })
})

describe('screenshot helpers', () => {
  it('counts the bytes in a data URL', () => {
    expect(dataUrlBytes('data:image/jpeg;base64,' + btoa('abc'))).toBe(3)
    expect(dataUrlBytes('data:image/jpeg;base64,' + btoa('abcd'))).toBe(4)
    expect(dataUrlBytes('data:image/jpeg;base64,' + btoa('abcde'))).toBe(5)
  })

  it('keeps only the part of the page in the window', () => {
    const view = { scrollX: 0, scrollY: 0, width: 1440, height: 900 }
    expect(visibleBox({ width: 1440, height: 5000 }, view)).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
    })
    expect(visibleBox({ width: 1440, height: 5000 }, { ...view, scrollY: 1200 })).toEqual({
      x: 0,
      y: 1200,
      width: 1440,
      height: 900,
    })
    // A page shorter than the window, and a scroll past the end.
    expect(visibleBox({ width: 1440, height: 600 }, view)).toMatchObject({ y: 0, height: 600 })
    expect(visibleBox({ width: 1440, height: 1000 }, { ...view, scrollY: 900 })).toMatchObject({
      y: 900,
      height: 100,
    })
  })
})
