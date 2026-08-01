CREATE TABLE `api_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`stale_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_cache_expires_idx` ON `api_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `api_cache_provider_idx` ON `api_cache` (`provider`);--> statement-breakpoint
CREATE TABLE `artist_tags` (
	`artist_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`weight` real NOT NULL,
	`source` text NOT NULL,
	`license_class` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`artist_id`, `tag_id`, `source`),
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artist_tags_tag_idx` ON `artist_tags` (`tag_id`,`weight`);--> statement-breakpoint
CREATE INDEX `artist_tags_license_idx` ON `artist_tags` (`license_class`);--> statement-breakpoint
CREATE TABLE `artists` (
	`id` text PRIMARY KEY NOT NULL,
	`mbid` text NOT NULL,
	`name` text NOT NULL,
	`sort_name` text,
	`disambiguation` text,
	`country` text,
	`begin_year` integer,
	`end_year` integer,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artists_mbid_idx` ON `artists` (`mbid`);--> statement-breakpoint
CREATE INDEX `artists_name_idx` ON `artists` (`name`);--> statement-breakpoint
CREATE TABLE `external_ids` (
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text,
	`match_confidence` text NOT NULL,
	`source` text NOT NULL,
	`license_class` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`entity_type`, `entity_id`, `provider`)
);
--> statement-breakpoint
CREATE INDEX `external_ids_lookup_idx` ON `external_ids` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `external_ids_license_idx` ON `external_ids` (`license_class`);--> statement-breakpoint
CREATE TABLE `playlist_tracks` (
	`playlist_id` text NOT NULL,
	`position` integer NOT NULL,
	`recording_id` text,
	`title` text NOT NULL,
	`artist_names` text NOT NULL,
	`album` text,
	`isrc` text,
	`duration_ms` integer,
	`year` integer,
	`reason` text,
	PRIMARY KEY(`playlist_id`, `position`),
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`warnings_json` text,
	`progress_done` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`progress_label` text,
	`soundiiz_url` text,
	`soundiiz_expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlists_session_idx` ON `playlists` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `playlists_status_idx` ON `playlists` (`status`);--> statement-breakpoint
CREATE TABLE `popularity` (
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`score_raw` real NOT NULL,
	`score_norm` real NOT NULL,
	`source` text NOT NULL,
	`license_class` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`entity_type`, `entity_id`, `source`)
);
--> statement-breakpoint
CREATE INDEX `popularity_license_idx` ON `popularity` (`license_class`);--> statement-breakpoint
CREATE TABLE `recording_artists` (
	`recording_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`recording_id`, `artist_id`),
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recording_artists_artist_idx` ON `recording_artists` (`artist_id`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`mbid` text,
	`title` text NOT NULL,
	`title_norm` text NOT NULL,
	`length_ms` integer,
	`isrc` text,
	`release_group_id` text,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`release_group_id`) REFERENCES `release_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_mbid_idx` ON `recordings` (`mbid`);--> statement-breakpoint
CREATE INDEX `recordings_title_norm_idx` ON `recordings` (`title_norm`);--> statement-breakpoint
CREATE INDEX `recordings_isrc_idx` ON `recordings` (`isrc`);--> statement-breakpoint
CREATE INDEX `recordings_release_group_idx` ON `recordings` (`release_group_id`);--> statement-breakpoint
CREATE TABLE `release_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`mbid` text NOT NULL,
	`artist_id` text NOT NULL,
	`title` text NOT NULL,
	`primary_type` text,
	`secondary_types` text,
	`first_release_year` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_groups_mbid_idx` ON `release_groups` (`mbid`);--> statement-breakpoint
CREATE INDEX `release_groups_artist_idx` ON `release_groups` (`artist_id`);--> statement-breakpoint
CREATE TABLE `schema_version` (
	`id` integer PRIMARY KEY NOT NULL,
	`applied_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_id` text
);
--> statement-breakpoint
CREATE TABLE `similar_artists` (
	`artist_id` text NOT NULL,
	`similar_mbid` text,
	`similar_name` text NOT NULL,
	`score` real NOT NULL,
	`algorithm` text,
	`source` text NOT NULL,
	`license_class` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`artist_id`, `similar_name`, `source`),
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `similar_artists_score_idx` ON `similar_artists` (`artist_id`,`score`);--> statement-breakpoint
CREATE INDEX `similar_artists_license_idx` ON `similar_artists` (`license_class`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`canonical_tag_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_idx` ON `tags` (`name`);