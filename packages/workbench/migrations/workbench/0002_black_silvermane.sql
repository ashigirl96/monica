ALTER TABLE `tab` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tab_pinned_per_runspace_idx` ON `tab` (`runspace_id`) WHERE pinned = 1;