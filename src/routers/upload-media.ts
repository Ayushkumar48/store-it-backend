import { Hono } from "hono";
import {
  bucketName,
  generateCloudFrontUrl,
  generatePresignedUrl,
  getNamespace,
  getSessionId,
  getUserDataFromSessionId,
  uploadToOCI,
  convertToCloudFrontUrl,
  createCloudFrontDistributionConfig,
} from "../utils/helpers";
import { randomUUIDv7 } from "bun";
import { Media, medias } from "../../db/schema";
import { db } from "../../db";
import { desc, eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { blobStorage } from "../../db";

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
      // Verify bucket exists before proceeding
      const namespace = await getNamespace();
      console.log(`Using bucket: ${bucketName} in namespace: ${namespace}`);

      const formData = await c.req.formData();
      const files = formData.getAll("media") as File[];

      for (const file of files) {
        if (file.size === 0) {
          return c.json({ error: `File ${file.name} is empty` }, 400);
        }
      }

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
          return c.json(
            {
              error: `Failed to upload ${file.name}`,
              details: String(error),
            },
            500,
          );
        }
      }

      // CloudFront URLs are already generated in uploadToOCI
      // This is just for backward compatibility or additional verification
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

            // If cloudfrontUrl is already set and valid, use it
            if (
              media.cloudfrontUrl &&
              media.cloudfrontUrl.includes(process.env.CLOUDFRONT_DOMAIN || "")
            ) {
              return media;
            }

            // Otherwise generate a new CloudFront URL
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

    const userMedia = await db
      .select()
      .from(medias)
      .where(eq(medias.userId, userData.id))
      .orderBy(desc(medias.createdAt));

    console.log(
      `Found ${userMedia.length} media items for user ${userData.id}`,
    );

    // Generate CloudFront URLs for existing media
    const mediaWithCloudFrontUrls = await Promise.all(
      userMedia.map(async (media) => {
        try {
          // If the media already has a valid cloudfrontUrl, use it
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

          // Otherwise extract object name and generate new CloudFront URL
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
          console.log(
            `Generating CloudFront URL for object: ${decodedObjectName}`,
          );
          const cloudfrontUrl = await generateCloudFrontUrl(decodedObjectName);

          // Update the media record with the CloudFront URL if needed
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

    return c.json({ media: mediaWithCloudFrontUrls });
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

media.get("/list-with-fallback", async (c) => {
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
      .orderBy(desc(medias.createdAt));

    console.log(
      `Generating both CloudFront and PAR URLs for ${userMedia.length} items`,
    );

    const mediaWithBothUrls = await Promise.all(
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
              cloudfrontUrl: null,
              presignedUrl: null,
              originalUrl: media.cloudUrl,
              error: "Invalid cloud URL (missing object name)",
            };
          }

          const decodedObjectName = decodeURIComponent(objectName);
          console.log(`Processing object: ${decodedObjectName}`);

          try {
            // Generate both URLs with better error handling
            const [cloudfrontUrl, presignedUrl] = await Promise.all([
              generateCloudFrontUrl(decodedObjectName).catch((err) => {
                console.error(`CloudFront URL generation failed: ${err}`);
                return null;
              }),
              generatePresignedUrl(decodedObjectName).catch((err) => {
                console.error(`PAR URL generation failed: ${err}`);
                return null;
              }),
            ]);

            // If both URL generations failed, throw an error
            if (!cloudfrontUrl && !presignedUrl) {
              throw new Error("Failed to generate any valid URLs");
            }

            // Update the database record if we have a new CloudFront URL
            if (
              cloudfrontUrl &&
              (!media.cloudfrontUrl ||
                !media.cloudfrontUrl.includes(
                  process.env.CLOUDFRONT_DOMAIN || "",
                ))
            ) {
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
              presignedUrl,
              expiresAt: presignedUrl
                ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
                : null,
              preferredUrl: cloudfrontUrl || presignedUrl, // Prefer CloudFront if available
              originalUrl: media.cloudUrl,
            };
          } catch (urlError) {
            console.error(urlError);
            throw new Error(`URL generation error`);
          }
        } catch (error) {
          console.error(
            `Failed to generate URLs for media ${media.id}:`,
            error,
          );
          return {
            id: media.id,
            mediaType: media.mediaType,
            userId: media.userId,
            createdAt: media.createdAt,
            cloudfrontUrl: null,
            presignedUrl: null,
            originalUrl: media.cloudUrl,
            error: `Failed to generate URLs: ${String(error)}`,
          };
        }
      }),
    );

    return c.json({
      media: mediaWithBothUrls,
      bucketInfo: {
        name: bucketName,
        region: process.env.OCI_REGION,
      },
    });
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

// Diagnostic endpoints
media.get("/diagnostic/config", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const userData = await getUserDataFromSessionId(sessionId);
    if (!userData) {
      return c.json({ error: "User not found" }, 401);
    }

    const namespace = await getNamespace();

    // Get bucket info
    let bucketInfo;
    try {
      bucketInfo = await blobStorage.getBucket({
        namespaceName: namespace,
        bucketName,
      });
    } catch (error) {
      bucketInfo = { error: String(error) };
    }

    return c.json({
      environment: {
        bucketName,
        region: process.env.OCI_REGION,
        cloudfrontDomain: process.env.CLOUDFRONT_DOMAIN,
        namespace,
      },
      bucket: bucketInfo,
      user: {
        id: userData.id,
      },
    });
  } catch (error) {
    return c.json(
      {
        error: "Failed to get diagnostic info",
        details: String(error),
      },
      500,
    );
  }
});

