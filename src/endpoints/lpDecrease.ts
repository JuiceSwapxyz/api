import { Request, Response } from 'express';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import JSBI from 'jsbi';
import { RouterService } from '../core/RouterService';
import { JuiceGatewayService } from '../services/JuiceGatewayService';
import { CurrencyAmount, Percent, Ether, ChainId, Token } from '@juiceswapxyz/sdk-core';
import { ADDRESS_ZERO, NonfungiblePositionManager, Position, Pool } from '@juiceswapxyz/v3-sdk';
import { estimateEip1559Gas, getV3LpContext, V3LpPositionInput, getTokenAddress } from './_shared/v3LpCommon';
import { getChainContracts, hasJuiceDollarIntegration } from '../config/contracts';

interface LpDecreaseRequestBody {
  simulateTransaction?: boolean;
  protocol: 'V3';
  tokenId: number;
  chainId: number;
  walletAddress: string;
  liquidityPercentageToDecrease: number; // 0-100 (supports up to 2 decimals)
  positionLiquidity: string; // raw liquidity as integer string
  expectedTokenOwed0RawAmount: string; // raw amount as integer string
  expectedTokenOwed1RawAmount: string; // raw amount as integer string
  position: V3LpPositionInput;
}

/**
 * @swagger
 * /v1/lp/decrease:
 *   post:
 *     tags: [Liquidity]
 *     summary: Decrease liquidity for an existing V3 LP position (and collect)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpDecreaseRequest'
 *           example:
 *             simulateTransaction: true
 *             protocol: "V3"
 *             tokenId: 210447
 *             chainId: 11155111
 *             walletAddress: "0x456037F8830454E0eC54ad3D55c741383862D0c7"
 *             liquidityPercentageToDecrease: 25
 *             positionLiquidity: "37945455597966861"
 *             expectedTokenOwed0RawAmount: "0"
 *             expectedTokenOwed1RawAmount: "0"
 *             position:
 *               tickLower: -887220
 *               tickUpper: 887220
 *               pool:
 *                 token0: "0x131a8656275bDd1130E0213414F3DA47C8C2a402"
 *                 token1: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
 *                 fee: 3000
 *                 tickSpacing: 60
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpDecreaseResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpDecreaseHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService
) {
  return async function handleLpDecrease(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'lp_decrease' });

    try {
      const {
        walletAddress,
        chainId,
        tokenId,
        liquidityPercentageToDecrease,
        positionLiquidity,
        expectedTokenOwed0RawAmount,
        expectedTokenOwed1RawAmount,
        position,
      }: LpDecreaseRequestBody = req.body;

      if (
        !walletAddress ||
        !chainId ||
        tokenId === undefined ||
        liquidityPercentageToDecrease === undefined ||
        !positionLiquidity ||
        expectedTokenOwed0RawAmount === undefined ||
        expectedTokenOwed1RawAmount === undefined ||
        !position ||
        !position?.pool?.token0 ||
        !position?.pool?.token1 ||
        position?.pool?.fee === undefined ||
        position?.tickLower === undefined ||
        position?.tickUpper === undefined
      ) {
        log.debug({ walletAddress, chainId, tokenId, liquidityPercentageToDecrease, positionLiquidity, position }, 'Validation failed: missing required fields for LP decrease');
        res.status(400).json({ message: 'Missing required fields', error: 'MissingRequiredFields' });
        return;
      }

      const percentBps = Math.round(liquidityPercentageToDecrease * 100);
      if (percentBps <= 0 || percentBps > 10_000) {
        res.status(400).json({ message: 'liquidityPercentageToDecrease must be > 0 and <= 100', error: 'InvalidLiquidityPercentage' });
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

      const { provider, positionManagerAddress, poolInstance, tickLower, tickUpper, token0, token1 } = ctx.data;

      // Get user-facing token addresses (before JUSD→svJUSD mapping)
      const userToken0Addr = getTokenAddress(position.pool.token0, chainId);
      const userToken1Addr = getTokenAddress(position.pool.token1, chainId);

      // Check for Gateway routing (JUSD involved)
      if (
        juiceGatewayService &&
        hasJuiceDollarIntegration(chainId) &&
        juiceGatewayService.detectLpGatewayRouting(chainId, userToken0Addr, userToken1Addr)
      ) {
        return handleGatewayLpDecrease({
          body: req.body,
          res,
          log,
          ctx: ctx.data,
          juiceGatewayService,
          userToken0Addr,
          userToken1Addr,
          percentBps,
        });
      }

      const positionInstance = new Position({
        pool: poolInstance,
        tickLower,
        tickUpper,
        liquidity: JSBI.BigInt(positionLiquidity),
      });

      const slippageTolerance = new Percent(50, 10_000);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const currency0 = position.pool.token0 === ADDRESS_ZERO ? Ether.onChain(chainId) : token0;
      const currency1 = position.pool.token1 === ADDRESS_ZERO ? Ether.onChain(chainId) : token1;

      const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(currency0, expectedTokenOwed0RawAmount);
      const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(currency1, expectedTokenOwed1RawAmount);

      const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionInstance, {
        tokenId,
        liquidityPercentage: new Percent(percentBps, 10_000),
        slippageTolerance,
        deadline,
        burnToken: false,
        collectOptions: {
          recipient: walletAddress,
          expectedCurrencyOwed0,
          expectedCurrencyOwed1,
        },
      });

      const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasFee } = await estimateEip1559Gas({
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
        requestId: `lp-decrease-${Date.now()}`,
        decrease: {
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
          maxFeePerGas: maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
          gasLimit: gasLimit.toHexString(),
          chainId,
        },
        gasFee: ethers.utils.formatEther(gasFee),
      });

      log.debug({ chainId, walletAddress, tokenId, liquidityPercentageToDecrease }, 'LP decrease request completed');
    } catch (error: any) {
      log.error({ error }, 'Error in handleLpDecrease');
      res.status(500).json({ message: 'Internal server error', error: error?.message });
    }
  };
}

/**
 * Handle LP decrease when JUSD is involved
 * Routes through JuiceSwapGateway for automatic svJUSD → JUSD conversion
 * User receives JUSD directly (not svJUSD)
 */
