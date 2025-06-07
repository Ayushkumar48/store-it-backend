import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ObjectStorageClient } from "oci-objectstorage";
import { Region, SimpleAuthenticationDetailsProvider } from "oci-common";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 5000,
});

const provider = new SimpleAuthenticationDetailsProvider(
  process.env.OCI_TENANCY_ID!,
  process.env.OCI_USER_ID!,
  process.env.OCI_FINGERPRINT!,
  process.env.OCI_PRIVATE_KEY!,
  null,
  Region.fromRegionId(process.env.OCI_REGION!),
);

export const blobStorage = new ObjectStorageClient({
  authenticationDetailsProvider: provider,
});

export const db = drizzle(pool);
