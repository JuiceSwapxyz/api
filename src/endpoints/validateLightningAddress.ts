import { Request, Response } from "express";
import Logger from "bunyan";
import { LightningService } from "../core/LightningService";

interface LightningAddressRequestBody {
  lnLikeAddress: string;
}

/**
 * @swagger
 * /v1/lightning/invoice:
 *   post:
 *     tags: [Lightning]
 *     summary: Lightning invoice endpoint
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LightningInvoiceRequest'
 *           example:
 *             amount: "1000000"
 *             lnLikeAddress: "ln1..."
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LightningInvoiceResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createValidateLightningAddressHandler(logger: Logger) {
  return async function handleLightningInvoice(
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
