import swaggerJsdoc from 'swagger-jsdoc';
import packageJson from '../../package.json';

// Detect if running from compiled code
const isCompiled = __dirname.includes('/dist/');
const baseDir = isCompiled ? './dist' : './src';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'JuiceSwap Routing API',
      version: packageJson.version,
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
    tags: [
      { name: 'Quoting' },
      { name: 'Swaps' },
      { name: 'Liquidity' },
      { name: 'Utility' },
      { name: 'Portfolio' },
      { name: 'Campaign' },
      { name: 'Launchpad' },
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
    `${baseDir}/endpoints/*.{ts,js}`,
    `${baseDir}/swagger/schemas.{ts,js}`,
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
