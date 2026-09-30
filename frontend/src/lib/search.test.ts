import { fold, studentMatches } from './search'

const arjun = {
  name: 'Arjun Menon',
  phone: '90000 00006',
  guardian_name: 'Lakshmi Menon',
  batch_label: 'Tue/Thu 5pm – Indiranagar',
}
const emile = { name: 'Émile Dsouza', phone: '+91 98765-43210', guardian_name: null }

describe('fold', () => {
  it('drops capitals and accents', () => {
    expect(fold('Émile ÖLUND')).toBe('emile olund')
  })
})

describe('studentMatches', () => {
  it.each([
    ['', arjun],
    ['arjun', arjun],
    ['ARJUN', arjun],
    ['menon arjun', arjun], // words in any order
    ['arj men', arjun],
    ['lakshmi', arjun], // parent
    ['indiranagar', arjun], // class
    ['5pm tue', arjun],
    ['9000000006', arjun], // phone saved with a space
    ['90000 00006', arjun],
    ['90000-00006', arjun],
    ['00006', arjun],
    ['emile', emile], // accents don't matter
    ['EMILE dsouza', emile],
    ['9876543210', emile], // phone saved with punctuation
    ['98765 43210', emile],
    ['+91 98765 43210', emile],
  ])('%j finds %j', (query, student) => {
    expect(studentMatches(student, query)).toBe(true)
  })

  it.each([
    ['arjun kabir', arjun], // every word must match
    ['9000000007', arjun],
    ['12345', emile],
    ['menon', emile],
  ])('%j doesn’t find %j', (query, student) => {
    expect(studentMatches(student, query)).toBe(false)
  })

  it('doesn’t treat a class time as a phone number', () => {
    expect(studentMatches({ ...arjun, batch_label: null }, '5pm')).toBe(false)
  })
})
