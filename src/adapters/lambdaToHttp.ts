import type { APIGatewayProxyEvent, Context, APIGatewayProxyResult } from 'aws-lambda'
import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { ADDRESS_ZERO } from '@juiceswapxyz/v3-sdk'

// Temporary: Define wrapped native tokens for chains
// TODO: Import WETH9 from SDK once build issues are resolved
const WRAPPED_NATIVE_TOKENS: { [chainId: number]: { address: string; symbol: string } } = {
  1: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH' }, // Mainnet
  5115: { address: '0x4370e27F7d91D9341bFf232d7Ee8bdfE3a9933a0', symbol: 'WcBTC' }, // Citrea Testnet
  11155111: { address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', symbol: 'WETH' }, // Sepolia
  // Add other chains as needed
}

function transformTradingApiRequest(body: any, query: any): any {
  let queryParams = { ...query }

  if (body) {
    const SUPPORTED_PROTOCOLS = ['v3']
    const tokenIn = body.tokenIn || body.tokenInAddress
    const tokenOut = body.tokenOut || body.tokenOutAddress

    queryParams.tokenInAddress = tokenIn ===  ADDRESS_ZERO? WETH9[body.tokenInChainId].address : tokenIn
    queryParams.tokenOutAddress = tokenOut === ADDRESS_ZERO ? WETH9[body.tokenOutChainId].address : tokenOut
    queryParams.tokenInChainId = body.tokenInChainId
    queryParams.tokenOutChainId = body.tokenOutChainId
    queryParams.amount = body.amount
    queryParams.type = body.type === 'EXACT_OUTPUT' ? 'exactOut' : body.type === 'EXACT_INPUT' ? 'exactIn' : body.type
    if (body.swapper) queryParams.swapper = body.swapper
    if (body.protocols) {
      // Filter to only supported routing API protocols
      const supportedProtocols = body.protocols
        .map((p: string) => p.toLowerCase())
        .filter((p: string) => SUPPORTED_PROTOCOLS.includes(p))
      queryParams.protocols = supportedProtocols.join(',')
    }
  }

  return queryParams
}

export function lambdaToExpress(
  handler: (event: APIGatewayProxyEvent, context: Context) => Promise<APIGatewayProxyResult>
) {
  return async (req: Request, res: Response) => {
    try {
      const queryParams = transformTradingApiRequest(req.body, req.query)

      // Minimal event object with only the fields actually used by handlers
      const event: APIGatewayProxyEvent = {
        body: null,
        queryStringParameters: queryParams,
        headers: req.headers as any,
        // Unused by handlers but required by type
        httpMethod: req.method,
        path: req.path,
        resource: req.path,
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        multiValueHeaders: {},
        multiValueQueryStringParameters: null,
        isBase64Encoded: false,
      }

      const context: Context = {
        awsRequestId: req.headers['x-request-id']?.toString() || randomUUID(),
        callbackWaitsForEmptyEventLoop: false,
        functionName: 'routing-api-local',
        functionVersion: '1',
        invokedFunctionArn: 'arn:aws:lambda:local:0:function:routing-api',
        memoryLimitInMB: '512',
        logGroupName: '/aws/lambda/routing-api-local',
        logStreamName: 'local',
        getRemainingTimeInMillis: () => 30000,
        done: () => undefined,
        fail: () => undefined,
        succeed: () => undefined,
      }

      const result = await handler(event, context)

      // Apply URA (Unified Routing API) wrapper format if this is a quote response
      let responseBody = result.body || ''
      if (result.statusCode === 200 && responseBody) {
        try {
          const routingApiResponse = JSON.parse(responseBody)
          if(req.body.swapper) routingApiResponse.swapper = req.body.swapper

          // Check if this is a wrap/unwrap operation
          const tokenIn = req.body.tokenIn || req.body.tokenInAddress
          const tokenOut = req.body.tokenOut || req.body.tokenOutAddress
          const isNativeIn = tokenIn === ADDRESS_ZERO || tokenIn === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
          const isNativeOut = tokenOut === ADDRESS_ZERO || tokenOut === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
          const wrappedToken = WETH9[req.body.tokenInChainId]

          let routing = 'CLASSIC'
          if (wrappedToken) {
            const wrappedAddress = wrappedToken.address.toLowerCase()
            if (isNativeIn && tokenOut?.toLowerCase() === wrappedAddress) {
              routing = 'WRAP'
            } else if (tokenIn?.toLowerCase() === wrappedAddress && isNativeOut) {
              routing = 'UNWRAP'
            }
          }

          // Wrap in URA format expected by frontend
          const uraResponse = {
            routing,
            quote: routingApiResponse,
            allQuotes: [
              {
                routing,
                quote: routingApiResponse
              }
            ]
          }
          responseBody = JSON.stringify(uraResponse)
        } catch (e) {
          // If parsing fails, send original response
        }
      }

      // Write result back
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (v !== undefined) res.setHeader(k, v as string)
        }
      }

      res.status(result.statusCode || 200)
      res.send(responseBody)
    } catch (err: any) {
      res.status(502).json({ message: 'Internal server error', error: err?.message })
    }
  }
}
