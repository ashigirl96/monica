CREATE TABLE `study_repo` (
	`study_id` text NOT NULL,
	`repo` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`study_id`) REFERENCES `study`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_repo_per_study_idx` ON `study_repo` (`study_id`,lower(repo));--> statement-breakpoint
CREATE INDEX `study_repo_repo_idx` ON `study_repo` (lower(repo));