CREATE TABLE `study` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `study_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`session_id` text,
	FOREIGN KEY (`study_id`) REFERENCES `study`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_conversation_ongoing_idx` ON `study_conversation` (`study_id`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE TABLE `study_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`tool` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `study_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "study_message_tool" CHECK((kind = 'tool') = (tool IS NOT NULL))
);
