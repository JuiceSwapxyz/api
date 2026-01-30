/**
 * Deploy svJUSD Liquidity Pools for Gateway Integration
 *
 * This script creates and initializes V3 pools for svJUSD pairs on Citrea Testnet.
 * These pools are required for the JuiceSwapGateway to route JUSD swaps internally.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-svjusd-pools.ts
 *
 * Prerequisites:
 *   - Deployer wallet must have cBTC for gas
 *   - Deployer wallet must have svJUSD and counterpart tokens for liquidity
 *   - Token approvals for NonfungiblePositionManager
 */

import { ethers } from "ethers";
import {
  Token,
  CurrencyAmount,
  Percent,
  NONFUNGIBLE_POSITION_MANAGER_ADDRESSES,
  CHAIN_TO_ADDRESSES_MAP,
  WETH9,
  ChainId,
} from "@juiceswapxyz/sdk-core";
import {
  Pool,
  Position,
  NonfungiblePositionManager,
  TickMath,
  nearestUsableTick,
  FeeAmount,
  encodeSqrtRatioX96,
} from "@juiceswapxyz/v3-sdk";
import { ADDRESS } from "@juicedollar/jusd";
import JSBI from "jsbi";

// ============================================
// Configuration
// ============================================

const CHAIN_ID = ChainId.CITREA_TESTNET;
const RPC_URL = "https://rpc.testnet.citreascan.com";

// Get JuiceDollar addresses from package (single source of truth)
const JUSD_ADDRESSES = ADDRESS[CHAIN_ID];

// Token addresses on Citrea Testnet
const TOKENS = {
  SV_JUSD: JUSD_ADDRESSES.savingsVaultJUSD,
  // WcBTC from SDK WETH9 - single source of truth
  WCBTC: WETH9[CHAIN_ID]?.address ?? "",
  NUSD: "0x9B28B690550522608890C3C7e63c0b4A7eBab9AA",
  USDC: "0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F",
  TFC: "0x14ADf6B87096Ef750a956756BA191fc6BE94e473",
  MTK: "0x6434B863529F585633A1A71a9bfe9bbd7119Dd25",
};

// Token decimals
const DECIMALS: Record<string, number> = {
  [TOKENS.SV_JUSD]: 18,
  [TOKENS.WCBTC]: 18,
  [TOKENS.NUSD]: 18,
  [TOKENS.USDC]: 6,
  [TOKENS.TFC]: 18,
  [TOKENS.MTK]: 18,
};

// Pools to deploy (svJUSD paired with various tokens)
// Format: [tokenB, initialPrice (tokenB per svJUSD), liquidityAmount in svJUSD]
const POOLS_TO_DEPLOY = [
  {
    name: "svJUSD/WCBTC",
    tokenB: TOKENS.WCBTC,
    // 1 svJUSD = 0.00001 WCBTC (i.e., 1 BTC = 100,000 JUSD)
    priceRatio: 0.00001,
    svJusdAmount: "10000", // 10,000 svJUSD
    fee: FeeAmount.MEDIUM,
  },
  {
    name: "svJUSD/NUSD",
    tokenB: TOKENS.NUSD,
    // 1 svJUSD ≈ 1 NUSD (stablecoin pair)
    priceRatio: 1.0,
    svJusdAmount: "10000", // 10,000 svJUSD
    fee: FeeAmount.MEDIUM,
  },
  {
    name: "svJUSD/USDC",
    tokenB: TOKENS.USDC,
    // 1 svJUSD ≈ 1 USDC (stablecoin pair)
    priceRatio: 1.0,
    svJusdAmount: "10000", // 10,000 svJUSD
    fee: FeeAmount.MEDIUM,
  },
];

// ABIs
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address)",
];

const POOL_ABI = [
  "function initialize(uint160 sqrtPriceX96)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const NPM_ABI = [
  "function multicall(bytes[] data) payable returns (bytes[] results)",
];

// ============================================
// Helper Functions
// ============================================

function sortTokens(tokenA: string, tokenB: string): [string, string] {
  return tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [tokenA, tokenB]
    : [tokenB, tokenA];
}

