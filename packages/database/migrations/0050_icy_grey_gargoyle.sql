CREATE TABLE `video_views` (
	`id` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`sessionId` varchar(128) NOT NULL,
	`viewerUserId` varchar(15),
	`viewerName` varchar(64),
	`country` varchar(8) NOT NULL DEFAULT '',
	`region` varchar(64) NOT NULL DEFAULT '',
	`city` varchar(128) NOT NULL DEFAULT '',
	`browser` varchar(64) NOT NULL DEFAULT '',
	`os` varchar(64) NOT NULL DEFAULT '',
	`device` varchar(32) NOT NULL DEFAULT '',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `video_views_id` PRIMARY KEY(`id`),
	CONSTRAINT `video_session_idx` UNIQUE(`videoId`,`sessionId`)
);
--> statement-breakpoint
ALTER TABLE `comments` ADD `guestName` varchar(64);--> statement-breakpoint
ALTER TABLE `comments` ADD `guestIpHash` varchar(64);--> statement-breakpoint
CREATE INDEX `org_created_idx` ON `video_views` (`orgId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `video_created_idx` ON `video_views` (`videoId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `video_guest_created_idx` ON `comments` (`videoId`,`guestIpHash`,`createdAt`);