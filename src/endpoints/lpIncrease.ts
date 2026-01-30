import { Request, Response } from "express";
import Logger from "bunyan";
import { ethers } from "ethers";
import JSBI from "jsbi";
import { RouterService } from "../core/RouterService";
import { JuiceGatewayService } from "../services/JuiceGatewayService";
import {
  CurrencyAmount,
  Percent,
  Ether,
  ChainId,
  Token,
} from "@juiceswapxyz/sdk-core";
import {
  ADDRESS_ZERO,
  NonfungiblePositionManager,
  Position,
  Pool,
} from "@juiceswapxyz/v3-sdk";
import {
  estimateEip1559Gas,
  getV3LpContext,
  V3LpPositionInput,
  getTokenAddress,
} from "./_shared/v3LpCommon";
import {
  getChainContracts,
  hasJuiceDollarIntegration,
} from "../config/contracts";

type IndependentToken = "TOKEN_0" | "TOKEN_1";

interface LpIncreaseRequestBody {
  simulateTransaction?: boolean;
  protocol: "V3";
  walletAddress: string;
  chainId: number;
  tokenId: string; // NFT position tokenId
  independentAmount: string;
  independentToken: IndependentToken;
  position: V3LpPositionInput;
}

const isNativeCurrencyPair = (token0: string, token1: string) =>
  token0 === ADDRESS_ZERO || token1 === ADDRESS_ZERO;

/**
 * @swagger
 * /v1/lp/increase:
 *   post:
 *     tags: [Liquidity]
 *     summary: Increase liquidity for an existing V3 LP position
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpIncreaseRequest'
 *           example:
 *             protocol: "V3"
 *             walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             chainId: 5115
 *             tokenId: "1234"
 *             independentAmount: "1000000000000000000"
 *             independentToken: "TOKEN_0"
 *             position:
 *               tickLower: -887220
 *               tickUpper: 887220
 *               pool:
 *                 token0: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *                 token1: "0x4370e27F7d91D9341bFf232d7Ee8bdfE3a9933a0"
 *                 fee: 3000
 *             simulateTransaction: false
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpIncreaseResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpIncreaseHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService,
) {
  return async function handleLpIncrease(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "lp_increase" });

    try {
      const {
        walletAddress,
        chainId,
        tokenId,
        independentAmount,
        independentToken,
        position,
      }: LpIncreaseRequestBody = req.body;

      if (
        !walletAddress ||
        !chainId ||
        !tokenId ||
        !independentAmount ||
        !independentToken ||
        !position ||
        !position?.pool?.token0 ||
        !position?.pool?.token1 ||
        position?.pool?.fee === undefined ||
        position?.tickLower === undefined ||
        position?.tickUpper === undefined
      ) {
        log.debug(
          {
            walletAddress,
            chainId,
            tokenId,
            independentAmount,
            independentToken,
            position,
          },
          "Validation failed: missing required fields for LP increase",
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

      const {
        provider,
        positionManagerAddress,
        token0,
        token1,
        poolInstance,
        tickLower,
        tickUpper,
      } = ctx.data;

      // Get user-facing token addresses (before JUSD→svJUSD mapping)
      const userToken0Addr = getTokenAddress(position.pool.token0, chainId);
      const userToken1Addr = getTokenAddress(position.pool.token1, chainId);

      // Check for Gateway routing (JUSD involved)
      if (
        juiceGatewayService &&
        hasJuiceDollarIntegration(chainId) &&
        juiceGatewayService.detectLpGatewayRouting(
          chainId,
          userToken0Addr,
          userToken1Addr,
        )
      ) {
        return handleGatewayLpIncrease({
          body: req.body,
          res,
          log,
          ctx: ctx.data,
          juiceGatewayService,
          userToken0Addr,
          userToken1Addr,
        });
      }

      const independentIsToken0 = independentToken === "TOKEN_0";

      // Compute the dependent amount from pool state
      let positionCalc: Position;
      let amount0Raw: string, amount1Raw: string;

      if (independentIsToken0) {
        positionCalc = Position.fromAmount0({
          pool: poolInstance,
          tickLower,
          tickUpper,
          amount0: JSBI.BigInt(independentAmount),
          useFullPrecision: false,
        });
        amount0Raw = independentAmount;
        amount1Raw = positionCalc.amount1.quotient.toString();
      } else {
        positionCalc = Position.fromAmount1({
          pool: poolInstance,
          tickLower,
          tickUpper,
          amount1: JSBI.BigInt(independentAmount),
        });
        amount0Raw = positionCalc.amount0.quotient.toString();
        amount1Raw = independentAmount;
      }

      const amount0 = CurrencyAmount.fromRawAmount(token0, amount0Raw);
      const amount1 = CurrencyAmount.fromRawAmount(token1, amount1Raw);

      if (
        JSBI.equal(amount0.quotient, JSBI.BigInt(0)) &&
        JSBI.equal(amount1.quotient, JSBI.BigInt(0))
      ) {
        res.status(400).json({
          message: "Both token amounts cannot be zero",
          error: "InvalidAmounts",
        });
        return;
      }

      const positionToAdd = Position.fromAmounts({
        pool: poolInstance,
        tickLower,
        tickUpper,
        amount0: amount0.quotient,
        amount1: amount1.quotient,
        useFullPrecision: false,
      });

      const slippageTolerance = new Percent(50, 10_000);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const useNative = isNativeCurrencyPair(
        position.pool.token0,
        position.pool.token1,
      )
        ? Ether.onChain(chainId)
        : undefined;

      const { calldata, value } = NonfungiblePositionManager.addCallParameters(
        positionToAdd,
        {
          tokenId,
          deadline,
          slippageTolerance,
          useNative,
        },
      );

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
        requestId: `lp-increase-${Date.now()}`,
        increase: {
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
          maxFeePerGas: maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
          gasLimit: gasLimit.toHexString(),
          chainId,
        },
        dependentAmount: independentIsToken0
          ? amount1.quotient.toString()
          : amount0.quotient.toString(),
        gasFee: ethers.utils.formatEther(gasFee),
      });

      log.debug(
        { chainId, walletAddress, tokenId },
        "LP increase request completed",
      );
    } catch (error: any) {
      log.error({ error }, "Error in handleLpIncrease");
      res
        .status(500)
        .json({ message: "Internal server error", error: error?.message });
    }
  };
}

/**
 * Handle LP increase when JUSD is involved
 * Routes through JuiceSwapGateway for automatic JUSD → svJUSD conversion
 */
