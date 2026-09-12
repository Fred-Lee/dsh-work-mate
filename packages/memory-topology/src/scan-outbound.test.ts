import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placeholderKey, scanOutboundCalls, serviceSegmentOfKey, type OutboundCall } from './scan-outbound.ts'

/**
 * The Feign shape below is copied from the REAL call sites this change was
 * calibrated against (`homework-server`: 7 clients, all placeholder-key form):
 *
 *   @FeignClient(name = "${project.feign-client-config.internal-bc-es.name}", …)
 *
 * Getting this shape right is the difference between the feature working and
 * being useless on the user's repos, so it is the primary fixture here.
 */
const INTERNAL_BC_ES_CLIENT = `package com.example.client;

@FeignClient(name = "\${project.feign-client-config.internal-bc-es.name}",
             url = "\${project.feign-client-config.internal-bc-es.url}",
             path = "\${project.feign-client-config.internal-bc-es.path}",
             configuration = { FeignConfiguration.class, FeignInterceptorConfiguration.class })
public interface InternalBcEsClient {

  @GetMapping("/es_wrong_question/list/{subjectId}")
  ResultContent<PagedList<WrongQuesBO>> getWrongQuesList(@PathVariable Integer subjectId, @SpringQueryMap Map<String, Object> queryMap);
}
`

const HOMEWORK_CLIENT = `package com.example.client;

@FeignClient(name = "internal-homework", path = "/v1")
public interface HomeworkClient {

  @PostMapping(value = "/api/homework/create", produces = "application/json")
  Result create(@RequestBody HomeWorkBO bo);
}
`

const APPLICATION_YML = `project:
  feign-client-config:
    internal-bc-es:
      name: internal-bc-es
      url: http://internal-bc-es:8080
      path: /api
internal-homework:
  base-url: http://internal-homework:8080
homework-server:
  host: homework-server.default.svc.cluster.local
logging:
  level:
    root: info
health:
  host: localhost
db:
  url: http://127.0.0.1:5432/app
`

let resolvableRoot: string
let unresolvedRoot: string
let escapeRoot: string

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeAll(() => {
  resolvableRoot = mkdtempSync(join(tmpdir(), 'helmsman-outbound-'))
  write(resolvableRoot, 'src/main/java/com/example/client/InternalBcEsClient.java', INTERNAL_BC_ES_CLIENT)
  write(resolvableRoot, 'src/main/java/com/example/client/HomeworkClient.java', HOMEWORK_CLIENT)
  write(resolvableRoot, 'src/main/java/com/example/LegacyCaller.java', `package com.example;

public class LegacyCaller {
  private final RestTemplate restTemplate = new RestTemplate();

  public String fetch(String id) {
    String a = restTemplate.getForObject("http://internal-qp:9090/qp/list", String.class);
    String b = restTemplate.postForObject("/local/items/" + id, null, String.class);
    return a + b;
  }
}
`)
  write(resolvableRoot, 'src/main/java/com/example/FormatCaller.java', `package com.example;

public class FormatCaller {
  private final WebClient webClient = WebClient.builder().baseUrl("http://internal-format-factory:8080").build();

  public Mono<String> render(String id) {
    return webClient.get().uri("/format/render/{id}", id).retrieve().bodyToMono(String.class);
  }
}
`)
  write(resolvableRoot, 'src/main/java/com/example/IpCaller.java', `package com.example;

public class IpCaller {
  public void lookup() throws Exception {
    HttpClient client = HttpClient.newHttpClient();
    HttpRequest request = HttpRequest.newBuilder().uri(URI.create("http://zujuan-ip-api:8081/ip/lookup")).GET().build();
    client.send(request, BodyHandlers.ofString());
  }
}
`)
  write(resolvableRoot, 'src/client/orders.ts', `import axios from 'axios'
import http from 'node:http'

export async function loadOrders(id: string) {
  const list = await axios.get(\`/api/users/\${id}/orders\`)
  await axios.post('/api/users', { id })
  const client = axios.create({ baseURL: 'http://user-service:8080' })
  const health = await fetch('/api/health')
  http.get('http://legacy-api:3000/legacy/list')
  return { list, health, client }
}
`)
  write(resolvableRoot, 'src/main/resources/application.yml', APPLICATION_YML)
  write(resolvableRoot, 'src/main/resources/.env', 'USER_SERVICE_BASE_URL=http://user-service:8080\nIGNORED=1\n')
  // A huge minified file must be skipped by the size cap rather than parsed.
  write(resolvableRoot, 'src/main/resources/bundle.min.js', `x`.repeat(600 * 1024))

  // Same Feign client, but with NO config values available locally (Nacos-only).
  unresolvedRoot = mkdtempSync(join(tmpdir(), 'helmsman-outbound-unresolved-'))
  write(unresolvedRoot, 'src/main/java/com/example/client/InternalBcEsClient.java', INTERNAL_BC_ES_CLIENT)

  // Root that resolves outside its own parent → containment must reject it.
  escapeRoot = mkdtempSync(join(tmpdir(), 'helmsman-outbound-escape-'))
  mkdirSync(join(escapeRoot, 'elsewhere'), { recursive: true })
  symlinkSync(escapeRoot, join(escapeRoot, 'loop-link'))
})

