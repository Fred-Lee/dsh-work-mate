/**
 * Maven parent-POM scanner — extracts parent coordinates, project
 * coordinates, <modules>, and <dependencyManagement> versions from pom.xml
 * with a lightweight tag matcher (no XML library, no supply-chain surface).
 */

export interface MavenScanResult {
  pomPath: string
  groupId: string
  artifactId: string
  version: string
  parent?: { groupId: string; artifactId: string; version: string; relativePath?: string }
  modules: string[]
  managedDependencies: Record<string, string>
  properties: Record<string, string>
}

interface Tag {
  name: string
  text: string
  inner: string
}

function matchTags(xml: string, tagName: string, scope: string): Tag[] {
  // Search only within `scope` (an already-extracted inner XML region).
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g')
  const out: Tag[] = []
  for (const m of scope.matchAll(re)) {
    out.push({ name: tagName, text: m[1]!.trim(), inner: m[1]! })
  }
  return out
}

function firstTag(xml: string, tagName: string, scope = xml): string | undefined {
  return matchTags(xml, tagName, scope)[0]?.text
}

function resolveProps(text: string, props: Record<string, string>): string {
  return text.replace(/\$\{([^}]+)\}/g, (_, name: string) => props[name] ?? `\${${name}}`)
}

export function scanMavenPom(pomPath: string, xml: string): MavenScanResult {
  const properties: Record<string, string> = {}
  // generic property extraction: any <name>value</name> directly under <properties>
  const propsMatch = xml.match(/<properties>([\s\S]*?)<\/properties>/)
  if (propsMatch) {
    for (const m of propsMatch[1]!.matchAll(/<([A-Za-z][A-Za-z0-9._-]*)>([^<]*)<\/\1>/g)) {
      properties[m[1]!] = m[2]!.trim()
    }
  }

  const managedDependencies: Record<string, string> = {}
  const depMgmt = xml.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/)
  if (depMgmt) {
    for (const dep of matchTags(depMgmt[1]!, 'dependency', depMgmt[1]!)) {
      const g = firstTag(dep.inner, 'groupId') ?? ''
      const a = firstTag(dep.inner, 'artifactId') ?? ''
      const v = firstTag(dep.inner, 'version') ?? ''
      if (g && a) managedDependencies[`${g}:${a}`] = resolveProps(v, properties)
    }
  }

  const modules: string[] = []
  const modulesXml = firstTag(xml, 'modules') ?? ''
  for (const mod of matchTags(modulesXml, 'module', xml)) modules.push(mod.text)

  const parentInner = firstTag(xml, 'parent') ?? ''
  const parent = parentInner
    ? {
        groupId: resolveProps(firstTag(parentInner, 'groupId') ?? '', properties),
        artifactId: resolveProps(firstTag(parentInner, 'artifactId') ?? '', properties),
        version: resolveProps(firstTag(parentInner, 'version') ?? '', properties),
        ...(firstTag(parentInner, 'relativePath') ? { relativePath: firstTag(parentInner, 'relativePath')! } : {}),
      }
    : undefined

  // Project coordinates: exclude the <parent> block so inherited poms don't
  // report the parent's groupId/artifactId as their own.
  const withoutParent = parentInner ? xml.replace(/<parent>[\s\S]*?<\/parent>/, '') : xml

  return {
    pomPath,
    groupId: resolveProps(firstTag(withoutParent, 'groupId') ?? parent?.groupId ?? '', properties),
    artifactId: resolveProps(firstTag(withoutParent, 'artifactId') ?? '', properties),
    version: resolveProps(firstTag(withoutParent, 'version') ?? parent?.version ?? '', properties),
    ...(parent ? { parent } : {}),
    modules,
    managedDependencies,
    properties,
  }
}

export interface ParentChildLink {
  parentKey: string
  childPom: { pomPath: string; groupId: string; artifactId: string; version: string }
}

/**
 * Given a root pom and the poms of its modules, derives a mavenParents node:
 * the root is the parent; children are those module poms whose <parent>
 * coordinates match the root's coordinates.
 */
export function deriveParentRelations(
  rootPom: MavenScanResult,
  childPoms: MavenScanResult[],
): Array<{ root: MavenScanResult; children: MavenScanResult[] }> {
  const rootKey = `${rootPom.groupId}:${rootPom.artifactId}`
  const children = childPoms.filter((c) => c.parent && `${c.parent.groupId}:${c.parent.artifactId}` === rootKey)
  return [{ root: rootPom, children }]
}
