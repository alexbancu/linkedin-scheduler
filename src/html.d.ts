// The dashboard files are bundled as plain strings (see "rules" in wrangler.jsonc).
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*/dashboard/app.js' {
  const content: string;
  export default content;
}
