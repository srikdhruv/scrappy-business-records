import { findUnsavedInput, hasUnsavedHere, resetUnsaved, setUnsaved } from './unsaved'

afterEach(() => resetUnsaved())

describe('unsaved input', () => {
  it('counts forms marked as typed in, until they clear', async () => {
    expect(hasUnsavedHere()).toBe(false)
    setUnsaved('a', true)
    setUnsaved('b', true)
    setUnsaved('a', false)
    expect(hasUnsavedHere()).toBe(true)
    expect(await findUnsavedInput(20)).toEqual({ here: true, elsewhere: false })
    setUnsaved('b', false)
    expect(await findUnsavedInput(20)).toEqual({ here: false, elsewhere: false })
  })

  it('hears from another window of the app', async () => {
    // Another window: answers "yes" when asked.
    const other = new BroadcastChannel('scrappy-unsaved')
    other.onmessage = (event: MessageEvent<{ type: string; id: string }>) => {
      if (event.data.type === 'ask') {
        other.postMessage({ type: 'answer', id: event.data.id, unsaved: true })
      }
    }
    try {
      expect(await findUnsavedInput(200)).toEqual({ here: false, elsewhere: true })
    } finally {
      other.close()
    }
  })

  it('answers another window that asks', async () => {
    setUnsaved('form', true)
    const other = new BroadcastChannel('scrappy-unsaved')
    const answer = new Promise<unknown>((resolve) => {
      other.onmessage = (event) => resolve(event.data)
    })
    other.postMessage({ type: 'ask', id: 'x1' })
    try {
      expect(await answer).toEqual({ type: 'answer', id: 'x1', unsaved: true })
    } finally {
      other.close()
    }
  })
})
