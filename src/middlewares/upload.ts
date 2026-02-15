import multer from "multer";
import ErrorHandler from "./Errorhandler.js";

// Configure multer to store files in memory (buffer)
const storage = multer.memoryStorage();

// File filter - only allow images
const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ErrorHandler(
        "Invalid file type. Only JPEG, JPG, PNG, and WebP images are allowed.",
        400,
      ) as any,
    );
  }
};

// Create multer upload instance
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max file size
  },
});
