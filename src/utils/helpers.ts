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

    await blobStorage.putObject({
      namespaceName: namespace,
      bucketName,
      objectName,
      putObjectBody: uint8Array,
      contentLength: file.size,
      contentType: file.type || "application/octet-stream",
    });

    const ociUrl = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com/n/${namespace}/b/${bucketName}/o/${encodeURIComponent(objectName)}`;

    const cloudfrontUrl = convertToCloudFrontUrl(ociUrl);

    const [mediaDbData] = await db
      .insert(medias)
      .values({
        mediaType: file.type.startsWith("image/") ? "image" : "video",
        cloudUrl: ociUrl,
        cloudfrontUrl: cloudfrontUrl,
        userId,
      })
      .returning();

    return { ...mediaDbData, cloudfrontUrl };
  } catch (error) {
    console.error(`Error uploading file ${objectName}:`, error);
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
