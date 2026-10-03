CREATE TABLE `issue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`parent_id` integer,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_repo_number` ON `issue` (`repo`,`number`);--> statement-breakpoint
CREATE TABLE `issue_blocker` (
	`issue_id` integer NOT NULL,
	`blocker_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `blocker_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocker_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task` (
	`issue_id` integer PRIMARY KEY NOT NULL,
	`tracked_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action
);
