ALTER TABLE `note` ADD `starred` integer DEFAULT false NOT NULL CONSTRAINT "note_starred" CHECK(starred = 0 OR kind IN ('essay', 'repo_note'));
