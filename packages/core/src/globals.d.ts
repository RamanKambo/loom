// The core is isomorphic and compiles with `types: []` (no @types/node), so no
// ambient `console` is in scope. selfTest() prints a single summary line; declare
// just the method it uses. `console` exists in every browser and Node runtime.
declare const console: {
  log(...args: unknown[]): void;
};