async function handleGatewayLpDecrease(params: {
  body: LpDecreaseRequestBody;
  res: Response;
  log: Logger;
  ctx: {
    provider: ethers.providers.StaticJsonRpcProvider;
    positionManagerAddress: string;
    token0: Token;
    token1: Token;
    poolInstance: Pool;
    tickLower: number;
    tickUpper: number;
  };
  juiceGatewayService: JuiceGatewayService;
  userToken0Addr: string;
  userToken1Addr: string;
  percentBps: number;
}): Promise<void> {
  const { body, res, log, ctx, juiceGatewayService, userToken0Addr, userToken1Addr, percentBps } = params;
  const { walletAddress, chainId, tokenId, positionLiquidity } = body;
  const { provider, poolInstance, tickLower, tickUpper } = ctx;

  const contracts = getChainContracts(chainId);
  if (!contracts) {
    res.status(400).json({
      message: 'JuiceDollar contracts not configured for this chain',
      error: 'GatewayNotConfigured',
    });
    return;
  }

  const gatewayAddress = juiceGatewayService.getGatewayAddress(chainId);
  if (!gatewayAddress) {
    res.status(500).json({
      message: 'Gateway address not configured',
      error: 'GatewayNotConfigured',
    });
    return;
  }

  const isToken0Jusd = userToken0Addr.toLowerCase() === contracts.JUSD.toLowerCase();
  const isToken1Jusd = userToken1Addr.toLowerCase() === contracts.JUSD.toLowerCase();

  // Calculate liquidity to remove from percentage
  // percentBps is in basis points (e.g., 2500 = 25%)
  const liquidityBigInt = BigInt(positionLiquidity);
  const liquidityToRemove = (liquidityBigInt * BigInt(percentBps)) / BigInt(10000);

  // Create position instance to calculate expected amounts (in svJUSD terms)
  const positionInstance = new Position({
    pool: poolInstance,
    tickLower,
    tickUpper,
    liquidity: JSBI.BigInt(positionLiquidity),
  });

  // Calculate expected amounts from removing liquidity
  // These are in internal (svJUSD) terms
  const slippageTolerance = new Percent(50, 10_000); // 0.5%
  const { amount0: internalAmount0Min, amount1: internalAmount1Min } =
    positionInstance.burnAmountsWithSlippage(slippageTolerance);

  // Scale minimum amounts by the percentage being removed using JSBI to maintain precision
  const scaledInternalAmount0Min = JSBI.divide(
    JSBI.multiply(internalAmount0Min, JSBI.BigInt(percentBps)),
    JSBI.BigInt(10000)
  );
  const scaledInternalAmount1Min = JSBI.divide(
    JSBI.multiply(internalAmount1Min, JSBI.BigInt(percentBps)),
    JSBI.BigInt(10000)
  );

  // Convert minimums to user-facing tokens (JUSD) for Gateway
  // The Gateway will return JUSD directly to the user (handles svJUSD → JUSD conversion)
  const amount0Min = isToken0Jusd
    ? await juiceGatewayService.svJusdToJusd(chainId as ChainId, scaledInternalAmount0Min.toString())
    : scaledInternalAmount0Min.toString();
  const amount1Min = isToken1Jusd
    ? await juiceGatewayService.svJusdToJusd(chainId as ChainId, scaledInternalAmount1Min.toString())
    : scaledInternalAmount1Min.toString();

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

  // Build Gateway.removeLiquidity() calldata
  const calldata = juiceGatewayService.buildGatewayRemoveLiquidityCalldata({
    tokenId: tokenId.toString(),
    liquidityToRemove: liquidityToRemove.toString(),
    tokenA: userToken0Addr,
    tokenB: userToken1Addr,
    amountAMin: amount0Min,
    amountBMin: amount1Min,
    recipient: walletAddress,
    deadline,
  });

  // Estimate gas
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasFee } = await estimateEip1559Gas({
    provider,
    tx: {
      to: gatewayAddress,
      from: walletAddress,
      data: calldata,
      value: ethers.BigNumber.from('0'), // No ETH value needed for remove
    },
    logger: log,
  });

  // Get svJUSD share price for frontend validation
  const svJusdSharePrice = await juiceGatewayService.svJusdToJusd(chainId as ChainId, ethers.utils.parseEther('1').toString());

  res.status(200).json({
    requestId: `lp-decrease-gateway-${Date.now()}`,
    decrease: {
      to: gatewayAddress,
      from: walletAddress,
      data: calldata,
      value: '0x0',
      maxFeePerGas: maxFeePerGas.toHexString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
      gasLimit: gasLimit.toHexString(),
      chainId,
    },
    gasFee: ethers.utils.formatEther(gasFee),
    // svJUSD share price info for frontend display validation
    svJusdInfo: {
      sharePrice: svJusdSharePrice,
      sharePriceDecimals: 18,
      svJusdAddress: contracts.SV_JUSD,
      jusdAddress: contracts.JUSD,
      isJusdPair: true,
    },
    _routingType: 'GATEWAY_LP',
    _note: 'LP decrease routed through JuiceSwapGateway. svJUSD will be converted to JUSD and returned directly.',
  });

  log.debug({
    chainId,
    walletAddress,
    tokenId,
    liquidityToRemove: liquidityToRemove.toString(),
    routingType: 'GATEWAY_LP',
  }, 'Gateway LP decrease request completed');
}

