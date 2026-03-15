CREATE TABLE IF NOT EXISTS `session_diff` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `data` text NOT NULL DEFAULT '[]',
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
