import { MongoClient, Db, Collection } from "mongodb";
import dotenv from "dotenv";
import type { Resource } from "./types";

dotenv.config();

let client: MongoClient | null = null;
let db: Db | null = null;
let bucket: import("mongodb").GridFSBucket | null = null;

const DB_NAME = process.env.MONGODB_DB || "speechpath";
const COLLECTION_NAME = "resources";

export const getDb = async (): Promise<Db> => {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(DB_NAME);
  return db;
};

export const getResourcesCollection = async (): Promise<Collection<Resource>> => {
  const database = await getDb();
  return database.collection<Resource>(COLLECTION_NAME);
};

export const getUploadsBucket = async () => {
  if (bucket) return bucket;
  const database = await getDb();
  bucket = new (await import("mongodb")).GridFSBucket(database, { bucketName: "uploads" });
  return bucket;
};

export const closeDb = async () => {
  if (client) {
    await client.close();
    client = null;
    db = null;
    bucket = null;
  }
};