afterAll(() => {
  rmSync(resolvableRoot, { recursive: true, force: true })
  rmSync(unresolvedRoot, { recursive: true, force: true })
  rmSync(escapeRoot, { recursive: true, force: true })
})

function find(clues: OutboundCall[], predicate: (c: OutboundCall) => boolean): OutboundCall {
  const found = clues.find(predicate)
  if (!found) throw new Error(`no clue matched; got:\n${clues.map((c) => JSON.stringify(c)).join('\n')}`)
  return found
}

describe('scanOutboundCalls — Feign (placeholder-key form)', () => {
  it('derives the target from the placeholder key segment and resolves its value as evidence', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)

    const feign = find(clues, (c) => c.evidence.kind === 'feign' && c.path === '' && c.target === 'internal-bc-es')
    expect(feign.evidence.file).toBe('src/main/java/com/example/client/InternalBcEsClient.java')
    expect(feign.evidence.line).toBe(3)
    expect(feign.configKey).toBe('project.feign-client-config.internal-bc-es.name')
    expect(feign.note).toBeUndefined()

    // The resolved `url`/`path` values appear as their own config clues.
    const urlClue = find(clues, (c) => c.configKey === 'project.feign-client-config.internal-bc-es.url')
    expect(urlClue.target).toBe('internal-bc-es')
    expect(urlClue.baseUrl).toBe('http://internal-bc-es:8080')
    expect(urlClue.evidence.file).toBe('src/main/resources/application.yml')
    expect(urlClue.detail).toContain('http://internal-bc-es:8080')
  })

  it('joins the resolved class-level prefix into the method path', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    const call = find(clues, (c) => c.evidence.kind === 'feign' && c.path.includes('es_wrong_question'))
    expect(call.path).toBe('/api/es_wrong_question/list/{subjectId}')
    expect(call.method).toBe('GET')
    expect(call.target).toBe('internal-bc-es')
    expect(call.prefixUnresolved).toBeUndefined()
  })

  it('keeps the key-derived clue and marks it unresolved when the value is absent locally', async () => {
    const clues = await scanOutboundCalls(unresolvedRoot)

    const feign = find(clues, (c) => c.evidence.kind === 'feign' && c.path === '')
    expect(feign.target).toBe('internal-bc-es')
    expect(feign.note).toContain('值未解析')

    // Prefix placeholder unresolved → method-level path only, explicitly noted.
    const call = find(clues, (c) => c.evidence.kind === 'feign' && c.path !== '')
    expect(call.path).toBe('/es_wrong_question/list/{subjectId}')
    expect(call.prefixUnresolved).toBe(true)
    expect(call.note).toContain('前缀未解析')
  })

  it('reads a literal @FeignClient name and a literal class-level path prefix', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    const call = find(clues, (c) => c.target === 'internal-homework' && c.path !== '')
    expect(call.path).toBe('/v1/api/homework/create')
    expect(call.method).toBe('POST')
    expect(call.evidence.file).toBe('src/main/java/com/example/client/HomeworkClient.java')
  })
})

