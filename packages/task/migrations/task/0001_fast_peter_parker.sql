ALTER TABLE `issue` ADD `node_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_node_id_unique` ON `issue` (`node_id`);