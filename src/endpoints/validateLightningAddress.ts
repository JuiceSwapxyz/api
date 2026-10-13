import { Request, Response } from "express";
import Logger from "bunyan";
import { LightningService } from "../core/LightningService";

interface LightningAddressRequestBody {
  lnLikeAddress: string;
}

/**
 * @swagger
 * /v1/lightning/validate:
 *   post:
 *     tags: [Lightning]
 *     summary: Validate a Lightning address or LNURL
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [lnLikeAddress]
 *             properties:
 *               lnLikeAddress:
 *                 type: string
 *                 description: Lightning address (user@domain.com) or LNURL
 *           example:
 *             lnLikeAddress: "user@domain.com"
 *     responses:
 *       200:
 *         description: Address format is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requestId:
 *                   type: string
 *                 validated:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [lightning-address, lnurl]
 *                     value:
 *                       type: string
 *                     decoded:
 *                       type: string
 *                       description: Decoded URL, only present for LNURL
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createValidateLightningAddressHandler(logger: Logger) {
  return async function handleValidateLightningAddress(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "validate_lightning_address" });

    try {
      const { lnLikeAddress }: LightningAddressRequestBody = req.body;

      // Validation
      if (!lnLikeAddress) {
        log.debug(
          { lnLikeAddress },
          "Validation failed: missing required fields",
        );
        res.status(400).json({
          message: "Missing required fields",
          error: "MissingRequiredFields",
        });
        return;
      }

      const lightningService = new LightningService();

      try {
        const validated = lightningService.validateLnLikeAddress(lnLikeAddress);
        res.status(200).json({
          requestId: `validate-lightning-address-${Date.now()}`,
          validated,
        });
      } catch (error) {
        res.status(400).json({
          message: "Invalid Lightning address or LNURL format",
          error: "InvalidLightningAddressOrLnUrlFormat",
        });
      }
    } catch (error: any) {
      log.error({ error }, "Error in validateLightningAddress");

      res.status(500).json({
        message: "Internal server error",
        error: error?.message,
      });
    }
  };
}
