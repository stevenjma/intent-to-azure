import { BlobServiceClient } from "@azure/storage-blob";

export function getBlobService() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
  return BlobServiceClient.fromConnectionString(conn);
}

export async function uploadText(container: string, blob: string, text: string) {
  const svc = getBlobService();
  const containerClient = svc.getContainerClient(container);
  await containerClient.createIfNotExists();
  const blockBlob = containerClient.getBlockBlobClient(blob);
  await blockBlob.upload(text, Buffer.byteLength(text));
}
