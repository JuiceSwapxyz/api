import { Request, Response } from "express";
import multer, { FileFilterCallback } from "multer";
import Logger from "bunyan";
import { getPinataService, TokenMetadata } from "../services/PinataService";
import { LaunchpadUploadMetadataSchema } from "../validation/schemas";

// Allowed image MIME types
const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

// Max file size: 5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Configure multer for memory storage
const storage = multer.memoryStorage();

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
  ) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Invalid file type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
        ),
      );
    }
  },
}).single("image");

/**
 * @swagger
 * /v1/launchpad/upload-image:
 *   post:
 *     tags: [Launchpad]
 *     summary: Upload token logo image to IPFS
 *     description: Uploads an image file to IPFS via Pinata and returns the IPFS URI
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Image file (png, jpg, gif, webp, svg). Max 5MB.
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 imageURI:
 *                   type: string
 *                   example: "ipfs://QmW2WQi7j6c7UgJTarActp7tDNikE4B2qXtFCfLPdsgaTQ"
 *       400:
 *         description: Invalid file or missing image
 *       500:
 *         description: Upload failed
 */
export function createUploadImageHandler(logger: Logger) {
  return async function handleUploadImage(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "launchpad/upload-image" });

    try {
      // Handle multer upload
      await new Promise<void>((resolve, reject) => {
        uploadMiddleware(req, res, (err) => {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              reject(
                new Error(
                  `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
                ),
              );
            } else {
              reject(err);
            }
          } else if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        log.debug("No image file provided");
        res.status(400).json({ error: "Image file is required" });
        return;
      }

      log.debug(
        {
          filename: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
        },
        "Processing image upload",
      );

      const pinataService = getPinataService(logger);
      const imageURI = await pinataService.uploadFile(
        file.buffer,
        file.originalname,
        file.mimetype,
      );

      log.info(
        { imageURI, filename: file.originalname },
        "Image uploaded successfully",
      );

      res.status(200).json({ imageURI });
    } catch (error: any) {
      log.error({ error: error.message }, "Error uploading image");
      res
        .status(error.message?.includes("Invalid file type") ? 400 : 500)
        .json({
          error: error.message || "Failed to upload image",
        });
    }
  };
}

/**
 * @swagger
 * /v1/launchpad/upload-metadata:
 *   post:
 *     tags: [Launchpad]
 *     summary: Upload token metadata JSON to IPFS
 *     description: Uploads token metadata to IPFS via Pinata and returns the IPFS URI
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - description
 *               - imageURI
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 100
 *                 description: Token name
 *               description:
 *                 type: string
 *                 maxLength: 500
 *                 description: Token description
 *               imageURI:
 *                 type: string
 *                 description: IPFS/Arweave/HTTPS URI of the token logo
 *               website:
 *                 type: string
 *                 description: Project website URL
 *               twitter:
 *                 type: string
 *                 description: Twitter handle or URL
 *               telegram:
 *                 type: string
 *                 description: Telegram handle or URL
 *     responses:
 *       200:
 *         description: Metadata uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metadataURI:
 *                   type: string
 *                   example: "ipfs://QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX"
 *       400:
 *         description: Invalid metadata
 *       500:
 *         description: Upload failed
 */
export function createUploadMetadataHandler(logger: Logger) {
  return async function handleUploadMetadata(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "launchpad/upload-metadata" });

    try {
      // Validate request body
      const result = LaunchpadUploadMetadataSchema.safeParse(req.body);
      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(", ");
        log.debug({ errors }, "Validation failed");
        res.status(400).json({ error: errors });
        return;
      }

      const { name, description, imageURI, website, twitter, telegram } =
        result.data;

      log.debug({ name, imageURI }, "Processing metadata upload");

      // Build metadata object following common token metadata standard
      const metadata: TokenMetadata = {
        name,
        description,
        image: imageURI,
      };

      // Add optional fields
      if (website) {
        metadata.external_url = website;
      }

      // Build attributes array for social links
      const attributes: Array<{ trait_type: string; value: string }> = [];

      if (twitter) {
        // Normalize twitter handle
        const twitterValue = twitter.startsWith("@") ? twitter : `@${twitter}`;
        attributes.push({ trait_type: "Twitter", value: twitterValue });
      }

      if (telegram) {
        // Normalize telegram handle
        const telegramValue = telegram.startsWith("@")
          ? telegram
          : `@${telegram}`;
        attributes.push({ trait_type: "Telegram", value: telegramValue });
      }

      if (attributes.length > 0) {
        metadata.attributes = attributes;
      }

      const pinataService = getPinataService(logger);
      const metadataURI = await pinataService.uploadJSON(
        metadata,
        `${name}-metadata`,
      );

      log.info({ metadataURI, name }, "Metadata uploaded successfully");

      res.status(200).json({ metadataURI });
    } catch (error: any) {
      log.error({ error: error.message }, "Error uploading metadata");
      res.status(500).json({
        error: error.message || "Failed to upload metadata",
      });
    }
  };
}
