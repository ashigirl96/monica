CREATE TABLE `terminal_session` (
	`id` text PRIMARY KEY NOT NULL,
	`cwd` text NOT NULL,
	`shell` text NOT NULL,
	`status` text NOT NULL,
	`pid` integer,
	`exit_code` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