function calculateSqrtPriceX96(
  price: number,
  token0Decimals: number,
  token1Decimals: number,
): JSBI {
  // price = token1 / token0
  // Adjust for decimals: adjustedPrice = price * 10^(token0Decimals - token1Decimals)
  const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
  const adjustedPrice = price * decimalAdjustment;

  // sqrtPriceX96 = sqrt(price) * 2^96
  const sqrtPrice = Math.sqrt(adjustedPrice);
  const sqrtPriceX96 = sqrtPrice * Math.pow(2, 96);

  return JSBI.BigInt(Math.floor(sqrtPriceX96).toString());
}

async function getTokenBalance(
  token: ethers.Contract,
  address: string,
): Promise<string> {
  const balance = await token.balanceOf(address);
  const decimals = await token.decimals();
  return ethers.utils.formatUnits(balance, decimals);
}

async function ensureApproval(
  token: ethers.Contract,
  spender: string,
  amount: ethers.BigNumber,
  signer: ethers.Wallet,
): Promise<void> {
  const symbol = await token.symbol();
  const allowance = await token.allowance(signer.address, spender);

  if (allowance.lt(amount)) {
    console.log(`  Approving ${symbol} for NonfungiblePositionManager...`);
    const tx = await token
      .connect(signer)
      .approve(spender, ethers.constants.MaxUint256);
    await tx.wait();
    console.log(`  ✓ Approved ${symbol}`);
  } else {
    console.log(`  ✓ ${symbol} already approved`);
  }
}

// ============================================
// Main Deployment Logic
// ============================================

