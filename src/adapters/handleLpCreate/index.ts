import { Request, Response } from "express"
import { LpCreateResponseBody, LpCreateRequestBody } from "./types"
import { getGlobalRpcProvider } from "../../services/globalRcpProvider"
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES } from "@juiceswapxyz/sdk-core"
import {
  NonfungiblePositionManager,
  Position,
  Pool,
  nearestUsableTick,
  TickMath,
  priceToClosestTick,
} from "@juiceswapxyz/v3-sdk"
import { Token, CurrencyAmount, Percent, Price } from "@juiceswapxyz/sdk-core"
import JSBI from "jsbi"
import { ethers } from "ethers"

const ERC20_ABI = ["function decimals() view returns (uint8)"]
const NPM_IFACE = new ethers.utils.Interface([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
])

const TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
}

export async function handleLpCreate(req: Request, res: Response): Promise<void> {
  try {
    const {
      walletAddress,
      chainId,
      independentAmount,
      independentToken,            // "TOKEN_0" | "TOKEN_1"
      initialDependentAmount,
      initialPrice,                // token1 per 1 token0 (string)
      position,                    // { pool: { token0, token1, fee, tickSpacing? }, tickLower, tickUpper }
    }: LpCreateRequestBody = req.body

    if (
      !walletAddress ||
      !chainId ||
      !independentAmount ||
      !independentToken ||
      !initialDependentAmount ||
      !initialPrice ||
      !position ||
      !position?.pool?.token0 ||
      !position?.pool?.token1 ||
      position?.pool?.fee === undefined ||
      position?.tickLower === undefined ||
      position?.tickUpper === undefined
    ) {
      res.status(400).json({ message: "Missing required fields", error: "MissingRequiredFields" })
      return
    }

    const provider = getGlobalRpcProvider(chainId)
    if (!provider) {
      res.status(400).json({ message: "Invalid chainId", error: "InvalidChainId" })
      return
    }

    const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId]
    if (!positionManagerAddress) {
      res.status(400).json({ message: "Unsupported chain for LP operations", error: "UnsupportedChain" })
      return
    }

    const token0Addr = ethers.utils.getAddress(position.pool.token0)
    const token1Addr = ethers.utils.getAddress(position.pool.token1)
    if (token0Addr.toLowerCase() >= token1Addr.toLowerCase()) {
      res.status(400).json({ message: "token0 must be < token1 by address", error: "TokenOrderInvalid" })
      return
    }

    const [dec0, dec1] = await Promise.all([
      new ethers.Contract(token0Addr, ERC20_ABI, provider).decimals(),
      new ethers.Contract(token1Addr, ERC20_ABI, provider).decimals(),
    ])

    const token0 = new Token(chainId, token0Addr, dec0)
    const token1 = new Token(chainId, token1Addr, dec1)

    const oneT0 = ethers.utils.parseUnits("1", dec0)
    const pT1   = ethers.utils.parseUnits(initialPrice, dec1)
    const initPrice = new Price(token0, token1, oneT0.toString(), pT1.toString())
    const tickCurrent = priceToClosestTick(initPrice)
    const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tickCurrent)

    const spacing = TICK_SPACING[position.pool.fee] ?? position.pool.tickSpacing
    if (spacing === undefined) {
      res.status(400).json({ message: "Unsupported fee tier", error: "UnsupportedFee" })
      return
    }

    const poolInstance = new Pool(
      token0,
      token1,
      position.pool.fee,
      sqrtPriceX96.toString(),
      "0",
      tickCurrent
    )

    const independentIsToken0 = independentToken === "TOKEN_0"
    const amount0Raw = independentIsToken0
      ? ethers.utils.parseUnits(independentAmount, dec0)
      : ethers.utils.parseUnits(initialDependentAmount, dec0)
    const amount1Raw = independentIsToken0
      ? ethers.utils.parseUnits(initialDependentAmount, dec1)
      : ethers.utils.parseUnits(independentAmount, dec1)

    const amount0 = CurrencyAmount.fromRawAmount(token0, amount0Raw.toString())
    const amount1 = CurrencyAmount.fromRawAmount(token1, amount1Raw.toString())

    const tickLower = nearestUsableTick(position.tickLower, spacing)
    const tickUpper = nearestUsableTick(position.tickUpper, spacing)
    if (tickLower >= tickUpper) {
      res.status(400).json({ message: "Invalid tick range: tickLower < tickUpper", error: "InvalidTickRange" })
      return
    }
    if (JSBI.equal(amount0.quotient, JSBI.BigInt(0)) && JSBI.equal(amount1.quotient, JSBI.BigInt(0))) {
      res.status(400).json({ message: "Both token amounts cannot be zero", error: "InvalidAmounts" })
      return
    }

    const positionInstance = Position.fromAmounts({
      pool: poolInstance,
      tickLower,
      tickUpper,
      amount0: amount0.quotient,
      amount1: amount1.quotient,
      useFullPrecision: false,
    })

    const slippageTolerance = new Percent(50, 10_000)
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20

    const { calldata: createCD, value: createVal } =
      NonfungiblePositionManager.createCallParameters(poolInstance)
    const { calldata: mintCD, value: mintVal } =
      NonfungiblePositionManager.addCallParameters(positionInstance, {
        recipient: walletAddress,
        deadline,
        slippageTolerance,
      })

    const multicallData = NPM_IFACE.encodeFunctionData("multicall", [[createCD, mintCD]])
    const totalValueBN = ethers.BigNumber.from(createVal || "0").add(ethers.BigNumber.from(mintVal || "0"))
    const totalValueHex = totalValueBN.toHexString()

  
    const gasLimit = ethers.BigNumber.from("7000000")
    const maxFeePerGas = ethers.utils.parseUnits("1", "gwei")
    const maxPriorityFeePerGas = ethers.utils.parseUnits("0.1", "gwei")
    const gasFee = gasLimit.mul(maxFeePerGas)

    const response: LpCreateResponseBody = {
      requestId: `lp-create-${Date.now()}`,
      create: {
        to: positionManagerAddress,
        from: walletAddress,
        data: multicallData,                 // single blob: create+init+mint
        value: totalValueHex,
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        gasLimit: gasLimit.toString(),
        chainId,
      },
      dependentAmount: independentIsToken0 ? amount1.toExact() : amount0.toExact(),
      gasFee: ethers.utils.formatEther(gasFee),
    }

    res.status(200).json(response)
  } catch (error: any) {
    res.status(500).json({ message: "Internal server error", error: error?.message })
  }
}
