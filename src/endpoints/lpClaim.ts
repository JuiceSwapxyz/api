import { Request, Response } from "express";
import Logger from "bunyan";
import { RouterService } from "../core/RouterService";
import { JuiceGatewayService } from "../services/JuiceGatewayService";
import { CurrencyAmount, Ether } from "@juiceswapxyz/sdk-core";
import { ADDRESS_ZERO, NonfungiblePositionManager } from "@juiceswapxyz/v3-sdk";
import {
  getV3LpContext,
  V3LpPositionInput,
  estimateEip1559Gas,
} from "./_shared/v3LpCommon";

interface LpClaimRequestBody {
  simulateTransaction?: boolean;
  protocol: "V3";
  tokenId: number;
  walletAddress: string;
  chainId: number;
  position: V3LpPositionInput;
  expectedTokenOwed0RawAmount: string;
  expectedTokenOwed1RawAmount: string;
  collectAsWETH: boolean;
}

/**
 * @swagger
 * /v1/lp/claim:
 *   post:
 *     tags: [Liquidity]
 *     summary: Claim fees from an existing V3 LP position
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpClaimRequest'
 *           example:
 *             simulateTransaction: true
 *             protocol: "V3"
 *             tokenId: 4
 *             walletAddress: "0x79bf94059b3991c747401Ff8f5291fE4C8E4C457"
 *             chainId: 5115
 *             position:
 *               pool:
 *                 token0: "0x6a850a548fdd050e8961223ec8FfCDfacEa57E39"
 *                 token1: "0x0000000000000000000000000000000000000000"
 *                 fee: 3000
 *                 tickSpacing: 60
 *               tickLower: -887220
 *               tickUpper: 887220
 *             expectedTokenOwed0RawAmount: "13107919229270"
 *             expectedTokenOwed1RawAmount: "682107835790"
 *             collectAsWETH: false
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpClaimResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpClaimHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService,
) {
  return async function handleLpClaim(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "lp_claim" });

    try {
      const {
        protocol,
        walletAddress,
        chainId,
        tokenId,
        position,
        expectedTokenOwed0RawAmount,
        expectedTokenOwed1RawAmount,
        collectAsWETH,
      }: LpClaimRequestBody = req.body;

      if (protocol !== "V3") {
        log.debug(
          { protocol },
          "Validation failed: only V3 protocol is supported",
        );
        res.status(400).json({
          message: "Only V3 protocol is supported",
          error: "UnsupportedProtocol",
        });
        return;
      }

      if (
        !walletAddress ||
        !chainId ||
        tokenId === undefined ||
        !position ||
        !position?.pool?.token0 ||
        !position?.pool?.token1 ||
        position?.pool?.fee === undefined ||
        position?.tickLower === undefined ||
        position?.tickUpper === undefined ||
        expectedTokenOwed0RawAmount === undefined ||
        expectedTokenOwed1RawAmount === undefined ||
        collectAsWETH === undefined
      ) {
        log.debug(
          { walletAddress, chainId, tokenId, position },
          "Validation failed: missing required fields for LP claim",
        );
        res.status(400).json({
          message: "Missing required fields",
          error: "MissingRequiredFields",
        });
        return;
      }

      const ctx = await getV3LpContext({
        routerService,
        logger: log,
        chainId,
        tokenId,
        position,
        juiceGatewayService,
      });
      if (!ctx.ok) {
        res.status(ctx.status).json({ message: ctx.message, error: ctx.error });
        return;
      }

      const { provider, positionManagerAddress, token0, token1 } = ctx.data;

      const isNativePair =
        position.pool.token0 === ADDRESS_ZERO ||
        position.pool.token1 === ADDRESS_ZERO;

      let currency0, currency1;
      if (isNativePair && collectAsWETH) {
        currency0 = token0;
        currency1 = token1;
      } else {
        currency0 =
          position.pool.token0 === ADDRESS_ZERO
            ? Ether.onChain(chainId)
            : token0;
        currency1 =
          position.pool.token1 === ADDRESS_ZERO
            ? Ether.onChain(chainId)
            : token1;
      }

      const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(
        currency0,
        expectedTokenOwed0RawAmount,
      );
      const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(
        currency1,
        expectedTokenOwed1RawAmount,
      );

      const { calldata, value } =
        NonfungiblePositionManager.collectCallParameters({
          tokenId: tokenId.toString(),
          expectedCurrencyOwed0,
          expectedCurrencyOwed1,
          recipient: walletAddress,
        });

      const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasFee } =
        await estimateEip1559Gas({
          provider,
          tx: {
            to: positionManagerAddress,
            from: walletAddress,
            data: calldata,
            value,
          },
          logger: log,
        });

      res.status(200).json({
        requestId: `lp-claim-${Date.now()}`,
        claim: {
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
          chainId,
          gasLimit: gasLimit.toString(),
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        },
        gasFee,
      });

      log.debug(
        { chainId, walletAddress, tokenId },
        "LP claim request completed",
      );
    } catch (error: any) {
      log.error({ error }, "Error in handleLpClaim");
      res
        .status(500)
        .json({ message: "Internal server error", error: error?.message });
    }
  };
}