async function deployPool(
  poolConfig: (typeof POOLS_TO_DEPLOY)[0],
  provider: ethers.providers.JsonRpcProvider,
  signer: ethers.Wallet,
  factory: ethers.Contract,
  positionManager: string,
): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying: ${poolConfig.name}`);
  console.log("=".repeat(60));

  // Sort tokens (V3 requires token0 < token1 by address)
  const [token0Addr, token1Addr] = sortTokens(
    TOKENS.SV_JUSD,
    poolConfig.tokenB,
  );
  const isSvJusdToken0 =
    token0Addr.toLowerCase() === TOKENS.SV_JUSD.toLowerCase();

  const token0Decimals = DECIMALS[token0Addr];
  const token1Decimals = DECIMALS[token1Addr];

  console.log(`Token0: ${token0Addr} (${token0Decimals} decimals)`);
  console.log(`Token1: ${token1Addr} (${token1Decimals} decimals)`);
  console.log(`svJUSD is token${isSvJusdToken0 ? "0" : "1"}`);

  // Create Token objects
  const token0 = new Token(CHAIN_ID, token0Addr, token0Decimals);
  const token1 = new Token(CHAIN_ID, token1Addr, token1Decimals);

  // Calculate price
  // priceRatio = tokenB per svJUSD
  // If svJUSD is token0: price = token1/token0 = tokenB/svJUSD = priceRatio
  // If svJUSD is token1: price = token1/token0 = svJUSD/tokenB = 1/priceRatio
  const price = isSvJusdToken0
    ? poolConfig.priceRatio
    : 1 / poolConfig.priceRatio;
  const sqrtPriceX96 = calculateSqrtPriceX96(
    price,
    token0Decimals,
    token1Decimals,
  );

  console.log(`\nPrice ratio: ${price} (token1 per token0)`);
  console.log(`sqrtPriceX96: ${sqrtPriceX96.toString()}`);

  // Check if pool exists
  const existingPool = await factory.getPool(
    token0Addr,
    token1Addr,
    poolConfig.fee,
  );

  if (existingPool !== ethers.constants.AddressZero) {
    console.log(`\n⚠ Pool already exists at ${existingPool}`);

    // Check if initialized
    const poolContract = new ethers.Contract(existingPool, POOL_ABI, provider);
    try {
      const slot0 = await poolContract.slot0();
      if (slot0.sqrtPriceX96.toString() !== "0") {
        console.log(
          `✓ Pool is already initialized (sqrtPriceX96: ${slot0.sqrtPriceX96.toString()})`,
        );
        console.log(`  Current tick: ${slot0.tick}`);
        return;
      } else {
        console.log("Pool exists but not initialized. Initializing...");
        const initTx = await poolContract
          .connect(signer)
          .initialize(sqrtPriceX96.toString());
        await initTx.wait();
        console.log("✓ Pool initialized");
      }
    } catch (e) {
      console.log("Error checking pool state:", e);
    }
    return;
  }

  // Create pool via factory
  console.log("\nCreating pool...");
  const createTx = await factory
    .connect(signer)
    .createPool(token0Addr, token1Addr, poolConfig.fee);
  const createReceipt = await createTx.wait();
  console.log(`✓ Pool created (tx: ${createReceipt.transactionHash})`);

  // Get pool address
  const poolAddress = await factory.getPool(
    token0Addr,
    token1Addr,
    poolConfig.fee,
  );
  console.log(`Pool address: ${poolAddress}`);

  // Initialize pool with price
  console.log("\nInitializing pool with price...");
  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const initTx = await poolContract.initialize(sqrtPriceX96.toString());
  await initTx.wait();
  console.log("✓ Pool initialized");

  // Get current tick from pool
  const slot0 = await poolContract.slot0();
  const currentTick = slot0.tick;
  console.log(`Current tick: ${currentTick}`);

  // Prepare to add liquidity
  console.log("\nPreparing liquidity position...");

  // Create Pool instance
  const pool = new Pool(
    token0,
    token1,
    poolConfig.fee,
    sqrtPriceX96.toString(),
    "0", // liquidity starts at 0
    currentTick,
  );

  // Calculate tick range (full range for simplicity)
  const tickSpacing =
    poolConfig.fee === FeeAmount.MEDIUM
      ? 60
      : poolConfig.fee === FeeAmount.HIGH
        ? 200
        : 10;
  const tickLower = nearestUsableTick(TickMath.MIN_TICK, tickSpacing);
  const tickUpper = nearestUsableTick(TickMath.MAX_TICK, tickSpacing);

  console.log(`Tick range: ${tickLower} to ${tickUpper}`);

  // Calculate amounts
  const svJusdAmountRaw = ethers.utils.parseUnits(poolConfig.svJusdAmount, 18);

  // For the counterpart token, calculate based on price
  const tokenBAmountRaw = ethers.utils.parseUnits(
    (parseFloat(poolConfig.svJusdAmount) * poolConfig.priceRatio).toFixed(
      DECIMALS[poolConfig.tokenB],
    ),
    DECIMALS[poolConfig.tokenB],
  );

  const amount0 = isSvJusdToken0 ? svJusdAmountRaw : tokenBAmountRaw;
  const amount1 = isSvJusdToken0 ? tokenBAmountRaw : svJusdAmountRaw;

  console.log(`Amount0: ${ethers.utils.formatUnits(amount0, token0Decimals)}`);
  console.log(`Amount1: ${ethers.utils.formatUnits(amount1, token1Decimals)}`);

  // Check balances
  const token0Contract = new ethers.Contract(token0Addr, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1Addr, ERC20_ABI, provider);

  const balance0 = await token0Contract.balanceOf(signer.address);
  const balance1 = await token1Contract.balanceOf(signer.address);

  console.log(`\nWallet balances:`);
  console.log(
    `  Token0: ${ethers.utils.formatUnits(balance0, token0Decimals)}`,
  );
  console.log(
    `  Token1: ${ethers.utils.formatUnits(balance1, token1Decimals)}`,
  );

  if (balance0.lt(amount0) || balance1.lt(amount1)) {
    console.log(
      "\n⚠ Insufficient balance for liquidity. Skipping liquidity addition.",
    );
    console.log(
      "  Pool is created and initialized - add liquidity manually when ready.",
    );
    return;
  }

  // Ensure approvals
  console.log("\nChecking approvals...");
  await ensureApproval(token0Contract, positionManager, amount0, signer);
  await ensureApproval(token1Contract, positionManager, amount1, signer);

  // Create position
  const position = Position.fromAmounts({
    pool,
    tickLower,
    tickUpper,
    amount0: JSBI.BigInt(amount0.toString()),
    amount1: JSBI.BigInt(amount1.toString()),
    useFullPrecision: false,
  });

  // Build mint parameters
  const { calldata: createCalldata } =
    NonfungiblePositionManager.createCallParameters(pool);
  const { calldata: mintCalldata } =
    NonfungiblePositionManager.addCallParameters(position, {
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 60 * 20,
      slippageTolerance: new Percent(50, 10_000), // 0.5%
    });

  // Multicall: create + mint
  const npmContract = new ethers.Contract(positionManager, NPM_ABI, signer);

  console.log("\nAdding liquidity...");
  const multicallTx = await npmContract.multicall([
    createCalldata,
    mintCalldata,
  ]);
  const receipt = await multicallTx.wait();
  console.log(`✓ Liquidity added (tx: ${receipt.transactionHash})`);
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     svJUSD Pool Deployment Script - Citrea Testnet         ║");
  console.log(
    "╚════════════════════════════════════════════════════════════╝\n",
  );

  // Check for private key
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("ERROR: DEPLOYER_PRIVATE_KEY environment variable not set");
    console.error(
      "Usage: DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-svjusd-pools.ts",
    );
    process.exit(1);
  }

  // Setup provider and signer
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(privateKey, provider);

  console.log(`Deployer address: ${signer.address}`);

  // Check deployer balance
  const balance = await provider.getBalance(signer.address);
  console.log(
    `Deployer cBTC balance: ${ethers.utils.formatEther(balance)} cBTC`,
  );

  if (balance.lt(ethers.utils.parseEther("0.001"))) {
    console.error(
      "\nERROR: Insufficient cBTC for gas. Please fund the deployer wallet.",
    );
    process.exit(1);
  }

  // Get contract addresses from sdk-core
  const chainAddresses =
    CHAIN_TO_ADDRESSES_MAP[CHAIN_ID as keyof typeof CHAIN_TO_ADDRESSES_MAP];
  if (!chainAddresses) {
    console.error(
      `ERROR: Chain ${CHAIN_ID} not found in CHAIN_TO_ADDRESSES_MAP`,
    );
    process.exit(1);
  }

  const factoryAddress = chainAddresses.v3CoreFactoryAddress;
  const positionManagerAddress =
    NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[CHAIN_ID];

  console.log(`\nV3 Factory: ${factoryAddress}`);
  console.log(`Position Manager: ${positionManagerAddress}`);

  // Create factory contract
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

  // Check token balances
  console.log("\n--- Token Balances ---");
  for (const [name, address] of Object.entries(TOKENS)) {
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const bal = await getTokenBalance(token, signer.address);
    console.log(`${name}: ${bal}`);
  }

  // Deploy each pool
  for (const poolConfig of POOLS_TO_DEPLOY) {
    try {
      await deployPool(
        poolConfig,
        provider,
        signer,
        factory,
        positionManagerAddress,
      );
    } catch (error) {
      console.error(`\nERROR deploying ${poolConfig.name}:`, error);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Deployment complete!");
  console.log("=".repeat(60));

  // Verify pools
  console.log("\n--- Pool Verification ---");
  for (const poolConfig of POOLS_TO_DEPLOY) {
    const [token0, token1] = sortTokens(TOKENS.SV_JUSD, poolConfig.tokenB);
    const poolAddress = await factory.getPool(token0, token1, poolConfig.fee);

    if (poolAddress !== ethers.constants.AddressZero) {
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
      try {
        const slot0 = await poolContract.slot0();
        const initialized = slot0.sqrtPriceX96.toString() !== "0";
        console.log(
          `${poolConfig.name}: ${poolAddress} (${initialized ? "✓ initialized" : "✗ not initialized"})`,
        );
      } catch {
        console.log(
          `${poolConfig.name}: ${poolAddress} (? error reading slot0)`,
        );
      }
    } else {
      console.log(`${poolConfig.name}: NOT DEPLOYED`);
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
