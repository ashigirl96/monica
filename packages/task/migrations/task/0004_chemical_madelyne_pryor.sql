CREATE TABLE `pull_request` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`head_ref` text NOT NULL,
	`head_oid` text NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_request_repo_number` ON `pull_request` (`repo`,`number`);--> statement-breakpoint
CREATE TABLE `task_pull_request` (
	`task_issue_id` integer NOT NULL,
	`pull_request_id` integer NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`task_issue_id`, `pull_request_id`, `source`),
	FOREIGN KEY (`task_issue_id`) REFERENCES `task`(`issue_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_request`(`id`) ON UPDATE no action ON DELETE no action
);
