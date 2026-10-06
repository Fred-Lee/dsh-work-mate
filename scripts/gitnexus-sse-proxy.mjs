#!/usr/bin/env node
/**
 * SSE 前缀归一代理（给 GitNexus 用）
 *
 * 背景：esp.xkw.cn 的流式响应把每个事件写成 `data:{...}`（冒号后无空格），
 * 而 GitNexus 的 SSE 解析器要求 `data: `（带空格，src/core/wiki/llm-client.ts:417），
 * 于是所有分片被跳过 → content 为空 → 报 "LLM returned empty streaming response"。
 *
 * 本代理只做一件事：把出站 SSE 的 `data:` 规范成 `data: `，其余字节原样透传
 * （非流式响应完全不动）。不改任何服务端，也不改 GitNexus。
 *
 * 由 WorkMate 按需托管（`Config.gitnexusSseProxyEnabled`）：ensureSseProxy() 先探测
 * `GET /healthz`，已在跑就直接复用，没跑才 spawn（detached）。带 `/healthz` 是为了
 * 让"复用还是新起"可判定，也为了避免重复监听同一端口。
 *
 * 手工使用：
 *   node scripts/gitnexus-sse-proxy.mjs                 # 默认 127.0.0.1:8787
 *   PORT=9999 UPSTREAM=https://<网关>/ai/v1/chat/completions node scripts/gitnexus-sse-proxy.mjs
 */
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'
const UPSTREAM = process.env.UPSTREAM ?? 'https://esp.xkw.cn/ai/v1/chat/completions'

/** `data:{...}` → `data: {...}`；已经是 `data: ` 或非 data 行原样返回。 */
const normalizeLine = (line) =>
  line.startsWith('data:') && !line.startsWith('data: ') ? `data: ${line.slice(5)}` : line

const server = http.createServer(async (req, res) => {
  const path = req.url.replace(/\?.*$/, '')
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ service: 'workmate-gitnexus-sse-proxy', pid: process.pid, upstream: UPSTREAM }),
    )
    return
  }
  if (!path.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"use /v1/chat/completions"}')
    return
  }
  const body = []
  for await (const chunk of req) body.push(chunk)

  let upstream
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] ?? 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      body: Buffer.concat(body),
    })
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    return
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/json'
  res.writeHead(upstream.status, { 'content-type': contentType })
  if (!upstream.body) {
    res.end()
    return
  }
  if (!contentType.includes('text/event-stream')) {
    res.end(Buffer.from(await upstream.arrayBuffer()))
    return
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      res.write(`${normalizeLine(line)}\n`)
    }
  }
  if (buffer !== '') res.write(normalizeLine(buffer))
  res.end()
})

server.on('error', (error) => {
  // 端口已被占用 = 已经有一个代理在跑，复用即可（不是失败）。
  if (error.code === 'EADDRINUSE') {
    console.log(`[gitnexus-sse-proxy] ${HOST}:${PORT} 已在运行，复用现有实例`)
    process.exit(0)
  }
  console.error('[gitnexus-sse-proxy] 启动失败:', error.message)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[gitnexus-sse-proxy] http://${HOST}:${PORT}/v1/chat/completions → ${UPSTREAM}`)
})
