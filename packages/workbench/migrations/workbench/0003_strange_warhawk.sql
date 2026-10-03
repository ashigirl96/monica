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
	FOREIGN KEY (`terminal_session_id`) REFERENCES `terminal_session`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_session_wait_reason" CHECK((state = 'waiting') = (wait_reason IS NOT NULL)),
	CONSTRAINT "agent_session_wait_tool" CHECK(wait_tool IS NULL OR wait_reason = 'permission'),
	CONSTRAINT "agent_session_error_type" CHECK(error_type IS NULL OR wait_reason = 'error'),
	CONSTRAINT "agent_session_end_reason" CHECK((state = 'ended') = (end_reason IS NOT NULL)),
	CONSTRAINT "agent_session_ended_at" CHECK((state = 'ended') = (ended_at IS NOT NULL)),
	CONSTRAINT "agent_session_session_end_reason" CHECK(session_end_reason IS NULL OR end_reason = 'session_end'),
	CONSTRAINT "agent_session_unobserved_since" CHECK((state = 'unobserved') = (unobserved_since IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_live_per_terminal_session_idx` ON `agent_session` (`terminal_session_id`) WHERE state <> 'ended';