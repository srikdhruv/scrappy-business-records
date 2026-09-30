import { ApiError, unwrap } from './client'

describe('ApiError', () => {
  it('uses a string detail as the message', () => {
    const error = new ApiError(404, 'No student with id 3')
    expect(error.message).toBe('No student with id 3')
    expect(error.fields).toEqual({})
  })

  it('reads FastAPI 422 validation lists', () => {
    const error = new ApiError(422, [
      {
        loc: ['body'],
        msg: 'Value error, left_month cannot be before joined_month',
        type: 'value_error',
      },
      {
        loc: ['body', 'amount_paise'],
        msg: 'Input should be greater than 0',
        type: 'greater_than',
      },
    ])
    expect(error.messages).toEqual([
      'left_month cannot be before joined_month',
      'Input should be greater than 0',
    ])
    expect(error.message).toBe(
      'left_month cannot be before joined_month. Input should be greater than 0',
    )
    expect(error.fields).toEqual({ amount_paise: 'Input should be greater than 0' })
  })

  it('attaches schema rule errors to their field', () => {
    // What the backend sends for a left month before the joined month.
    const error = new ApiError(422, [
      {
        loc: ['body', 'left_month'],
        msg: "Left month can't be before the joined month",
        type: 'value_error',
      },
    ])
    expect(error.message).toBe("Left month can't be before the joined month")
    expect(error.fields).toEqual({ left_month: "Left month can't be before the joined month" })
  })

  it('falls back to a friendly message', () => {
    expect(new ApiError(500, undefined).message).toBe('Something went wrong (error 500).')
  })
})

describe('unwrap', () => {
  it('returns data or throws ApiError', () => {
    const ok = new Response(null, { status: 200 })
    expect(unwrap({ data: { a: 1 }, response: ok })).toEqual({ a: 1 })

    const bad = new Response(null, { status: 422 })
    const detail = [{ loc: ['body', 'name'], msg: 'Field required', type: 'missing' }]
    expect(() => unwrap({ error: { detail }, response: bad })).toThrowError('Field required')
  })
})
