import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'JuiceSwap Routing API',
      version: '1.0.0',
      description: 'Citrea DEX routing and quoting API',
      contact: {
        name: 'JuiceSwap',
        url: 'https://juiceswap.com',
      },
      license: {
        name: 'GPL-3.0',
        url: 'https://www.gnu.org/licenses/gpl-3.0.en.html',
      },
    },
    servers: [
      {
        url: 'https://api.juiceswap.com',
        description: 'Production API',
      },
      {
        url: 'https://dev.api.juiceswap.com',
        description: 'Development API',
      },
      {
        url: 'http://localhost:3000',
        description: 'Local Development',
      },
    ],
    tags: [
      { name: 'Quoting' },
      { name: 'Swaps' },
      { name: 'Liquidity' },
      { name: 'Utility' },
    ],
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            detail: { type: 'string' },
            errorCode: { type: 'string' },
          },
        },
        ChainId: {
          type: 'integer',
          enum: [1, 11155111, 5115],
        },
        Address: {
          type: 'string',
          pattern: '^0x[a-fA-F0-9]{40}$',
        },
        Amount: {
          type: 'string',
          pattern: '^\\d+$',
        },
      },
    },
  },
  apis: [
    './src/endpoints/*.ts',
    './src/swagger/schemas.ts',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
