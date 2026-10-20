// The `server-only` package ships no type declarations. Without this, every
// `import "server-only"` (this task's test, and the modules later tasks add)
// fails `tsc --noEmit` with TS7016.
declare module "server-only";
