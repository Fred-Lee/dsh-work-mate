/**
 * Archive delivery manifest (change `adopt-workdsh-lessons`, design D4).
 *
 * After a successful archive run the proposal keeps a per-project summary of what
 * was actually delivered: which commits carried the `[proposal:<id>]` marker, what
 * the diff looked like, whether the change carried spec deltas, and whether the
 * knowledge graph was rebuilt. It is the "交付物" half of the acceptance story —
 * the tasks predicate says the work was finished, the manifest says what shipped.
 *
 * Types only: the collection lives in `orchestrate.ts` (it needs the CLI runner),
 * so `store.ts` can depend on the shape without depending on the orchestration.
 */
export interface ArchiveManifestEntry {
  project: string
  root: string
  /** Short hashes carrying the proposal marker, newest first. */
  commits: string[]
  /** `git diff --stat` between the oldest and newest associated commit. */
  diffStat?: string
  /** The change carried a `specs/` delta that openspec archived. */
  specsUpdated?: boolean
  /** GitNexus re-index reported ok for this project. */
  reindexed: boolean
  /** Path of the archived change directory, when it could be located. */
  archivedChangeDir?: string
  /** Set when a probe could not run (not a git repo, unreadable dirs). */
  note?: string
}

export interface ArchiveManifest {
  at: string
  projects: ArchiveManifestEntry[]
}
