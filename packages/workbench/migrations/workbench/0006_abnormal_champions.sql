CREATE TABLE `remote_device` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`source_address` text NOT NULL,
	`revoked_at` integer
);
