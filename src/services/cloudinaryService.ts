import cloudinary, { CLOUDINARY_FOLDER } from "../config/cloudinary.js";
import { UploadApiResponse } from "cloudinary";
import { Readable } from "stream";

/**
 * Upload image buffer to Cloudinary
 * @param fileBuffer - Buffer from multer
 * @param folder - Optional folder path in Cloudinary
 * @returns Cloudinary upload response with secure_url
 */
export async function uploadToCloudinary(
  fileBuffer: Buffer,
  folder: string = CLOUDINARY_FOLDER,
): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        transformation: [
          { width: 500, height: 500, crop: "fill", gravity: "face" },
          { quality: "auto", fetch_format: "auto" },
        ],
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        } else {
          reject(new Error("Upload failed: no result"));
        }
      },
    );

    // Convert buffer to stream and pipe to Cloudinary
    const stream = Readable.from(fileBuffer);
    stream.pipe(uploadStream);
  });
}

/**
 * Delete image from Cloudinary by public_id
 * @param publicId - Cloudinary public_id (extracted from URL)
 */
export async function deleteFromCloudinary(publicId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId);
    console.log(`Deleted image from Cloudinary: ${publicId}`);
  } catch (error) {
    console.error(`Failed to delete image from Cloudinary: ${publicId}`, error);
    // Don't throw - deletion failure shouldn't block the update
  }
}

/**
 * Extract Cloudinary public_id from secure_url
 * Example: https://res.cloudinary.com/demo/image/upload/v1234/finzz/avatars/abc123.jpg
 * Returns: finzz/avatars/abc123
 */
export function extractPublicId(cloudinaryUrl: string): string | null {
  try {
    const match = cloudinaryUrl.match(/\/upload\/v\d+\/(.+)\.\w+$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
