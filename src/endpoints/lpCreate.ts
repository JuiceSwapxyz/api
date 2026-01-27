import { Request, Response } from 'express';
import { RouterService } from '../core/RouterService';
import { trackUser } from '../services/userTracking';
import { extractIpAddress } from '../utils/ipAddress';
import Logger from 'bunyan';
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES, ChainId } from '@juiceswapxyz/sdk-core';
import {
  NonfungiblePositionManager,
  Position,
  nearestUsableTick,
  TickMath,
  ADDRESS_ZERO,
} from '@juiceswapxyz/v3-sdk';
import { Token, CurrencyAmount, Percent, WETH9 } from '@juiceswapxyz/sdk-core';
import JSBI from 'jsbi';
import { ethers } from 'ethers';
import { getPoolInstance } from '../utils/poolFactory';
import { TICK_SPACING } from './_shared/v3LpCommon';
import { JuiceGatewayService } from '../services/JuiceGatewayService';
import { getChainContracts, hasJuiceDollarIntegration } from '../config/contracts';

const ERC20_ABI = ['function decimals() view returns (uint8)'];
const NPM_IFACE = new ethers.utils.Interface([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH()',
]);

// Citrea's estimateGas returns unreliable values that can exceed the 10M block gas limit.
// Cap at 6M to handle pool creation while staying under 10M block limit.
const CITREA_MAX_GAS_LIMIT = ethers.BigNumber.from('6000000');
const CITREA_CHAIN_IDS = [4114, 5115]; // mainnet, testnet

function capGasLimitForCitrea(gasLimit: ethers.BigNumber, chainId: number, log: Logger): ethers.BigNumber {
  if (CITREA_CHAIN_IDS.includes(chainId) && gasLimit.gt(CITREA_MAX_GAS_LIMIT)) {
    log.warn({ chainId, estimated: gasLimit.toString(), capped: CITREA_MAX_GAS_LIMIT.toString() },
      'Gas limit exceeded Citrea max, capping to 6M');
    return CITREA_MAX_GAS_LIMIT;
  }
  return gasLimit;
}

const getTokenAddress = (token: string, chainId: number) => {
  const address = token === ADDRESS_ZERO ? WETH9[chainId].address : token;
  return ethers.utils.getAddress(address);
};

const isNativeCurrencyPair = (token0: string, token1: string) => {
  return token0 === ADDRESS_ZERO || token1 === ADDRESS_ZERO;
};

const calculateTxValue = (token0: string, amount0Raw: string, token1: string, amount1Raw: string) => {
  if (!isNativeCurrencyPair(token0, token1)) {
    return ethers.BigNumber.from('0');
  }

  const amount = token0 === ADDRESS_ZERO ? amount0Raw : amount1Raw;
  return ethers.BigNumber.from(amount);
};

type IndependentToken = 'TOKEN_0' | 'TOKEN_1';

interface PoolInfo {
  tickSpacing: number;
  token0: string;
  token1: string;
  fee: number;
}

interface PositionInfo {
  tickLower: number;
  tickUpper: number;
  pool: PoolInfo;
}

interface LpCreateRequestBody {
  simulateTransaction?: boolean;
  protocol: 'V3';
  walletAddress: string;
  chainId: number;
  independentAmount: string;
  independentToken: IndependentToken;
  initialDependentAmount?: string;
  initialPrice?: string;
  position: PositionInfo;
  slippageTolerance?: string;
}

