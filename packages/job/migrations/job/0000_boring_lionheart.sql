CREATE TABLE `job_execution` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_name` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`result` text,
	`exit_code` integer,
	`error` text,
	`log_path` text
);
--> statement-breakpoint
CREATE INDEX `job_execution_job_name` ON `job_execution` (`job_name`,`id`);