describe('scanOutboundCalls — RestTemplate / WebClient / HttpClient', () => {
  it('reads an absolute RestTemplate URL as target + path, and normalises concatenation', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    const absolute = find(clues, (c) => c.detail?.startsWith('RestTemplate.getForObject') && c.target === 'internal-qp')
    expect(absolute.path).toBe('/qp/list')
    expect(absolute.baseUrl).toBe('http://internal-qp:9090')

    const concat = find(clues, (c) => c.detail?.startsWith('RestTemplate.postForObject'))
    expect(concat.path).toBe('/local/items/{}')
    expect(concat.target).toBeUndefined()
  })

  it('reads WebClient baseUrl (name clue) and uri (path clue)', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    expect(find(clues, (c) => c.target === 'internal-format-factory').path).toBe('')
    expect(find(clues, (c) => c.path === '/format/render/{id}').detail).toContain('WebClient')
  })

  it('reads HttpClient URI.create literals', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    const clue = find(clues, (c) => c.detail?.startsWith('HttpClient'))
    expect(clue.target).toBe('zujuan-ip-api')
    expect(clue.path).toBe('/ip/lookup')
  })
})

describe('scanOutboundCalls — JS/TS', () => {
  it('normalises template-literal interpolation to the placeholder form', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    const clue = find(clues, (c) => c.detail?.includes('axios.get'))
    expect(clue.path).toBe('/api/users/{}/orders')
    expect(clue.method).toBe('GET')
    expect(clue.evidence.file).toBe('src/client/orders.ts')
    expect(clue.evidence.line).toBe(5)
  })

  it('reads axios string args, axios.create baseURL, fetch and http.get', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    expect(find(clues, (c) => c.detail?.includes('axios.post') && c.path === '/api/users').method).toBe('POST')
    expect(find(clues, (c) => c.detail?.startsWith('axios.create') && c.target === 'user-service').baseUrl).toBe('http://user-service:8080')
    expect(find(clues, (c) => c.detail?.startsWith('fetch(…)')).path).toBe('/api/health')
    const nodeHttp = find(clues, (c) => c.detail?.startsWith('http.get'))
    expect(nodeHttp.path).toBe('/legacy/list')
    expect(nodeHttp.target).toBe('legacy-api')
    expect(nodeHttp.method).toBe('GET')
  })
})

