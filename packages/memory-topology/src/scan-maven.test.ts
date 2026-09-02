import { describe, expect, it } from 'vitest'
import { deriveParentRelations, scanMavenPom } from './scan-maven.ts'

const ROOT_POM = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.example</groupId>
  <artifactId>order-platform</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <properties>
    <spring-boot.version>3.2.0</spring-boot.version>
    <java.version>17</java.version>
  </properties>
  <modules>
    <module>user-service</module>
    <module>order-service</module>
  </modules>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
        <version>\${spring-boot.version}</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>common-lib</artifactId>
        <version>2.1.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>
`

const CHILD_POM = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>order-platform</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>user-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`

const UNRELATED_POM = `<project>
  <groupId>com.other</groupId>
  <artifactId>other-service</artifactId>
  <version>9.9.9</version>
</project>
`

describe('scanMavenPom', () => {
  it('extracts coordinates, modules and managed deps with property resolution', () => {
    const r = scanMavenPom('/fake/pom.xml', ROOT_POM)
    expect(r.groupId).toBe('com.example')
    expect(r.artifactId).toBe('order-platform')
    expect(r.modules).toEqual(['user-service', 'order-service'])
    expect(r.managedDependencies['org.springframework.boot:spring-boot-starter-web']).toBe('3.2.0')
    expect(r.managedDependencies['com.example:common-lib']).toBe('2.1.0')
    expect(r.properties['spring-boot.version']).toBe('3.2.0')
    expect(r.parent).toBeUndefined()
  })

  it('extracts parent coordinates', () => {
    const r = scanMavenPom('/fake/user/pom.xml', CHILD_POM)
    expect(r.parent).toEqual({ groupId: 'com.example', artifactId: 'order-platform', version: '1.0.0' })
    expect(r.artifactId).toBe('user-service')
  })
})

describe('deriveParentRelations', () => {
  it('links only children whose parent matches the root', () => {
    const root = scanMavenPom('/fake/pom.xml', ROOT_POM)
    const child = scanMavenPom('/fake/user/pom.xml', CHILD_POM)
    const unrelated = scanMavenPom('/fake/other/pom.xml', UNRELATED_POM)
    const [relation] = deriveParentRelations(root, [child, unrelated])
    expect(relation!.children).toHaveLength(1)
    expect(relation!.children[0]!.artifactId).toBe('user-service')
  })
})
