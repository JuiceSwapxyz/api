import { Request, Response } from "express";
import { RouterService } from "../core/RouterService";
import { trackUser } from "../services/userTracking";
import { extractIpAddress } from "../utils/ipAddress";
import Logger from "bunyan";
import { ethers } from "ethers";
import { getApproveTxForToken } from "../utils/erc20";
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES } from "@juiceswapxyz/sdk-core";
import { JuiceGatewayService } from "../services/JuiceGatewayService";
import { hasJuiceDollarIntegration, isJusdAddress } from "../config/contracts";

// Gas limit for ERC721 approve operations
const ERC721_APPROVE_GAS_LIMIT = 65000;

interface LpApproveRequestBody {
  simulateTransaction: boolean;
  walletAddress: string;
  chainId: number;
  protocol: string;
  token0: string;
  token1: string;
  amount0?: string; // Optional for NFT-only mode (decrease liquidity)
  amount1?: string; // Optional for NFT-only mode (decrease liquidity)
  tokenId?: string; // NFT position token ID (for increase/decrease liquidity operations)
}

/**
 * @swagger
 * /v1/lp/approve:
 *   post:
 *     tags: [Liquidity]
 *     summary: Approve tokens for LP
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpApproveRequest'
 *           example:
 *             walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             chainId: 5115
 *             protocol: "V3"
 *             token0: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *             token1: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93"
 *             amount0: "1000000000000000000"
 *             amount1: "1000000000000000000"
 *             simulateTransaction: false
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpApprovalResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpApproveHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService,
) {
  return async function handleLpApprove(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "lp_approve" });

    try {
      const {
        walletAddress,
        chainId,
        token0,
        token1,
        amount0,
        amount1,
        tokenId,
      }: LpApproveRequestBody = req.body;

      trackUser(walletAddress, extractIpAddress(req), log);

      if (!walletAddress || !chainId || !token0 || !token1) {
        log.debug(
          { walletAddress, chainId, token0, token1 },
          "Validation failed: missing required fields",
        );
        res.status(400).json({
          message:
            "Missing required fields: walletAddress, chainId, token0, token1",
          error: "MissingRequiredFields",
        });
        return;
      }

      // Determine mode: token approval (with amounts) vs NFT-only (with tokenId, no amounts)
      const hasAmounts = amount0 && amount1;

      if (!hasAmounts && !tokenId) {
        res.status(400).json({
          message:
            "Either provide amount0/amount1 (for token approvals) or tokenId (for NFT-only approval)",
          error: "InvalidRequestMode",
        });
        return;
      }

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug(
          { chainId },
          "Validation failed: invalid chainId for LP approve",
        );
        res.status(400).json({
          message: "Invalid chainId",
          error: "InvalidChainId",
        });
        return;
      }

      // Determine spender based on whether JUSD is involved
      // If JUSD is involved, route through Gateway for automatic svJUSD conversion
      let spender = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
      let routingType: "POSITION_MANAGER" | "GATEWAY" = "POSITION_MANAGER";

      if (
        juiceGatewayService &&
        hasJuiceDollarIntegration(chainId) &&
        juiceGatewayService.detectLpGatewayRouting(chainId, token0, token1)
      ) {
        const gatewayAddress = juiceGatewayService.getGatewayAddress(chainId);
        if (gatewayAddress) {
          spender = gatewayAddress;
          routingType = "GATEWAY";
          log.debug(
            { chainId, token0, token1 },
            "LP approval routed through Gateway for JUSD",
          );
        }
      }

      if (!spender) {
        res.status(400).json({
          message: "Unsupported chain for LP operations",
          error: "UnsupportedChain",
        });
        return;
      }

      // Only check token approvals if amounts are provided (increase liquidity mode)
      let token0Approval = null;
      let token1Approval = null;

      if (hasAmounts) {
        // For JUSD tokens routed through Gateway, use unlimited approval to avoid conversion rate issues
        let adjustedAmount0 = amount0!;
        let adjustedAmount1 = amount1!;

        if (routingType === "GATEWAY") {
          if (isJusdAddress(chainId, token0)) {
            adjustedAmount0 = ethers.constants.MaxUint256.toString();
            log.debug(
              { original: amount0, adjusted: "unlimited" },
              "Using unlimited approval for JUSD token0",
            );
          }
          if (isJusdAddress(chainId, token1)) {
            adjustedAmount1 = ethers.constants.MaxUint256.toString();
            log.debug(
              { original: amount1, adjusted: "unlimited" },
              "Using unlimited approval for JUSD token1",
            );
          }
        }

        [token0Approval, token1Approval] = await Promise.all([
          getApproveTxForToken(
            token0,
            adjustedAmount0,
            walletAddress,
            spender,
            provider,
            chainId,
            log,
          ),
          getApproveTxForToken(
            token1,
            adjustedAmount1,
            walletAddress,
            spender,
            provider,
            chainId,
            log,
          ),
        ]);
      }

      // For existing positions with Gateway routing, check if NFT approval is needed
      let positionTokenApproval = null;
      if (tokenId && routingType === "GATEWAY") {
        const positionManagerAddress =
          NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
        if (positionManagerAddress) {
          try {
            // Check if NFT is already approved to Gateway
            const nftInterface = new ethers.utils.Interface([
              "function getApproved(uint256 tokenId) view returns (address)",
            ]);
            const callData = nftInterface.encodeFunctionData("getApproved", [
              tokenId,
            ]);

            const result = await provider.call({
              to: positionManagerAddress,
              data: callData,
            });

            const approvedAddress = ethers.utils.defaultAbiCoder.decode(
              ["address"],
              result,
            )[0];

            if (approvedAddress.toLowerCase() !== spender.toLowerCase()) {
              // Build ERC721 approve calldata
              const approveInterface = new ethers.utils.Interface([
                "function approve(address to, uint256 tokenId)",
              ]);
              const approveData = approveInterface.encodeFunctionData(
                "approve",
                [spender, tokenId],
              );

              positionTokenApproval = {
                to: positionManagerAddress,
                value: "0x00",
                from: walletAddress,
                data: approveData,
                gasLimit: ethers.utils.hexlify(ERC721_APPROVE_GAS_LIMIT),
                chainId,
              };

              log.debug(
                { tokenId, spender, positionManagerAddress },
                "NFT approval needed for Gateway",
              );
            } else {
              log.debug(
                { tokenId, spender },
                "NFT already approved to Gateway",
              );
            }
          } catch (error) {
            log.warn(
              { error, tokenId },
              "Error checking NFT approval - will return approval transaction",
            );
            // If we can't check, return approval transaction to be safe
            const approveInterface = new ethers.utils.Interface([
              "function approve(address to, uint256 tokenId)",
            ]);
            const approveData = approveInterface.encodeFunctionData("approve", [
              spender,
              tokenId,
            ]);

            positionTokenApproval = {
              to: positionManagerAddress,
              value: "0x00",
              from: walletAddress,
              data: approveData,
              gasLimit: ethers.utils.hexlify(ERC721_APPROVE_GAS_LIMIT),
              chainId,
            };
          }
        }
      }

      res.status(200).json({
        requestId: `lp-approve-${Date.now()}`,
        token0Approval,
        token1Approval,
        token0Cancel: null,
        token1Cancel: null,
        positionTokenApproval,
        permitData: null,
        token0PermitTransaction: null,
        token1PermitTransaction: null,
        positionTokenPermitTransaction: null,
        gasFeeToken0Approval: token0Approval?.gasLimit || "0",
        gasFeeToken1Approval: token1Approval?.gasLimit || "0",
        _spender: spender,
        _routingType: routingType,
      });

      log.debug(
        { chainId, walletAddress, routingType },
        "LP approve request completed",
      );
    } catch (error: any) {
      log.error({ error }, "Error in handleLpApprove");
      res.status(500).json({
        message: "Internal server error",
        error: error?.message,
      });
    }
  };
}
