declare module "bun:sqlite" {
  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
  }
  export class Database {
    constructor(path: string, options?: DatabaseOptions);
    query(sql: string): Statement;
    close(): void;
  }
  export class Statement {
    all(...params: unknown[]): Record<string, unknown>[];
  }
}

declare const process: {
  env: Record<string, string | undefined>;
};
