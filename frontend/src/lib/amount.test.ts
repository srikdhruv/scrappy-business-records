import { amountProblem } from './amount'

const CAP = 'The most you can enter is ₹10,00,000.'
const FORMAT = 'Enter an amount like 1500 or 1,500.'

describe('amountProblem', () => {
  it.each(['1500', '₹1,500/-', 'Rs. 200', '10,00,000', '₹10,00,000/-'])('accepts %j', (input) => {
    expect(amountProblem(input)).toBeNull()
  })

  it.each([
    '20,00,000',
    '₹20,00,000/-',
    '₹ 20,00,000 /-',
    'Rs. 2000000/-',
    'INR 10,00,000.01',
    '99999999999999999999',
  ])('says a well-written %j is over the cap', (input) => {
    expect(amountProblem(input)).toBe(CAP)
  })

  it.each(['20 00 000', '20,00,00', 'abc', '1500 50', '15,00/-'])(
    'says %j isn’t written like an amount',
    (input) => {
      expect(amountProblem(input)).toBe(FORMAT)
    },
  )

  it('asks for an amount, and more than ₹0 unless a 0 fee is fine', () => {
    expect(amountProblem('  ')).toBe('Enter the amount.')
    expect(amountProblem('0')).toBe('The amount must be more than ₹0.')
    expect(amountProblem('0', { allowZero: true, what: 'monthly fee' })).toBeNull()
    expect(amountProblem('₹20,00,000/-', { allowZero: true, what: 'monthly fee' })).toBe(CAP)
  })
})
