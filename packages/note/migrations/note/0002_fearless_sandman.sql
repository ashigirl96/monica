PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_note` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`repo` text,
	`title` text,
	`status` text,
	`date` text NOT NULL,
	`content` text NOT NULL,
	`preview` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`starred` integer DEFAULT false NOT NULL,
	CONSTRAINT "note_kind" CHECK(kind IN ('daily', 'essay', 'repo_note', 'scratch', 'pad')),
	CONSTRAINT "note_title" CHECK((kind IN ('essay', 'repo_note')) = (title IS NOT NULL)),
	CONSTRAINT "note_status" CHECK((kind = 'essay') = (status IS NOT NULL) AND (status IS NULL OR status IN ('writing', 'finished'))),
	CONSTRAINT "note_repo" CHECK((kind IN ('repo_note', 'scratch')) = (repo IS NOT NULL)),
	CONSTRAINT "note_deleted_at" CHECK(deleted_at IS NULL OR kind IN ('essay', 'repo_note')),
	CONSTRAINT "note_starred" CHECK(starred = 0 OR kind IN ('essay', 'repo_note'))
);
--> statement-breakpoint
INSERT INTO `__new_note`("id", "kind", "repo", "title", "status", "date", "content", "preview", "created_at", "updated_at", "deleted_at", "starred") SELECT "id", "kind", "repo", "title", "status", "date", "content", "preview", "created_at", "updated_at", "deleted_at", "starred" FROM `note`;--> statement-breakpoint
UPDATE sqlite_sequence SET seq = (SELECT seq FROM sqlite_sequence WHERE name = 'note') WHERE name = '__new_note';--> statement-breakpoint
DROP TABLE `note`;--> statement-breakpoint
ALTER TABLE `__new_note` RENAME TO `note`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `note_daily_per_date_idx` ON `note` (`date`) WHERE kind = 'daily';--> statement-breakpoint
CREATE UNIQUE INDEX `note_scratch_per_repo_idx` ON `note` (lower(repo)) WHERE kind = 'scratch';--> statement-breakpoint
CREATE UNIQUE INDEX `note_one_pad_idx` ON `note` (`kind`) WHERE kind = 'pad';