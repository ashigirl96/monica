ALTER TABLE `study_message` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `study_message` ADD `permission_state` text CONSTRAINT "study_message_permission_state" CHECK(permission_state IS NULL OR permission_state IN ('pending', 'allowed', 'denied')) CONSTRAINT "study_message_permission" CHECK((kind = 'permission') = (permission_state IS NOT NULL));