/**
 * @swagger
 * /v1/lp/create:
 *   post:
 *     tags: [Liquidity]
 *     summary: Create LP position
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpCreateRequest'
 *           example:
 *             protocol: "V3"
 *             walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             chainId: 5115
 *             independentAmount: "1000000000000000000"
 *             independentToken: "TOKEN_0"
 *             position:
 *               tickLower: -887220
 *               tickUpper: 887220
 *               pool:
 *                 token0: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *                 token1: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93"
 *                 fee: 3000
 *             simulateTransaction: false
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpCreateResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpCreateHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService
) {
  return async function handleLpCreate(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'lp_create' });

    try {
      const {
        walletAddress,
        chainId,
        independentAmount,
        independentToken,
        initialDependentAmount,
        initialPrice,
        position,
      }: LpCreateRequestBody = req.body;

      trackUser(walletAddress, extractIpAddress(req), log);

      if (
        !walletAddress ||
        !chainId ||
        !independentAmount ||
        !independentToken ||
        !position ||
        !position?.pool?.token0 ||
        !position?.pool?.token1 ||
        position?.pool?.fee === undefined ||
        position?.tickLower === undefined ||
        position?.tickUpper === undefined
      ) {
        log.debug({ walletAddress, chainId, independentAmount, independentToken, position }, 'Validation failed: missing required fields for LP create');
        res.status(400).json({ message: 'Missing required fields', error: 'MissingRequiredFields' });
        return;
      }

      const isNewPool = initialPrice && initialDependentAmount;
      const isExistingPool = !initialPrice && !initialDependentAmount;
      if (!isNewPool && !isExistingPool) {
        log.debug({ initialPrice, initialDependentAmount }, 'Validation failed: invalid LP create input');
        res
          .status(400)
          .json({
            message: 'Invalid input: provide either both initialPrice+initialDependentAmount or neither',
            error: 'InvalidInput'
          });
        return;
      }

      // Validate sqrtPriceX96 is within valid range for new pools
      if (initialPrice) {
        const sqrtPriceX96 = JSBI.BigInt(initialPrice);
        if (
          JSBI.lessThan(sqrtPriceX96, TickMath.MIN_SQRT_RATIO) ||
          JSBI.greaterThanOrEqual(sqrtPriceX96, TickMath.MAX_SQRT_RATIO)
        ) {
          log.debug({ initialPrice }, 'Validation failed: sqrtPriceX96 out of valid range');
          res.status(400).json({
            message: 'Initial price (sqrtPriceX96) is out of valid range',
            error: 'InvalidSqrtPriceX96',
            _hint: {
              minSqrtPriceX96: TickMath.MIN_SQRT_RATIO.toString(),
              maxSqrtPriceX96: TickMath.MAX_SQRT_RATIO.toString(),
            },
          });
          return;
        }
      }

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug({ chainId }, 'Validation failed: invalid chainId for LP create');
        res.status(400).json({ message: 'Invalid chainId', error: 'InvalidChainId' });
        return;
      }

      const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
      if (!positionManagerAddress) {
        res.status(400).json({ message: 'Unsupported chain for LP operations', error: 'UnsupportedChain' });
        return;
      }

      const token0Addr = getTokenAddress(position.pool.token0, chainId);
      const token1Addr = getTokenAddress(position.pool.token1, chainId);

      // ============================================
      // Check for Gateway LP routing (JUSD involved)
      // ============================================
      if (
        juiceGatewayService &&
        hasJuiceDollarIntegration(chainId) &&
        juiceGatewayService.detectLpGatewayRouting(chainId, token0Addr, token1Addr)
      ) {
        return await handleGatewayLpCreate(
          req.body,
          res,
          log,
          juiceGatewayService,
          provider
        );
      }
      if (token0Addr.toLowerCase() >= token1Addr.toLowerCase()) {
        res.status(400).json({ message: 'token0 must be < token1 by address', error: 'TokenOrderInvalid' });
        return;
      }

      const [dec0, dec1] = await Promise.all([
        new ethers.Contract(token0Addr, ERC20_ABI, provider).decimals(),
        new ethers.Contract(token1Addr, ERC20_ABI, provider).decimals(),
      ]);

      const token0 = new Token(chainId, token0Addr, dec0);
      const token1 = new Token(chainId, token1Addr, dec1);

      const poolInstance = await getPoolInstance({
        token0,
        token1,
        fee: position.pool.fee,
        chainId,
        sqrtPriceX96: initialPrice,
        tickCurrent: initialPrice ? TickMath.getTickAtSqrtRatio(JSBI.BigInt(initialPrice)) : undefined,
        provider,
        log,
      });
      if (!poolInstance) {
        res.status(400).json({ message: 'Invalid pool instance', error: 'InvalidPoolInstance' });
        return;
      }

      const spacing = TICK_SPACING[position.pool.fee] ?? position.pool.tickSpacing;
      if (spacing === undefined) {
        res.status(400).json({ message: 'Unsupported fee tier', error: 'UnsupportedFee' });
        return;
      }

      const tickLower = nearestUsableTick(position.tickLower, spacing);
      const tickUpper = nearestUsableTick(position.tickUpper, spacing);
      if (tickLower >= tickUpper) {
        res
          .status(400)
          .json({ message: 'Invalid tick range: tickLower < tickUpper', error: 'InvalidTickRange' });
        return;
      }

      const independentIsToken0 = independentToken === 'TOKEN_0';

      let amount0Raw: string, amount1Raw: string;

      if (isNewPool) {
        amount0Raw = independentIsToken0 ? independentAmount : initialDependentAmount!;
        amount1Raw = independentIsToken0 ? initialDependentAmount! : independentAmount;
      } else {
        let positionCalc: Position;

        if (independentIsToken0) {
          positionCalc = Position.fromAmount0({
            pool: poolInstance,
            tickLower,
            tickUpper,
            amount0: JSBI.BigInt(independentAmount),
            useFullPrecision: false
          });

          amount0Raw = independentAmount;
          amount1Raw = positionCalc.amount1.quotient.toString();
        } else {
          positionCalc = Position.fromAmount1({
            pool: poolInstance,
            tickLower,
            tickUpper,
            amount1: JSBI.BigInt(independentAmount)
          });

          amount0Raw = positionCalc.amount0.quotient.toString();
          amount1Raw = independentAmount;
        }
      }

      const amount0 = CurrencyAmount.fromRawAmount(token0, amount0Raw);
      const amount1 = CurrencyAmount.fromRawAmount(token1, amount1Raw);

      if (JSBI.equal(amount0.quotient, JSBI.BigInt(0)) && JSBI.equal(amount1.quotient, JSBI.BigInt(0))) {
        res.status(400).json({ message: 'Both token amounts cannot be zero', error: 'InvalidAmounts' });
        return;
      }

      const positionInstance = Position.fromAmounts({
        pool: poolInstance,
        tickLower,
        tickUpper,
        amount0: amount0.quotient,
        amount1: amount1.quotient,
        useFullPrecision: false,
      });

      const slippageTolerance = new Percent(50, 10_000);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const { calldata: createCD, value: createVal } =
        NonfungiblePositionManager.createCallParameters(poolInstance);
      const { calldata: mintCD, value: mintVal } = NonfungiblePositionManager.addCallParameters(positionInstance, {
        recipient: walletAddress,
        deadline,
        slippageTolerance,
      });

      const calls: string[] = [createCD, mintCD];

      if (isNativeCurrencyPair(position.pool.token0, position.pool.token1)) {
        calls.push(NPM_IFACE.encodeFunctionData('refundETH', []));
      }

      const multicallData = NPM_IFACE.encodeFunctionData('multicall', [calls]);
      const nativeValue = calculateTxValue(position.pool.token0, amount0Raw, position.pool.token1, amount1Raw);
      const totalValueBN = ethers.BigNumber.from(createVal || '0')
        .add(ethers.BigNumber.from(mintVal || '0'))
        .add(nativeValue);
      const totalValueHex = totalValueBN.toHexString();
      const feeData = await provider.getFeeData();

      let gasEstimate = isNewPool ? ethers.BigNumber.from('5500000') : ethers.BigNumber.from('600000');
      try {
        gasEstimate = await provider.estimateGas({
          to: positionManagerAddress,
          from: walletAddress,
          data: multicallData,
          value: totalValueHex,
        });
      } catch (e) {
        log.warn('Gas estimation failed, using fallback');
      }

      let gasLimit = gasEstimate.mul(110).div(100);
      gasLimit = capGasLimitForCitrea(gasLimit, chainId, log);

      const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('0.00000136', 'gwei');
      const maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei');
      const maxFeePerGas = baseFee.mul(105).div(100).add(maxPriorityFeePerGas);

      const gasFee = gasLimit.mul(maxFeePerGas);

      const response = {
        requestId: `lp-create-${Date.now()}`,
        create: {
          to: positionManagerAddress,
          from: walletAddress,
          data: multicallData,
          value: totalValueHex,
          maxFeePerGas: maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
          gasLimit: gasLimit.toHexString(),
          chainId,
        },
        dependentAmount: independentIsToken0 ? amount1.quotient.toString() : amount0.quotient.toString(),
        gasFee: ethers.utils.formatEther(gasFee),
      };

      res.status(200).json(response);

      log.debug({ chainId, walletAddress }, 'LP create request completed');

    } catch (error: any) {
      log.error({ error }, 'Error in handleLpCreate');
      res.status(500).json({ message: 'Internal server error', error: error?.message });
    }
  };
}

/**
 * Handle LP creation when JUSD is involved
 * Routes through JuiceSwapGateway for automatic JUSD → svJUSD conversion
 *
 * Per the JuiceDollar integration spec:
 * - User provides JUSD, but all pools use svJUSD internally
 * - Gateway.addLiquidity() handles the conversion automatically
 * - This allows LPs to earn both swap fees AND savings interest
 *
 * Note: Gateway only supports full-range positions. For custom tick ranges
 * with JUSD, users must manually convert JUSD → svJUSD first.
 */
