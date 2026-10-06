CREATE TABLE `note` (
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
	CONSTRAINT "note_kind" CHECK(kind IN ('daily', 'essay', 'repo_note', 'scratch')),
	CONSTRAINT "note_title" CHECK((kind IN ('essay', 'repo_note')) = (title IS NOT NULL)),
	CONSTRAINT "note_status" CHECK((kind = 'essay') = (status IS NOT NULL) AND (status IS NULL OR status IN ('writing', 'finished'))),
	CONSTRAINT "note_repo" CHECK((kind IN ('repo_note', 'scratch')) = (repo IS NOT NULL)),
	CONSTRAINT "note_deleted_at" CHECK(deleted_at IS NULL OR kind IN ('essay', 'repo_note'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_daily_per_date_idx` ON `note` (`date`) WHERE kind = 'daily';--> statement-breakpoint
CREATE UNIQUE INDEX `note_scratch_per_repo_idx` ON `note` (lower(repo)) WHERE kind = 'scratch';