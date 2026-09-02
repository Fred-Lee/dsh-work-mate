import { describe, expect, it } from 'vitest'
import { parseYamlSubset, toYaml } from './yaml.ts'

describe('parseYamlSubset', () => {
  it('parses docker-compose style documents', () => {
    const doc = parseYamlSubset(`
version: "3"
services:
  api-gateway:
    image: nginx:latest
    depends_on:
      - user-service
  user-service:
    image: user-service:1.2.0
    environment:
      - DB_HOST=mysql
    ports:
      - 8080:8080
`)
    const services = (doc as { services: Record<string, Record<string, unknown>> }).services
    expect(services['api-gateway']?.image).toBe('nginx:latest')
    expect(services['api-gateway']?.depends_on).toEqual(['user-service'])
    expect(services['user-service']?.environment).toEqual(['DB_HOST=mysql'])
    expect(services['user-service']?.ports).toEqual(['8080:8080'])
  })

  it('parses scalars and inline lists', () => {
    const doc = parseYamlSubset(`
a: 42
b: 1.5
c: true
d: null
e: [one, two, "three"]
f: 'quoted string'
g: plain_string
`)
    expect(doc).toEqual({
      a: 42,
      b: 1.5,
      c: true,
      d: null,
      e: ['one', 'two', 'three'],
      f: 'quoted string',
      g: 'plain_string',
    })
  })

  it('skips comments and blank lines', () => {
    const doc = parseYamlSubset(`
# comment
key: value

other: 1
`)
    expect(doc).toEqual({ key: 'value', other: 1 })
  })
})

describe('toYaml', () => {
  it('emits topology-export-shaped documents', () => {
    const yaml = toYaml({
      projectGroup: { name: '订单中台', description: '', defaultBranch: 'main' },
      services: [{ id: 'user-service', name: 'user-service', type: 'maven', techStack: ['Java 17'] }],
      restDependencies: [{ from: 'user-service', to: 'order-service', method: 'GET', endpoints: ['/api/x'] }],
    })
    expect(yaml).toContain("name: '订单中台'")
    expect(yaml).toContain('- id: user-service')
    expect(yaml).toContain('techStack: [Java 17]')
    expect(yaml).toContain('from: user-service')
  })

  it('round-trips scalars through the parser', () => {
    const obj = { a: 1, b: 'two words', c: true, list: [1, 2, 3] }
    const parsed = parseYamlSubset(toYaml(obj))
    expect(parsed).toEqual(obj)
  })
})
