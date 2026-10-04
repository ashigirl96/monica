CREATE TABLE `bench` (
	`task_issue_id` integer PRIMARY KEY NOT NULL,
	`runspace_id` text NOT NULL,
	`cwd` text NOT NULL,
	`mode` text NOT NULL,
	`branch` text,
	`setup_state` text NOT NULL,
	`setup_error` text,
	`created_at` integer NOT NULL,
	`prepared_at` integer,
	FOREIGN KEY (`task_issue_id`) REFERENCES `task`(`issue_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runspace_id`) REFERENCES `runspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bench_runspace_id_unique` ON `bench` (`runspace_id`);