media.get("/diagnostic/create-par", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const userData = await getUserDataFromSessionId(sessionId);
    if (!userData) {
      return c.json({ error: "User not found" }, 401);
    }

    // Create CloudFront configuration
    const cloudfrontConfig = await createCloudFrontDistributionConfig();

    return c.json({
      message: "CloudFront configuration generated successfully",
      config: cloudfrontConfig,
      instructions: {
        step1: "In AWS CloudFront console, create a new distribution",
        step2: `Set Origin Domain to: ${cloudfrontConfig.originDomain}`,
        step3: `Set Origin Path to: ${cloudfrontConfig.originPath}`,
        step4: "Set Origin Protocol Policy to: HTTPS Only",
        step5: "After creation, update CLOUDFRONT_DOMAIN in .env file",
      },
    });
  } catch (error) {
    return c.json(
      {
        error: "Failed to create CloudFront PAR",
        details: String(error),
      },
      500,
    );
  }
});

media.get("/diagnostic/test-url", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const objectName = c.req.query("object");
  if (!objectName) {
    return c.json({ error: "Missing 'object' query parameter" }, 400);
  }

  try {
    const userData = await getUserDataFromSessionId(sessionId);
    if (!userData) {
      return c.json({ error: "User not found" }, 401);
    }

    const namespace = await getNamespace();

    const ociUrl = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com/n/${namespace}/b/${bucketName}/o/${encodeURIComponent(objectName)}`;

    const cloudfrontUrl = await generateCloudFrontUrl(objectName).catch(
      (err) => ({ error: err.message || String(err) }),
    );

    const parUrl = await generatePresignedUrl(objectName).catch((err) => ({
      error: err.message || String(err),
    }));

    return c.json({
      input: {
        objectName,
        bucketName,
        region: process.env.OCI_REGION,
        namespace,
      },
      urls: {
        ociDirectUrl: ociUrl,
        cloudfrontUrl,
        parUrl,
      },
      instructions: {
        testCloudfront: `curl -I '${typeof cloudfrontUrl === "string" ? cloudfrontUrl : "URL_GENERATION_FAILED"}'`,
        testPar: `curl -I '${typeof parUrl === "string" ? parUrl : "URL_GENERATION_FAILED"}'`,
      },
    });
  } catch (error) {
    return c.json(
      {
        error: "Failed to generate test URLs",
        details: String(error),
      },
      500,
    );
  }
});

export default media;
