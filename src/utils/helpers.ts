import { eq } from "drizzle-orm";
import { blobStorage, db } from "../../db";
import { medias, sessions, users } from "../../db/schema";
import { models } from "oci-objectstorage";
import { BlankEnv, BlankInput } from "hono/types";
import { Context } from "hono";
import { spawn } from "bun";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUIDv7 } from "bun";

export const bucketName = "store-it-bucket";

export function isValidPassword(password: string) {
  const regex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
  return regex.test(password);
}

export function getSessionId(c: Context<BlankEnv, "/", BlankInput>) {
  const authHeader = c.req.header("Authorization");
  return authHeader?.split("Bearer ")[1];
}

export async function getNamespace(): Promise<string> {
  const response = await blobStorage.getNamespace({});
  return response.value!;
}

export function convertToCloudFrontUrl(
  ociUrl: string,
  cloudfrontDomain: string = process.env.CLOUDFRONT_DOMAIN as string,
): string {
  try {
    const urlParts = ociUrl.split("/o/");
    if (urlParts.length < 2) {
      throw new Error("Invalid OCI URL format");
    }

    const objectName = decodeURIComponent(urlParts[1]);
    return `https://${cloudfrontDomain}/${objectName}`;
  } catch (error) {
    console.error("Error converting to CloudFront URL:", error);
    return ociUrl;
  }
}

export async function createCloudFrontDistributionConfig() {
  const namespace = await getNamespace();
  const bucketParResponse = await blobStorage.createPreauthenticatedRequest({
    namespaceName: namespace,
    bucketName,
    createPreauthenticatedRequestDetails: {
      name: `cloudfront-origin-${Date.now()}`,
      accessType:
        models.CreatePreauthenticatedRequestDetails.AccessType.AnyObjectRead,
      timeExpires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });

  const originUrl = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com${bucketParResponse.preauthenticatedRequest.accessUri}`;

  return {
    originDomain: `objectstorage.${process.env.OCI_REGION}.oraclecloud.com`,
    originPath: bucketParResponse.preauthenticatedRequest.accessUri,
    fullParUrl: originUrl,
  };
}

export async function uploadToOCI(
  fileBuffer: Buffer,
  bucketName: string,
  objectName: string,
  namespace: string,
  sessionId: string,
  contentType: string,
  originalFileName?: string,
) {
  try {
    const [{ userId }] = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!userId) {
      throw new Error("User Id not found.");
    }

    const uint8Array = new Uint8Array(fileBuffer);

    await blobStorage.putObject({
      namespaceName: namespace,
      bucketName,
      objectName,
      putObjectBody: uint8Array,
      contentLength: fileBuffer.length,
      contentType: contentType || "application/octet-stream",
    });

    const ociUrl = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com/n/${namespace}/b/${bucketName}/o/${encodeURIComponent(objectName)}`;
    const cloudfrontUrl = convertToCloudFrontUrl(ociUrl);

    const [mediaDbData] = await db
      .insert(medias)
      .values({
        mediaType: contentType.startsWith("image/") ? "image" : "video",
        cloudUrl: ociUrl,
        cloudfrontUrl: cloudfrontUrl,
        userId,
      })
      .returning();

    return { ...mediaDbData, cloudfrontUrl };
  } catch (error) {
    console.error(
      `Error uploading file ${originalFileName || objectName}:`,
      error,
    );
    throw error;
  }
}

export async function generateCloudFrontUrl(
  objectName: string,
): Promise<string> {
  try {
    return `https://${process.env.CLOUDFRONT_DOMAIN as string}/${encodeURIComponent(objectName)}`;
  } catch (error) {
    console.error("Error generating CloudFront URL:", error);
    throw error;
  }
}

export async function generatePresignedUrl(
  objectName: string,
  expirationMinutes: number = 60 * 24 * 365,
): Promise<string> {
  try {
    const namespace = await getNamespace();

    const listParResponse = await blobStorage.listPreauthenticatedRequests({
      namespaceName: namespace,
      bucketName,
    });
    const existingPar = listParResponse.items.find(
      (item) =>
        item.objectName === objectName &&
        item.accessType === "ObjectRead" &&
        new Date(item.timeExpires) > new Date(),
    );

    if (existingPar) {
      const parDetails = await blobStorage.getPreauthenticatedRequest({
        namespaceName: namespace,
        bucketName,
        parId: existingPar.id,
      });

      return `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com${parDetails.preauthenticatedRequestSummary.id}`;
    }

    const parResponse = await blobStorage.createPreauthenticatedRequest({
      namespaceName: namespace,
      bucketName,
      createPreauthenticatedRequestDetails: {
        name: `read-${Date.now()}-${objectName}`,
        objectName,
        accessType:
          models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
        timeExpires: new Date(Date.now() + expirationMinutes * 60 * 1000),
      },
    });

    if (!parResponse.preauthenticatedRequest.accessUri) {
      throw new Error("Missing access URI in preauthenticated response");
    }
    return `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com${parResponse.preauthenticatedRequest.accessUri}`;
  } catch (error) {
    console.error("Error generating/reusing pre-signed URL:", error);
    throw error;
  }
}

export async function getUserDataFromSessionId(sessionId: string) {
  try {
    const [userData] = await db
      .select({ users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, sessionId));
    return userData.users;
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function convertVideoToWebM(inputBuffer: Buffer): Promise<Buffer> {
  console.log("converting to webm");
  const tempInputPath = join(tmpdir(), `${randomUUIDv7()}.mp4`);
  const tempOutputPath = join(tmpdir(), `${randomUUIDv7()}.webm`);

  await writeFile(tempInputPath, inputBuffer);

  const subprocess = spawn({
    cmd: [
      "ffmpeg",
      "-i",
      tempInputPath,
      "-c:v",
      "libvpx", // VP8 codec (fast WebM)
      "-quality",
      "good", // Good quality/speed balance
      "-cpu-used",
      "4", // Faster encoding (0-16, higher = faster)
      "-crf",
      "25", // Quality level
      "-b:v",
      "1.5M", // Target bitrate
      "-maxrate",
      "2M", // Max bitrate cap
      "-bufsize",
      "4M", // Buffer size
      "-vf",
      "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease", // Max 1080p
      "-c:a",
      "libvorbis", // Vorbis audio codec
      "-b:a",
      "128k", // Audio bitrate
      "-ac",
      "2", // Stereo audio
      "-threads",
      "0", // Use all available cores
      "-deadline",
      "good", // Speed/quality balance
      "-f",
      "webm", // WebM format
      tempOutputPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await subprocess.exited;
  const stderrOutput = await new Response(subprocess.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`FFmpeg failed with code ${exitCode}: ${stderrOutput}`);
  }

  const outputBuffer = await Bun.file(tempOutputPath).arrayBuffer();

  await unlink(tempInputPath);
  await unlink(tempOutputPath);

  console.log("successfully converted to webm");
  return Buffer.from(outputBuffer);
}
