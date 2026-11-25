ALTER TABLE `bench` ADD `setup_state` text NOT NULL DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE `bench` ADD `setup_error` text;--> statement-breakpoint
ALTER TABLE `bench` ADD `prepared_at` integer;--> statement-breakpoint
UPDATE `bench` SET `prepared_at` = `created_at`;
