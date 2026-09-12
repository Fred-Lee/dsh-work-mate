import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRestApis } from './scan-rest.ts'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'helmsman-scan-'))
  const java = join(dir, 'src', 'main', 'java')
  mkdirSync(java, { recursive: true })
  writeFileSync(join(java, 'UserController.java'), `package com.example;

@RestController
@RequestMapping("/api/users")
public class UserController {

  @GetMapping("/{id}")
  public User get(@PathVariable Long id) { return null; }

  @PostMapping
  public User create() { return null; }

  @DeleteMapping("/{id}")
  public void delete() {}
}
`)
  const ts = join(dir, 'src')
  writeFileSync(join(ts, 'orders.controller.ts'), `import { Controller, Get, Post } from '@nestjs/common'

@Controller('orders')
export class OrdersController {
  @Get()
  list() {}

  @Post(':id/ship')
  ship() {}
}
`)
  writeFileSync(join(ts, 'legacy-router.js'), `
const router = require('express').Router()
router.get('/health', handler)
app.post('/hooks/pay', handler2)
`)
  // should be skipped
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'router.js'), "router.get('/noisy', () => {})")
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('scanRestApis', () => {
  it('finds Spring, NestJS and Express endpoints, skipping node_modules', async () => {
    const endpoints = await scanRestApis(dir)
    const paths = endpoints.map((e) => `${e.method} ${e.path}`)

    expect(paths).toContain('GET /api/users/{id}')
    expect(paths).toContain('POST /api/users')
    expect(paths).toContain('DELETE /api/users/{id}')
    expect(paths).toContain('GET /orders')
    expect(paths).toContain('POST /orders/:id/ship')
    expect(paths).toContain('GET /health')
    expect(paths).toContain('POST /hooks/pay')
    expect(paths).not.toContain('GET /noisy')
  })
})

/**
 * Regression: a `@FeignClient` interface declares an OUTBOUND contract, but its
 * methods carry the same `@GetMapping`-style annotations as a controller, so it
 * was counted as an exposed endpoint. On real services that inflated the API
 * surface badly (homework-server: 220 -> 129 endpoints once excluded) and made
 * the dependency derivation match one service's outbound call against another
 * service's phantom endpoint, inventing a dependency that does not exist.
 */
describe('Feign client interfaces are not exposed endpoints', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helmsman-scan-feign-'))
    const java = join(root, 'src', 'main', 'java')
    mkdirSync(join(java, 'client'), { recursive: true })
    writeFileSync(
      join(java, 'client', 'RemoteUserClient.java'),
      `package com.example.client;

@FeignClient(name = "\${project.feign-client-config.user.name}")
public interface RemoteUserClient {

  @GetMapping("/remote/users/{id}")
  User fetch(@PathVariable Long id);
}
`,
    )
    writeFileSync(
      join(java, 'LocalController.java'),
      `package com.example;

@RestController
@RequestMapping("/api/local")
public class LocalController {

  @GetMapping("/ping")
  public String ping() { return "ok"; }
}
`,
    )
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('skips the client interface but keeps the real controller', async () => {
    const paths = (await scanRestApis(root)).map((e) => `${e.method} ${e.path}`)
    expect(paths).toContain('GET /api/local/ping')
    expect(paths).not.toContain('GET /remote/users/{id}')
  })
})
