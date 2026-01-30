import { Request, Response } from "express";
import Logger from "bunyan";
import { LightningService } from "../core/LightningService";

interface LightningInvoiceRequestBody {
  amount: string;
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
export function createLightningInvoiceHandler(logger: Logger) {
  return async function handleLightningInvoice(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "lightning_invoice" });

    try {
      const { amount, lnLikeAddress }: LightningInvoiceRequestBody = req.body;

      if (!amount || !lnLikeAddress) {
        log.debug(
          { amount, lnLikeAddress },
          "Validation failed: missing required fields",
        );
        res.status(400).json({
          message: "Missing required fields",
          error: "MissingRequiredFields",
        });
        return;
      }

      const lightningService = new LightningService();
      const invoice = await lightningService.createInvoice(
        amount,
        lnLikeAddress,
      );

      res.status(200).json({
        requestId: `lightning-invoice-${Date.now()}`,
        invoice: invoice,
      });
    } catch (error: any) {
      log.error({ error }, "Error in handleLightningInvoice");

      res.status(500).json({
        message: "Internal server error",
        error: error?.message,
      });
    }
  };
}
