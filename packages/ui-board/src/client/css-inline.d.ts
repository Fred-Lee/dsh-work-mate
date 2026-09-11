/** `styles.css?inline` imports resolve to the stylesheet text (esbuild text loader). */
declare module '*.css?inline' {
  const cssText: string
  export default cssText
}
