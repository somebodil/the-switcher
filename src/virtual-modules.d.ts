declare module "virtual:regex-worker" {
  /** The code of the worker that tries regular expressions, built by esbuild.config.mjs */
  const code: string;
  export default code;
}
