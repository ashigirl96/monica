CREATE TABLE `agent_session` (
	`session_id` text PRIMARY KEY NOT NULL,
	`terminal_session_id` text NOT NULL,
	`state` text NOT NULL,
	`wait_reason` text,
	`wait_tool` text,
	`error_type` text,
	`end_reason` text,
	`session_end_reason` text,
	`cwd` text NOT NULL,
	`transcript_path` text,
	`permission_mode` text,
	`last_event_name` text NOT NULL,
	`last_event_at` integer NOT NULL,
	`state_changed_at` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`ended_at` integer,
	`unobserved_since` integer,
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_session_terminal_session_idx` ON `agent_session` (`terminal_session_id`);