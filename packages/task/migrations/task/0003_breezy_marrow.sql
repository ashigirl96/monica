CREATE TABLE `run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_issue_id` integer NOT NULL,
	`agent_session_id` text NOT NULL,
	`origin` text NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`task_issue_id`) REFERENCES `task`(`issue_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_session`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_agent_session_id_unique` ON `run` (`agent_session_id`);--> statement-breakpoint
CREATE INDEX `run_task` ON `run` (`task_issue_id`);