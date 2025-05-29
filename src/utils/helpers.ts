import { eq } from "drizzle-orm";
import { blobStorage, db } from "../../db";
import { medias, sessions, users } from "../../db/schema";
import { models } from "oci-objectstorage";
import { BlankEnv, BlankInput } from "hono/types";
import { Context } from "hono";

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

export async function uploadToOCI(
  file: File,
  bucketName: string,
  objectName: string,
  namespace: string,
  sessionId: string,
) {
  try {
    const [{ userId }] = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!userId) {
      throw new Error("User Id not found.");
    }
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // console.log(`Uploading file: ${objectName}, size: ${file.size} bytes`);

    await blobStorage.putObject({
      namespaceName: namespace,
      bucketName,
      objectName,
      putObjectBody: uint8Array,
      contentLength: file.size,
      contentType: file.type || "application/octet-stream",
    });
    const url = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com/n/${namespace}/b/${bucketName}/o/${encodeURIComponent(objectName)}`;
    // console.log(url);
    const [mediaDbData] = await db
      .insert(medias)
      .values({
        mediaType: file.type.startsWith("image/") ? "image" : "video",
        cloudUrl: url,
        userId,
      })
      .returning();
    return mediaDbData;
  } catch (error) {
    console.error(`Error uploading file ${objectName}:`, error);
    throw error;
  }
}

export async function generatePresignedUrl(
  objectName: string,
  expirationMinutes: number = 60,
): Promise<string> {
  try {
    const namespace = await getNamespace();

    // Create the pre-authenticated request
    const parResponse = await blobStorage.createPreauthenticatedRequest({
      namespaceName: namespace,
      bucketName: bucketName,
      createPreauthenticatedRequestDetails: {
        name: `temp-access-${Date.now()}`,
        objectName: objectName,
        accessType:
          models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
        timeExpires: new Date(Date.now() + expirationMinutes * 60 * 1000),
      },
    });

    const accessUri = parResponse.preauthenticatedRequest.accessUri;

    if (!accessUri) {
      throw new Error("Missing access URI in preauthenticated response");
    }

    // Final signed URL
    const finalUrl = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com${accessUri}`;
    return finalUrl;
  } catch (error) {
    console.error("Error generating pre-signed URL:", error);
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
