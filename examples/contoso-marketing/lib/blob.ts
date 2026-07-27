import { BlobServiceClient } from "@azure/storage-blob";

const client = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING ?? "",
);

export async function uploadAsset(name: string, data: Buffer): Promise<string> {
  const container = client.getContainerClient("assets");
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(name);
  await blob.uploadData(data);
  return blob.url;
}