describe('scanOutboundCalls — base/config clues', () => {
  it('collects *.base-url / *.host keys and k8s service DNS with file+key evidence', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    const baseUrl = find(clues, (c) => c.configKey === 'internal-homework.base-url')
    expect(baseUrl.target).toBe('internal-homework')
    expect(baseUrl.evidence).toEqual({ file: 'src/main/resources/application.yml', line: expect.any(Number), kind: 'config' })

    const k8s = find(clues, (c) => c.configKey === 'homework-server.host')
    expect(k8s.target).toBe('homework-server')

    const env = find(clues, (c) => c.evidence.file.endsWith('.env'))
    expect(env.target).toBe('user-service')
  })

  it('skips generic keys, IPs and oversized files', async () => {
    const clues = await scanOutboundCalls(resolvableRoot)
    expect(clues.some((c) => c.configKey?.startsWith('logging'))).toBe(false)
    expect(clues.some((c) => c.evidence.file.includes('bundle.min.js'))).toBe(false)
    expect(clues.some((c) => c.target === 'localhost')).toBe(false)
  })

  it('names the callee from the value (not a container word) for env-style keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'helmsman-outbound-env-'))
    try {
      write(
        root,
        'docker-compose.yml',
        `services:
  app:
    image: example/app
    environment:
      USER_SERVICE_URL: http://user-service:8080
volumes:
  data: {}
`,
      )
      const clues = await scanOutboundCalls(root)
      const env = find(clues, (c) => c.baseUrl === 'http://user-service:8080')
      expect(env.target).toBe('user-service')
      expect(env.targetAliases).toBeUndefined()
      expect(clues.some((c) => c.target === 'environment' || c.target === 'app' || c.target === 'services')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('scanOutboundCalls — bounds and containment', () => {
  it('stops at the shared file-count limit instead of scanning forever', async () => {
    const limited = await scanOutboundCalls(resolvableRoot, { maxFiles: 1 })
    const full = await scanOutboundCalls(resolvableRoot)
    expect(limited.length).toBeLessThan(full.length)
    await expect(scanOutboundCalls(resolvableRoot, { maxDepth: 0 })).resolves.toEqual([])
  })

  it('rejects a root whose realpath escapes its own parent', async () => {
    const link = join(escapeRoot, 'elsewhere-out')
    symlinkSync(escapeRoot, link)
    await expect(scanOutboundCalls(link)).rejects.toThrow(/escapes scan root/)
  })

  it('never follows a symlinked loop inside the tree', async () => {
    const clues = await scanOutboundCalls(escapeRoot)
    expect(Array.isArray(clues)).toBe(true)
  })
})

describe('key helpers', () => {
  it('reads placeholder keys and their service segment', () => {
    expect(placeholderKey('${project.feign-client-config.internal-bc-es.name}')).toBe('project.feign-client-config.internal-bc-es.name')
    expect(placeholderKey('internal-homework')).toBeUndefined()
    expect(serviceSegmentOfKey('project.feign-client-config.internal-bc-es.name', 'name')).toBe('internal-bc-es')
    expect(serviceSegmentOfKey('internal-homework.base-url')).toBe('internal-homework')
    expect(serviceSegmentOfKey('url')).toBeUndefined()
  })
})

/**
 * Regression: the real configs leave `path:` blank (Spring Feign clients
 * commonly do), which parses to null. Recording that as "missing" printed a
 * misleading `值未解析 / 前缀未解析` note on every client, and dropping the
 * url-derived prefix silently shortened every call path — both observed on
 * `homework-server` (137 clues, 137 misleading notes).
 */
describe('blank config values (real-world Feign shape)', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helmsman-outbound-blank-'))
    write(root, 'src/main/java/com/example/client/BlankPathClient.java', `package com.example.client;

@FeignClient(name = "\${project.feign-client-config.internal-homework.name}",
             url = "\${project.feign-client-config.internal-homework.url}",
             path = "\${project.feign-client-config.internal-homework.path}")
public interface BlankPathClient {

  @GetMapping("/class/list")
  Result list();
}
`)
    write(root, 'src/main/resources/application-dev.yml', `project:
  feign-client-config:
    internal-homework:
      name: internal-homework
      url: https://yan2.zxxk.com/12091/16021/internal-api-v4/homework
      path:
`)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reports a blank path as present-but-empty rather than unresolved', async () => {
    const calls = await scanOutboundCalls(root)
    const notes = calls.map((c) => c.note ?? '').join('\n')
    expect(notes).not.toContain('未解析')
    expect(notes).toContain('前缀为空')
  })

  it('keeps the url-derived prefix when path is blank', async () => {
    const calls = await scanOutboundCalls(root)
    const call = calls.find((c) => c.path !== '' && c.evidence?.kind === 'feign')
    expect(call?.path).toBe('/12091/16021/internal-api-v4/homework/class/list')
    expect(call?.baseUrl).toBe('https://yan2.zxxk.com/12091/16021/internal-api-v4/homework')
  })

  it('does not turn an empty setting into a clue of its own', async () => {
    const calls = await scanOutboundCalls(root)
    const blank = calls.find((c) => c.evidence?.kind === 'config' && c.configKey?.endsWith('.path'))
    expect(blank).toBeUndefined()
  })
})
