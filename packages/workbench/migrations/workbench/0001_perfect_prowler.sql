CREATE TABLE `runspace` (
	`id` text PRIMARY KEY NOT NULL,
	`cwd` text NOT NULL,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tab` (
	`id` text PRIMARY KEY NOT NULL,
	`runspace_id` text NOT NULL,
	`cwd` text NOT NULL,
	`sort_order` integer NOT NULL,
	`terminal_session_id` text NOT NULL,
	FOREIGN KEY (`runspace_id`) REFERENCES `runspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tab_terminal_session_id_unique` ON `tab` (`terminal_session_id`);--> statement-breakpoint
CREATE INDEX `tab_runspace_idx` ON `tab` (`runspace_id`);