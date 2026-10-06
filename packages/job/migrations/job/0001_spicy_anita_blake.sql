CREATE TABLE `job` (
	`name` text PRIMARY KEY NOT NULL,
	`schedule` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`added_at` integer NOT NULL
);
