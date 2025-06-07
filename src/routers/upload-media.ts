import { Hono } from "hono";
import {
  bucketName,
  convertVideoToWebM,
  generateCloudFrontUrl,
  getNamespace,
  getSessionId,
  getUserDataFromSessionId,
  uploadToOCI,
} from "../utils/helpers";
import { randomUUIDv7 } from "bun";
import { Media, medias } from "../../db/schema";
import { db } from "../../db";
import { desc, eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";

const media = new Hono();

media.post(
  "/",
  bodyLimit({
    maxSize: 100 * 1024 * 1024,
    onError: (c) => {
      return c.text("overflow :(", 413);
    },
  }),
  async (c) => {
    const sessionId = getSessionId(c);
    if (!sessionId) {
      console.error("Session expired, please login again!");
      return c.json({ error: "Session expired, please login again!" }, 400);
    }

    try {
      const namespace = await getNamespace();

      const formData = await c.req.formData();
      const files = formData.getAll("media") as File[];

      for (const file of files) {
        if (file.size === 0) {
          return c.json({ error: `File ${file.name} is empty` }, 400);
        }
      }

      const uploadedFiles: Media[] = [];

      for (const file of files) {
        const objectName = `${Date.now()}-${randomUUIDv7()}-${file.name || "abc"}`;
        try {
          const arrayBuffer = await file.arrayBuffer();
          let fileBuffer = Buffer.from(arrayBuffer);
          let contentType = file.type;

          if (file.type.startsWith("video/")) {
            fileBuffer = (await convertVideoToWebM(
              fileBuffer,
            )) as Buffer<ArrayBuffer>;
            contentType = "video/webm";
          }

          const mediaDbData = await uploadToOCI(
            fileBuffer,
            bucketName,
            objectName,
            namespace,
            sessionId,
            contentType,
            file.name,
          );
          uploadedFiles.push(mediaDbData);
        } catch (error) {
          console.error(`Failed to upload ${file.name}:`, error);
          return c.json(
            {
              error: `Failed to upload ${file.name}`,
              details: String(error),
            },
            500,
          );
        }
      }

      const mediaWithCloudFrontUrls = await Promise.all(
        uploadedFiles.map(async (media) => {
          try {
            const objectName = media.cloudUrl.split("/o/")[1];
            if (!objectName) {
              console.error(`Invalid cloud URL format: ${media.cloudUrl}`);
              return {
                ...media,
                cloudfrontUrl: null,
                error: "Invalid cloud URL (missing object name)",
              };
            }

            const decodedObjectName = decodeURIComponent(objectName);

            if (
              media.cloudfrontUrl &&
              media.cloudfrontUrl.includes(process.env.CLOUDFRONT_DOMAIN || "")
            ) {
              return media;
            }

            const cloudfrontUrl =
              await generateCloudFrontUrl(decodedObjectName);

            return {
              ...media,
              cloudfrontUrl,
            };
          } catch (error) {
            console.error(
              `Failed to generate CloudFront URL for ${media.id}:`,
              error,
            );
            return {
              ...media,
              cloudfrontUrl: null,
              error: `Failed to generate CloudFront URL: ${String(error)}`,
            };
          }
        }),
      );

      return c.json({
        message: "Uploaded to OCI",
        media: mediaWithCloudFrontUrls,
      });
    } catch (error) {
      console.error("Error during media upload:", error);
      return c.json(
        {
          error: "Failed to process upload request",
          details: String(error),
        },
        500,
      );
    }
  },
);

media.get("/list", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    console.error("Session expired, please login again!");
    return c.json({ error: "Session expired, please login again!" }, 400);
  }

  try {
    const userData = await getUserDataFromSessionId(sessionId);
    if (!userData) {
      return c.json({ error: "Failed to fetch media" }, 401);
    }

    // Parse pagination params
    const page = parseInt(c.req.query("page") || "1", 10);
    const limit = parseInt(c.req.query("limit") || "30", 10);
    const offset = (page - 1) * limit;

    // Fetch one extra to check if there's more
    const userMedia = await db
      .select()
      .from(medias)
      .where(eq(medias.userId, userData.id))
      .orderBy(desc(medias.createdAt))
      .limit(limit + 1)
      .offset(offset);

    // Determine if there are more records
    const hasMore = userMedia.length > limit;
    const paginatedMedia = hasMore ? userMedia.slice(0, limit) : userMedia;

    const mediaWithCloudFrontUrls = await Promise.all(
      paginatedMedia.map(async (media) => {
        try {
          if (
            media.cloudfrontUrl &&
            media.cloudfrontUrl.includes(process.env.CLOUDFRONT_DOMAIN || "")
          ) {
            return {
              id: media.id,
              mediaType: media.mediaType,
              userId: media.userId,
              createdAt: media.createdAt,
              cloudfrontUrl: media.cloudfrontUrl,
            };
          }

          const objectName = media.cloudUrl.split("/o/")[1];

          if (!objectName) {
            console.error("Missing object name in cloudUrl:", media.cloudUrl);
            return {
              id: media.id,
              mediaType: media.mediaType,
              userId: media.userId,
              createdAt: media.createdAt,
              cloudfrontUrl: null,
              originalUrl: media.cloudUrl,
              error: "Invalid cloud URL (missing object name)",
            };
          }

          const decodedObjectName = decodeURIComponent(objectName);

          const cloudfrontUrl = await generateCloudFrontUrl(decodedObjectName);

          if (!media.cloudfrontUrl) {
            try {
              await db
                .update(medias)
                .set({ cloudfrontUrl })
                .where(eq(medias.id, media.id));
            } catch (updateError) {
              console.error(
                `Failed to update CloudFront URL in database: ${updateError}`,
              );
            }
          }

          return {
            id: media.id,
            mediaType: media.mediaType,
            userId: media.userId,
            createdAt: media.createdAt,
            cloudfrontUrl,
            originalUrl: media.cloudUrl,
          };
        } catch (error) {
          console.error(
            `Failed to generate CloudFront URL for media ${media.id}:`,
            error,
          );
          return {
            id: media.id,
            mediaType: media.mediaType,
            userId: media.userId,
            createdAt: media.createdAt,
            cloudfrontUrl: null,
            originalUrl: media.cloudUrl,
            error: `Failed to generate CloudFront URL: ${String(error)}`,
          };
        }
      }),
    );

    return c.json({ media: mediaWithCloudFrontUrls, hasMore });
  } catch (error) {
    console.error("Error fetching user media:", error);
    return c.json(
      {
        error: "Failed to fetch media",
        details: String(error),
      },
      500,
    );
  }
});

export default media;
