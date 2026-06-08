env "local" {
  src = "file://crates/monica-infra/src/sqlite/schema.sql"
  dev = "sqlite://dev?mode=memory&_fk=1"

  migration {
    dir = "file://crates/monica-infra/src/sqlite/migrations"
  }
}
