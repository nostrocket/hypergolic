#include "sqlite3.h"
#include "CacheInterop.h"

// The app's Expo SQLite symbols are prefixed. Link this driver alongside Apple's SQLite.
static int transfer(const char *cache, const char *body_file, const char *statements) {
  sqlite3 *db = NULL;
  int result = exsqlite3_open(cache, &db);
  if (result == SQLITE_OK) {
    char *sql = exsqlite3_mprintf("PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"
                                  "ATTACH DATABASE %Q AS body_store; BEGIN IMMEDIATE; %s; COMMIT; DETACH DATABASE body_store;",
                                  body_file, statements);
    result = sql ? exsqlite3_exec(db, sql, NULL, NULL, NULL) : SQLITE_NOMEM;
    exsqlite3_free(sql);
  }
  exsqlite3_close(db);
  return result;
}

int hg_proof_copy_cached_body(const char *cache, const char *source, const char *destination) {
  int result = transfer(cache, source,
    "CREATE TABLE verified_published_artifacts (row_id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL,"
    " publisher TEXT NOT NULL, identifier TEXT NOT NULL, event_id TEXT NOT NULL, signed_event TEXT NOT NULL,"
    " html BLOB NOT NULL, byte_count INTEGER NOT NULL, UNIQUE(user,publisher,identifier,event_id));"
    "PRAGMA user_version=1;"
    "INSERT INTO verified_published_artifacts(user,publisher,identifier,event_id,signed_event,html,byte_count)"
    " SELECT 'account','publisher','journal','event','{}',body,length(body)+2 FROM body_store.payload WHERE id=1");
  if (result != SQLITE_OK) return result;
  // Reopen with a fresh Expo connection, as when an older persistent v1 pin is launched offline.
  return transfer(cache, destination,
    "INSERT INTO body_store.payload(id,body) SELECT 1,html FROM main.verified_published_artifacts"
    " WHERE row_id=1 AND user='account' AND publisher='publisher' AND identifier='journal' AND event_id='event' AND signed_event='{}'");
}
