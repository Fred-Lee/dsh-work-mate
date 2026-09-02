import { describe, expect, it } from 'vitest'
import { changedLineRanges, parseUnifiedDiff } from './diffparse.ts'

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 import x from 'x'
+const added = 1
-const removed = 2
 const kept = 3
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+line one
+line two
`

describe('parseUnifiedDiff', () => {
  it('splits files and counts additions/deletions', () => {
    const files = parseUnifiedDiff(SAMPLE)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: 'src/a.ts', additions: 1, deletions: 1, binary: false })
    expect(files[1]).toMatchObject({ path: 'src/b.ts', additions: 2, deletions: 0 })
  })

  it('detects binary files', () => {
    const out = parseUnifiedDiff(`diff --git a/img.png b/img.png
index 111..222 100644
GIT binary patch
literal 10
`)
    expect(out[0]?.binary).toBe(true)
  })

  it('returns empty array for non-diff input', () => {
    expect(parseUnifiedDiff('hello\nworld\n')).toEqual([])
  })
})

describe('changedLineRanges', () => {
  it('maps new-side line ranges per file', () => {
    const ranges = changedLineRanges(SAMPLE)
    expect(ranges.get('src/a.ts')).toEqual([{ start: 1, end: 5 }]) // hunk +1,4
    expect(ranges.get('src/b.ts')).toEqual([{ start: 1, end: 3 }]) // hunk +1,2
  })
})
