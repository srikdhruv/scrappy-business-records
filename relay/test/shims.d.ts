// Minimal types for what the tests use from Node and Vite (the project doesn't pull in @types/node,
// whose globals clash with the Workers types).

declare module "node:sqlite" {
  export class StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
