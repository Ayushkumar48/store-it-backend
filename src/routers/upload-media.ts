import { Hono } from "hono";
import {
  bucketName,
  generatePresignedUrl,
  getNamespace,
  getSessionId,
  getUserDataFromSessionId,
  uploadToOCI,
} from "../utils/helpers";
import { randomUUIDv7 } from "bun";
import { Media, medias } from "../../db/schema";
import { db } from "../../db";
import { eq } from "drizzle-orm";

const media = new Hono();

media.post("/", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    console.error("Session expired, please login again!");
    return c.json({ error: "Session expired, please login again!" }, 400);
  }
  const formData = await c.req.formData();
  const files = formData.getAll("media") as File[];

  // Validate files before upload
  for (const file of files) {
    if (file.size === 0) {
      return c.json({ error: `File ${file.name} is empty` }, 400);
    }
    console.log(
      `Processing file: ${file.name}, size: ${file.size}, type: ${file.type}`,
    );
  }

  const namespace = await getNamespace();
  const uploadedFiles: Media[] = [];

  for (const file of files) {
    const objectName = `${Date.now()}-${randomUUIDv7()}-${file.name}`;
    try {
      const mediaDbData = await uploadToOCI(
        file,
        bucketName,
        objectName,
        namespace,
        sessionId,
      );
      uploadedFiles.push(mediaDbData);
    } catch (error) {
      console.error(`Failed to upload ${file.name}:`, error);
      return c.json({ error: `Failed to upload ${file.name}` }, 500);
    }
  }

  return c.json({ message: "Uploaded to OCI", urls: uploadedFiles });
});

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

    const userMedia = await db
      .select()
      .from(medias)
      .where(eq(medias.userId, userData.id))
      .orderBy(medias.createdAt);

    const mediaWithPresignedUrls = await Promise.all(
      userMedia.map(async (media) => {
        try {
          const objectName = media.cloudUrl.split("/o/")[1];

          if (!objectName) {
            console.error("Missing object name in cloudUrl:", media.cloudUrl);
            return {
              id: media.id,
              mediaType: media.mediaType,
              userId: media.userId,
              createdAt: media.createdAt,
              presignedUrl: null,
              error: "Invalid cloud URL (missing object name)",
            };
          }

          const decodedObjectName = decodeURIComponent(objectName);
          const presignedUrl = await generatePresignedUrl(
            decodedObjectName,
            60,
          );

          return {
            id: media.id,
            mediaType: media.mediaType,
            userId: media.userId,
            createdAt: media.createdAt,
            presignedUrl,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          };
        } catch (error) {
          console.error(
            `Failed to generate pre-signed URL for media ${media.id}:`,
            error,
          );
          return {
            id: media.id,
            mediaType: media.mediaType,
            userId: media.userId,
            createdAt: media.createdAt,
            presignedUrl: null,
            error: "Failed to generate URL",
          };
        }
      }),
    );

    return c.json({ media: mediaWithPresignedUrls });
  } catch (error) {
    console.error("Error fetching user media:", error);
    return c.json({ error: "Failed to fetch media" }, 500);
  }
});

export default media;
