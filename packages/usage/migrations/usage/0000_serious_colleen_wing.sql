CREATE TABLE `usage` (
	`feature` text NOT NULL,
	`caller` text NOT NULL,
	`date` text NOT NULL,
	`ok` integer NOT NULL,
	`failed` integer NOT NULL,
	PRIMARY KEY(`feature`, `caller`, `date`)
);
