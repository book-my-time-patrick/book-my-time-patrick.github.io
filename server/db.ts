export interface SqlResult<T = Record<string, unknown>> { results: T[]; meta?: { changes?: number }; success?: boolean }
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
}
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
  exec(query: string): Promise<unknown>;
}
export interface Environment {
  FRONTEND_ORIGIN?: string;
  SITE_ORIGIN?: string;
  DB?: SqlDatabase;
  DATA_ENCRYPTION_KEY?: string;
  SETUP_TOKEN_HASH?: string;
  SETUP_EXPIRES_AT?: string;
}