async function handleGatewayLpIncrease(params: {
  body: LpIncreaseRequestBody;
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
}): Promise<void> {
  const {
    body,
    res,
    log,
    ctx,
    juiceGatewayService,
    userToken0Addr,
    userToken1Addr,
  } = params;
  const {
    walletAddress,
    chainId,
    tokenId,
    independentAmount,
    independentToken,
  } = body;
  const { provider, poolInstance, tickLower, tickUpper } = ctx;

  const contracts = getChainContracts(chainId);
  if (!contracts) {
    res.status(400).json({
      message: "JuiceDollar contracts not configured for this chain",
      error: "GatewayNotConfigured",
    });
    return;
  }

  const gatewayAddress = juiceGatewayService.getGatewayAddress(chainId);
  if (!gatewayAddress) {
    res.status(500).json({
      message: "Gateway address not configured",
      error: "GatewayNotConfigured",
    });
    return;
  }

  const independentIsToken0 = independentToken === "TOKEN_0";
  const isToken0Jusd =
    userToken0Addr.toLowerCase() === contracts.JUSD.toLowerCase();
  const isToken1Jusd =
    userToken1Addr.toLowerCase() === contracts.JUSD.toLowerCase();

  // Convert independent amount to svJUSD for position calculation
  let internalIndependentAmount = independentAmount;
  if (
    (independentIsToken0 && isToken0Jusd) ||
    (!independentIsToken0 && isToken1Jusd)
  ) {
    internalIndependentAmount = await juiceGatewayService.jusdToSvJusd(
      chainId as ChainId,
      independentAmount,
    );
  }

  // Calculate amounts using the SDK
  let positionCalc: Position;
  let amount0Raw: string, amount1Raw: string;

  if (independentIsToken0) {
    positionCalc = Position.fromAmount0({
      pool: poolInstance,
      tickLower,
      tickUpper,
      amount0: JSBI.BigInt(internalIndependentAmount),
      useFullPrecision: false,
    });

    // Convert dependent amount back to JUSD if token1 is JUSD
    let dependentAmount = positionCalc.amount1.quotient.toString();
    if (isToken1Jusd) {
      dependentAmount = await juiceGatewayService.svJusdToJusd(
        chainId as ChainId,
        dependentAmount,
      );
    }

    amount0Raw = independentAmount; // User's JUSD amount (or other token)
    amount1Raw = dependentAmount;
  } else {
    positionCalc = Position.fromAmount1({
      pool: poolInstance,
      tickLower,
      tickUpper,
      amount1: JSBI.BigInt(internalIndependentAmount),
    });

    // Convert dependent amount back to JUSD if token0 is JUSD
    let dependentAmount = positionCalc.amount0.quotient.toString();
    if (isToken0Jusd) {
      dependentAmount = await juiceGatewayService.svJusdToJusd(
        chainId as ChainId,
        dependentAmount,
      );
    }

    amount0Raw = dependentAmount;
    amount1Raw = independentAmount; // User's JUSD amount (or other token)
  }

  // Calculate minimums with slippage in internal (svJUSD) terms
  const internalAmount0 = isToken0Jusd
    ? await juiceGatewayService.jusdToSvJusd(chainId as ChainId, amount0Raw)
    : amount0Raw;
  const internalAmount1 = isToken1Jusd
    ? await juiceGatewayService.jusdToSvJusd(chainId as ChainId, amount1Raw)
    : amount1Raw;

  const positionForSlippage = Position.fromAmounts({
    pool: poolInstance,
    tickLower,
    tickUpper,
    amount0: JSBI.BigInt(internalAmount0),
    amount1: JSBI.BigInt(internalAmount1),
    useFullPrecision: false,
  });

  const slippageTolerance = new Percent(50, 10_000); // 0.5%
  const { amount0: internalAmount0Min, amount1: internalAmount1Min } =
    positionForSlippage.mintAmountsWithSlippage(slippageTolerance);

  // Convert minimums back to user-facing tokens (JUSD) for Gateway
  const amount0Min = isToken0Jusd
    ? await juiceGatewayService.svJusdToJusd(
        chainId as ChainId,
        internalAmount0Min.toString(),
      )
    : internalAmount0Min.toString();
  const amount1Min = isToken1Jusd
    ? await juiceGatewayService.svJusdToJusd(
        chainId as ChainId,
        internalAmount1Min.toString(),
      )
    : internalAmount1Min.toString();

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

  // Build Gateway.increaseLiquidity() calldata
  const calldata = juiceGatewayService.buildGatewayIncreaseLiquidityCalldata({
    tokenId,
    tokenA:
      body.position.pool.token0 === ADDRESS_ZERO
        ? ADDRESS_ZERO
        : userToken0Addr,
    tokenB:
      body.position.pool.token1 === ADDRESS_ZERO
        ? ADDRESS_ZERO
        : userToken1Addr,
    amountADesired: amount0Raw,
    amountBDesired: amount1Raw,
    amountAMin: amount0Min,
    amountBMin: amount1Min,
    deadline,
  });

  // Calculate value for native token (cBTC)
  const nativeValue = isNativeCurrencyPair(
    body.position.pool.token0,
    body.position.pool.token1,
  )
    ? ethers.BigNumber.from(
        body.position.pool.token0 === ADDRESS_ZERO ? amount0Raw : amount1Raw,
      )
    : ethers.BigNumber.from("0");

  // Estimate gas
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasFee } =
    await estimateEip1559Gas({
      provider,
      tx: {
        to: gatewayAddress,
        from: walletAddress,
        data: calldata,
        value: nativeValue,
      },
      logger: log,
    });

  // Get svJUSD share price for frontend validation
  const svJusdSharePrice = await juiceGatewayService.svJusdToJusd(
    chainId as ChainId,
    ethers.utils.parseEther("1").toString(),
  );

  res.status(200).json({
    requestId: `lp-increase-gateway-${Date.now()}`,
    increase: {
      to: gatewayAddress,
      from: walletAddress,
      data: calldata,
      value: nativeValue.toHexString(),
      maxFeePerGas: maxFeePerGas.toHexString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
      gasLimit: gasLimit.toHexString(),
      chainId,
    },
    dependentAmount: independentIsToken0 ? amount1Raw : amount0Raw,
    gasFee: ethers.utils.formatEther(gasFee),
    // svJUSD share price info for frontend display validation
    svJusdInfo: {
      sharePrice: svJusdSharePrice,
      sharePriceDecimals: 18,
      svJusdAddress: contracts.SV_JUSD,
      jusdAddress: contracts.JUSD,
      isJusdPair: true,
    },
    _routingType: "GATEWAY_LP",
    _note:
      "LP increase routed through JuiceSwapGateway. JUSD will be converted to svJUSD internally.",
  });

  log.debug(
    {
      chainId,
      walletAddress,
      tokenId,
      routingType: "GATEWAY_LP",
    },
    "Gateway LP increase request completed",
  );
}
