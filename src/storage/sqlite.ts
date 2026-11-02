/** Only this adapter owns this connection. No connection or arbitrary SQL escapes its closure. */
export type SQLiteValue = string | number | null | Uint8Array;
export interface SQLiteConnection {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SQLiteValue[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, ...params: SQLiteValue[]): Promise<T[]>;
  isInTransactionAsync(): Promise<boolean>;
  closeAsync(): Promise<void>;
}
/** Structural subset checked against Expo SQLite 57.0.2, not an alternative persistence implementation. */
export interface SQLiteModule {
  openDatabaseAsync(name: string, options: { useNewConnection: true; enableChangeListener: false }): Promise<SQLiteConnection>;
}
