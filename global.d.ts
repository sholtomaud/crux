// Type declarations for non-JS assets bundled by esbuild
declare module '*.sql' {
  const content: string;
  export default content;
}

declare module '*.md' {
  const content: string;
  export default content;
}