async function handleGatewayLpCreate(
  body: LpCreateRequestBody,
  res: Response,
  log: Logger,
  juiceGatewayService: JuiceGatewayService,
  provider: ethers.providers.StaticJsonRpcProvider
): Promise<void> {
  const {
    walletAddress,
    chainId,
    independentAmount,
    independentToken,
    initialDependentAmount,
    initialPrice,
    position,
  } = body;

  const contracts = getChainContracts(chainId);
  if (!contracts) {
    res.status(400).json({
      message: 'JuiceDollar contracts not configured for this chain',
      error: 'GatewayNotConfigured',
    });
    return;
  }

  const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
  if (!positionManagerAddress) {
    res.status(400).json({
      message: 'PositionManager not configured for this chain',
      error: 'PositionManagerNotConfigured',
    });
    return;
  }

  // Get tick spacing for this fee tier
  const tickSpacing = TICK_SPACING[position.pool.fee] ?? position.pool.tickSpacing;
  if (tickSpacing === undefined) {
    res.status(400).json({ message: 'Unsupported fee tier', error: 'UnsupportedFee' });
    return;
  }

  const tickLower = nearestUsableTick(position.tickLower, tickSpacing);
  const tickUpper = nearestUsableTick(position.tickUpper, tickSpacing);

  const gatewayAddress = juiceGatewayService.getGatewayAddress(chainId);
  if (!gatewayAddress) {
    res.status(500).json({
      message: 'Gateway address not configured',
      error: 'GatewayNotConfigured',
    });
    return;
  }

  // Get token addresses (user-facing, not converted)
  const token0Addr = getTokenAddress(position.pool.token0, chainId);
  const token1Addr = getTokenAddress(position.pool.token1, chainId);

  // Get internal pool tokens (JUSD → svJUSD)
  const internalToken0 = juiceGatewayService.getInternalPoolToken(chainId, token0Addr);
  const internalToken1 = juiceGatewayService.getInternalPoolToken(chainId, token1Addr);

  // Fetch decimals for internal tokens
  const [dec0, dec1] = await Promise.all([
    new ethers.Contract(internalToken0, ERC20_ABI, provider).decimals(),
    new ethers.Contract(internalToken1, ERC20_ABI, provider).decimals(),
  ]);

  const internalPoolToken0 = new Token(chainId, internalToken0, dec0);
  const internalPoolToken1 = new Token(chainId, internalToken1, dec1);

  // Get pool instance with internal tokens (svJUSD pool)
  const poolInstance = await getPoolInstance({
    token0: internalPoolToken0,
    token1: internalPoolToken1,
    fee: position.pool.fee,
    chainId,
    sqrtPriceX96: initialPrice,
    tickCurrent: initialPrice ? TickMath.getTickAtSqrtRatio(JSBI.BigInt(initialPrice)) : undefined,
    provider,
    log,
  });

  if (!poolInstance) {
    res.status(400).json({
      message: 'Pool not found. The svJUSD pool may not exist yet.',
      error: 'PoolNotFound',
      _hint: {
        internalToken0,
        internalToken1,
        fee: position.pool.fee,
      },
    });
    return;
  }

  // For slippage calculation, ALWAYS use actual on-chain pool state
  // This ensures minimums are calculated against the real price, not frontend-provided price
  // which may be stale or for a pool the frontend incorrectly thinks doesn't exist
  const slippagePoolInstance = await getPoolInstance({
    token0: internalPoolToken0,
    token1: internalPoolToken1,
    fee: position.pool.fee,
    chainId,
    // Don't pass sqrtPriceX96/tickCurrent - forces getPoolInstanceFromOnchainData()
    provider,
    log,
  });

  // Use on-chain pool for slippage if available, otherwise fall back to user-provided
  // (fallback only applies for truly new pools that don't exist on chain yet)
  const poolForSlippage = slippagePoolInstance || poolInstance;

  const independentIsToken0 = independentToken === 'TOKEN_0';

  // Determine if pool ACTUALLY exists on-chain (not what frontend thinks)
  const poolActuallyExistsOnChain = slippagePoolInstance !== null;
  const frontendThinksPoolIsNew = !!(initialPrice && initialDependentAmount);

  // For logging/debugging
  if (frontendThinksPoolIsNew && poolActuallyExistsOnChain) {
    log.info({
      frontendTick: poolInstance.tickCurrent,
      onChainTick: slippagePoolInstance!.tickCurrent,
    }, 'Frontend thinks pool is new but it exists on-chain - recalculating amounts');
  }

  // Calculate amounts - ALWAYS use on-chain pool state if available
  let amount0Raw: string, amount1Raw: string;

  // Use on-chain pool for calculation, fallback to frontend pool only for truly new pools
  const poolForCalculation = poolForSlippage;

  // Determine which token is JUSD for conversions
  const isToken0Jusd = token0Addr.toLowerCase() === contracts.JUSD.toLowerCase();
  const isToken1Jusd = token1Addr.toLowerCase() === contracts.JUSD.toLowerCase();

  // Only use frontend amounts if pool truly doesn't exist on-chain
  if (frontendThinksPoolIsNew && !poolActuallyExistsOnChain) {
    // Truly new pool - recalculate dependent amount using svJUSD share price
    // The frontend sends JUSD amounts, but we need to calculate based on svJUSD pool price

    // Convert independent amount from JUSD to svJUSD for calculation
    let internalIndependentAmount = independentAmount;
    if ((independentIsToken0 && isToken0Jusd) || (!independentIsToken0 && isToken1Jusd)) {
      internalIndependentAmount = await juiceGatewayService.jusdToSvJusd(chainId as ChainId, independentAmount);
    }

    // Calculate dependent amount using the mock pool (with initialPrice)
    let positionCalc: Position;
    if (independentIsToken0) {
      positionCalc = Position.fromAmount0({
        pool: poolInstance, // Use the mock pool with initialPrice
        tickLower,
        tickUpper,
        amount0: JSBI.BigInt(internalIndependentAmount),
        useFullPrecision: false,
      });

      // Convert dependent amount (svJUSD) back to JUSD
      let dependentAmount = positionCalc.amount1.quotient.toString();
      if (isToken1Jusd) {
        dependentAmount = await juiceGatewayService.svJusdToJusd(chainId as ChainId, dependentAmount);
      }

      amount0Raw = independentAmount; // User's JUSD amount
      amount1Raw = dependentAmount;
    } else {
      positionCalc = Position.fromAmount1({
        pool: poolInstance, // Use the mock pool with initialPrice
        tickLower,
        tickUpper,
        amount1: JSBI.BigInt(internalIndependentAmount),
      });

      // Convert dependent amount (svJUSD) back to JUSD
      let dependentAmount = positionCalc.amount0.quotient.toString();
      if (isToken0Jusd) {
        dependentAmount = await juiceGatewayService.svJusdToJusd(chainId as ChainId, dependentAmount);
      }

      amount0Raw = dependentAmount;
      amount1Raw = independentAmount; // User's JUSD amount
    }

    log.info({
      originalDependentAmount: initialDependentAmount,
      correctedDependentAmount: independentIsToken0 ? amount1Raw : amount0Raw,
      isToken0Jusd,
      isToken1Jusd,
    }, 'Recalculated dependent amount for new JUSD pool using svJUSD share price');
  } else {
    // Pool exists on-chain (or frontend knows it exists) - calculate based on on-chain price
    let internalIndependentAmount = independentAmount;

    // Convert JUSD to svJUSD for position calculation
    if ((independentIsToken0 && isToken0Jusd) || (!independentIsToken0 && isToken1Jusd)) {
      internalIndependentAmount = await juiceGatewayService.jusdToSvJusd(chainId as ChainId, independentAmount);
    }

    let positionCalc: Position;

    if (independentIsToken0) {
      positionCalc = Position.fromAmount0({
        pool: poolForCalculation,  // Use on-chain pool!
        tickLower,
        tickUpper,
        amount0: JSBI.BigInt(internalIndependentAmount),
        useFullPrecision: false,
      });

      // Convert dependent amount back to JUSD if token1 is JUSD
      let dependentAmount = positionCalc.amount1.quotient.toString();
      if (isToken1Jusd) {
        dependentAmount = await juiceGatewayService.svJusdToJusd(chainId as ChainId, dependentAmount);
      }

      amount0Raw = independentAmount; // User's JUSD amount
      amount1Raw = dependentAmount;
    } else {
      positionCalc = Position.fromAmount1({
        pool: poolForCalculation,  // Use on-chain pool!
        tickLower,
        tickUpper,
        amount1: JSBI.BigInt(internalIndependentAmount),
      });

      // Convert dependent amount back to JUSD if token0 is JUSD
      let dependentAmount = positionCalc.amount0.quotient.toString();
      if (isToken0Jusd) {
        dependentAmount = await juiceGatewayService.svJusdToJusd(chainId as ChainId, dependentAmount);
      }

      amount0Raw = dependentAmount;
      amount1Raw = independentAmount; // User's JUSD amount
    }
  }

  // Create Position instance for proper slippage calculation
  // Use internal token amounts (svJUSD) for the position
  // Note: isToken0Jusd and isToken1Jusd are defined above

  // Convert user amounts (JUSD) to internal amounts (svJUSD) for position calculation
  const internalAmount0 = isToken0Jusd
    ? await juiceGatewayService.jusdToSvJusd(chainId as ChainId, amount0Raw)
    : amount0Raw;
  const internalAmount1 = isToken1Jusd
    ? await juiceGatewayService.jusdToSvJusd(chainId as ChainId, amount1Raw)
    : amount1Raw;

  const internalAmount0CA = CurrencyAmount.fromRawAmount(internalPoolToken0, internalAmount0);
  const internalAmount1CA = CurrencyAmount.fromRawAmount(internalPoolToken1, internalAmount1);

  const positionForSlippage = Position.fromAmounts({
    pool: poolForSlippage,
    tickLower,
    tickUpper,
    amount0: internalAmount0CA.quotient,
    amount1: internalAmount1CA.quotient,
    useFullPrecision: false,
  });

  // Use SDK's slippage calculation - this accounts for current pool price
  const slippageBps = body.slippageTolerance
    ? Math.round(parseFloat(body.slippageTolerance) * 100)
    : 50; // 0.5% default (consistent with other LP operations)
  const slippageTolerance = new Percent(slippageBps, 10_000);
  const { amount0: internalAmount0Min, amount1: internalAmount1Min } =
    positionForSlippage.mintAmountsWithSlippage(slippageTolerance);

  // Convert mins back to user-facing tokens (JUSD) for Gateway
  const amount0Min = isToken0Jusd
    ? await juiceGatewayService.svJusdToJusd(chainId as ChainId, internalAmount0Min.toString())
    : internalAmount0Min.toString();
  const amount1Min = isToken1Jusd
    ? await juiceGatewayService.svJusdToJusd(chainId as ChainId, internalAmount1Min.toString())
    : internalAmount1Min.toString();

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

  const calldata = juiceGatewayService.buildGatewayAddLiquidityCalldata({
    tokenA: position.pool.token0 === ADDRESS_ZERO ? ADDRESS_ZERO : token0Addr,
    tokenB: position.pool.token1 === ADDRESS_ZERO ? ADDRESS_ZERO : token1Addr,
    fee: position.pool.fee,
    tickLower,
    tickUpper,
    amountADesired: amount0Raw,
    amountBDesired: amount1Raw,
    amountAMin: amount0Min,
    amountBMin: amount1Min,
    recipient: walletAddress,
    deadline,
  });

  // Calculate value for native token (cBTC)
  const nativeValue = calculateTxValue(position.pool.token0, amount0Raw, position.pool.token1, amount1Raw);

  // Estimate gas
  const feeData = await provider.getFeeData();
  const isActuallyNewPool = frontendThinksPoolIsNew && !poolActuallyExistsOnChain;

  // Build createPool transaction if pool doesn't exist on-chain
  // For Gateway flow, we need to create the svJUSD pool on the PositionManager first,
  // then the Gateway.addLiquidity() call will mint into that pool
  let createPoolTx: {
    to: string;
    from: string;
    data: string;
    value: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gasLimit: string;
    chainId: number;
  } | undefined;

  if (isActuallyNewPool && initialPrice) {
    // Build createAndInitializePoolIfNecessary calldata using internal tokens (svJUSD)
    const { calldata: createPoolCalldata, value: createPoolValue } =
      NonfungiblePositionManager.createCallParameters(poolInstance);

    // Estimate gas for pool creation
    let createPoolGasEstimate = ethers.BigNumber.from('650000');
    try {
      createPoolGasEstimate = await provider.estimateGas({
        to: positionManagerAddress,
        from: walletAddress,
        data: createPoolCalldata,
        value: createPoolValue || '0x0',
      });
    } catch (e) {
      log.warn({ error: e }, 'Gas estimation failed for createPool, using fallback');
    }

    let createPoolGasLimit = createPoolGasEstimate.mul(156).div(100);
    createPoolGasLimit = capGasLimitForCitrea(createPoolGasLimit, chainId, log);
    const baseFeeForCreatePool = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('0.00000136', 'gwei');
    const maxPriorityFeeForCreatePool = ethers.utils.parseUnits('1', 'gwei');
    const maxFeeForCreatePool = baseFeeForCreatePool.mul(105).div(100).add(maxPriorityFeeForCreatePool);

    createPoolTx = {
      to: positionManagerAddress,
      from: walletAddress,
      data: createPoolCalldata,
      value: createPoolValue?.toString() || '0x0',
      maxFeePerGas: maxFeeForCreatePool.toHexString(),
      maxPriorityFeePerGas: maxPriorityFeeForCreatePool.toHexString(),
      gasLimit: createPoolGasLimit.toHexString(),
      chainId,
    };

    log.info({
      internalToken0,
      internalToken1,
      fee: position.pool.fee,
      sqrtPriceX96: initialPrice,
    }, 'Building createPool transaction for new svJUSD pool');
  }

  let gasEstimate = isActuallyNewPool ? ethers.BigNumber.from('1040000') : ethers.BigNumber.from('650000');

  try {
    // Only estimate gas for Gateway tx if pool exists or will be created first
    // If pool creation is needed, we may not be able to estimate the addLiquidity call yet
    if (!isActuallyNewPool) {
      gasEstimate = await provider.estimateGas({
        to: gatewayAddress,
        from: walletAddress,
        data: calldata,
        value: nativeValue,
      });
    }
  } catch (e) {
    log.warn({ error: e }, 'Gas estimation failed for Gateway LP, using fallback');
  }

  let gasLimit = gasEstimate.mul(156).div(100);
  gasLimit = capGasLimitForCitrea(gasLimit, chainId, log);

  const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('0.00000136', 'gwei');
  const maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei');
  const maxFeePerGas = baseFee.mul(105).div(100).add(maxPriorityFeePerGas);
  const gasFee = gasLimit.mul(maxFeePerGas);

  // Get svJUSD share price for frontend validation
  const svJusdSharePrice = await juiceGatewayService.svJusdToJusd(chainId as ChainId, ethers.utils.parseEther('1').toString());

  const response: Record<string, unknown> = {
    requestId: `lp-create-gateway-${Date.now()}`,
    create: {
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
    _routingType: 'GATEWAY_LP',
    _note: 'LP routed through JuiceSwapGateway. JUSD will be converted to svJUSD internally for capital efficiency.',
  };

  // Add createPool transaction if pool needs to be created first
  if (createPoolTx) {
    response.createPool = createPoolTx;
    response._note = 'New pool detected. Execute createPool transaction first, then the Gateway addLiquidity transaction.';
  }

  res.status(200).json(response);

  log.debug({
    chainId,
    walletAddress,
    routingType: 'GATEWAY_LP',
    token0: token0Addr,
    token1: token1Addr,
  }, 'Gateway LP create request completed');
}
