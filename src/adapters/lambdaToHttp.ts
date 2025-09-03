import type { APIGatewayProxyEvent, Context, APIGatewayProxyResult } from 'aws-lambda';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';

export function lambdaToExpress(handler: (
  event: APIGatewayProxyEvent,
  context: Context
) => Promise<APIGatewayProxyResult>) {
  return async (req: Request, res: Response) => {
    try {
      // Minimal event object with only the fields actually used by handlers
      const event: APIGatewayProxyEvent = {
        body: req.body ? JSON.stringify(req.body) : null,
        queryStringParameters: req.query as any,
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
      };

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
      };

      const result = await handler(event, context);

      // Write result back
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (v !== undefined) res.setHeader(k, v as string);
        }
      }

      res.status(result.statusCode || 200);
      res.send(result.body || '');
    } catch (err: any) {
      res.status(502).json({ message: 'Internal server error', error: err?.message });
    }
  };
}