interface SqliteTestDb {
  exec(sql: string): unknown;
}

export const configureSqliteTestDb = <T extends SqliteTestDb>(db: T): T => {
  db.exec("PRAGMA journal_mode = MEMORY;");
  db.exec("PRAGMA synchronous = OFF;");
  return db;
};

export const resetSqliteTestDb = (db: SqliteTestDb, statements: string) => {
  configureSqliteTestDb(db);
  db.exec(`
    BEGIN IMMEDIATE;
    ${statements}
    COMMIT;
  `);
};
