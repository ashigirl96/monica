-- Create "monica_schema" table
CREATE TABLE `monica_schema` (
  `version` integer NULL,
  `applied_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`version`)
);
-- Create "mon_counter" table
CREATE TABLE `mon_counter` (
  `n` integer NULL PRIMARY KEY AUTOINCREMENT
);
-- Create "task_run_counter" table
CREATE TABLE `task_run_counter` (
  `n` integer NULL PRIMARY KEY AUTOINCREMENT
);
-- Create "tasks" table
CREATE TABLE `tasks` (
  `id` text NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `phase` text NULL,
  `title` text NOT NULL,
  `body` text NOT NULL DEFAULT '',
  `project_id` text NULL,
  `labels` text NOT NULL DEFAULT '[]',
  `details_json` text NOT NULL DEFAULT '{}',
  `source_json` text NULL,
  `deleted_at` text NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`id`)
);
-- Create "task_runs" table
CREATE TABLE `task_runs` (
  `id` text NULL,
  `task_id` text NOT NULL,
  `agent` text NULL,
  `branch` text NULL,
  `worktree_path` text NULL,
  `status` text NOT NULL,
  `wait_reason` text NULL,
  `settings_path` text NULL,
  `provider_session_id` text NULL,
  `last_event_name` text NULL,
  `last_event_at` text NULL,
  `metadata_json` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`id`),
  CONSTRAINT `0` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "events" table
CREATE TABLE `events` (
  `id` integer NULL PRIMARY KEY AUTOINCREMENT,
  `task_id` text NULL,
  `task_run_id` text NULL,
  `kind` text NOT NULL,
  `payload_json` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT `0` FOREIGN KEY (`task_run_id`) REFERENCES `task_runs` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT `1` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "external_refs" table
CREATE TABLE `external_refs` (
  `id` integer NULL PRIMARY KEY AUTOINCREMENT,
  `task_id` text NOT NULL,
  `ref_type` text NOT NULL,
  `repo` text NULL,
  `number` integer NULL,
  `url` text NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT `0` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "external_refs_github_pr_unique" to table: "external_refs"
CREATE UNIQUE INDEX `external_refs_github_pr_unique` ON `external_refs` (`task_id`, `ref_type`, `repo`, `number`) WHERE ref_type = 'github_pull_request'
   AND repo IS NOT NULL
   AND number IS NOT NULL;
-- Create "projects" table
CREATE TABLE `projects` (
  `id` text NULL,
  `name` text NOT NULL,
  `provider` text NOT NULL DEFAULT 'github',
  `repo` text NOT NULL,
  `path` text NULL,
  `default_branch` text NOT NULL DEFAULT 'main',
  `worktree_root` text NULL,
  `setup_timeout_sec` integer NOT NULL DEFAULT 600,
  `agent_default` text NOT NULL DEFAULT 'claude',
  `agent_permission_mode` text NOT NULL DEFAULT 'plan',
  `hooks_claude` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`id`)
);
-- Create "external_ref_syncs" table
CREATE TABLE `external_ref_syncs` (
  `task_id` text NOT NULL,
  `source_ref_id` integer NOT NULL,
  `target_ref_type` text NOT NULL,
  `last_synced_at` text NULL,
  `last_error` text NULL,
  `next_retry_at` text NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`task_id`, `source_ref_id`, `target_ref_type`),
  CONSTRAINT `0` FOREIGN KEY (`source_ref_id`) REFERENCES `external_refs` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT `1` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "github_pull_request_ref_states" table
CREATE TABLE `github_pull_request_ref_states` (
  `external_ref_id` integer NULL,
  `status` text NULL,
  `synced_at` text NULL,
  `last_error` text NULL,
  `next_retry_at` text NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`external_ref_id`),
  CONSTRAINT `0` FOREIGN KEY (`external_ref_id`) REFERENCES `external_refs` (`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  CHECK (status IN ('draft', 'open', 'closed', 'merged'))
);
-- Create index "github_pr_ref_states_refresh_idx" to table: "github_pull_request_ref_states"
CREATE INDEX `github_pr_ref_states_refresh_idx` ON `github_pull_request_ref_states` (`status`, `synced_at`, `next_retry_at`);
-- Create "github_pull_request_branch_syncs" table
CREATE TABLE `github_pull_request_branch_syncs` (
  `task_id` text NOT NULL,
  `repo` text NOT NULL,
  `branch` text NOT NULL,
  `last_synced_at` text NULL,
  `last_error` text NULL,
  `next_retry_at` text NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`task_id`, `repo`, `branch`),
  CONSTRAINT `0` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "github_pr_branch_syncs_retry_idx" to table: "github_pull_request_branch_syncs"
CREATE INDEX `github_pr_branch_syncs_retry_idx` ON `github_pull_request_branch_syncs` (`next_retry_at`);
-- Create "terminal_runspaces" table
CREATE TABLE `terminal_runspaces` (
  `id` text NULL,
  `sort_order` integer NOT NULL DEFAULT 0,
  `is_active` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`id`)
);
-- Create "terminal_tabs" table
CREATE TABLE `terminal_tabs` (
  `id` text NULL,
  `runspace_id` text NOT NULL,
  `cwd` text NOT NULL,
  `title` text NOT NULL DEFAULT '',
  `sort_order` integer NOT NULL DEFAULT 0,
  `is_active` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (`id`),
  CONSTRAINT `0` FOREIGN KEY (`runspace_id`) REFERENCES `terminal_runspaces` (`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "terminal_tabs_runspace_idx" to table: "terminal_tabs"
CREATE INDEX `terminal_tabs_runspace_idx` ON `terminal_tabs` (`runspace_id`, `sort_order`);
