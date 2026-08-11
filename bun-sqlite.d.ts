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
  pid: number;
};

declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function watch(
    path: string,
    listener: (eventType: string, filename: string | null) => void,
  ): { close(): void };
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
